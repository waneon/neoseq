mod support;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use neoseq_server::{AppState, GraphStore, RoomConfig, router};
use std::{sync::Arc, time::Duration};
use support::*;
use sync_protocol::{Hello, Message, PROTOCOL_VERSION, SUBPROTOCOL, decode, encode};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};
use tower::ServiceExt;

#[tokio::test]
async fn authenticated_binary_websocket_syncs_and_acknowledges() {
    let fixture = fixture(RoomConfig::default());
    let identity = Arc::new(TestIdentity);
    let token = OWNER_TOKEN;
    let state = AppState::new(
        fixture.manager.clone(),
        identity,
        Arc::new(neoseq_server::Metrics::default()),
        32,
        Duration::from_millis(50),
    );
    let app = router(state);
    assert_eq!(probe(&app, "/livez").await.0, 200);
    assert_eq!(probe(&app, "/readyz").await.0, 200);
    fixture.store.set_available(false);
    assert_eq!(probe(&app, "/readyz").await.0, 503);
    fixture.store.set_available(true);
    let (status, metrics) = probe(&app, "/metrics").await;
    assert_eq!(status, 200);
    assert!(metrics.contains("neoseq_sync_active_sessions"));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("ws://{address}/v1/sync");

    assert!(connect_async(&url).await.is_err());
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!(
            "{SUBPROTOCOL}, neoseq.auth.{}",
            URL_SAFE_NO_PAD.encode(token)
        ))
        .unwrap(),
    );
    let (mut socket, response) = connect_async(request).await.unwrap();
    assert_eq!(
        response.headers().get("sec-websocket-protocol").unwrap(),
        SUBPROTOCOL
    );
    let hello = Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        schema: graph_core::SCHEMA_VERSION as u16,
        graph_id: GRAPH.into(),
        session_id: "websocket-client".into(),
        history_epoch: 0,
        version_vector: fixture.base_version.clone(),
    });
    socket
        .send(WsMessage::Binary(
            encode(&hello, fixture.manager.limits().max_frame_bytes as usize)
                .unwrap()
                .into(),
        ))
        .await
        .unwrap();
    let welcome = receive_wire(&mut socket).await;
    assert!(matches!(welcome, Message::Welcome(_)));

    let (_, update) = client_update(&fixture.snapshot, 2, "create-a", "message-a", "page-a", "A");
    socket
        .send(WsMessage::Binary(
            encode(
                &Message::Update(update),
                fixture.manager.limits().max_frame_bytes as usize,
            )
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    match receive_wire(&mut socket).await {
        Message::Ack(ack) => {
            assert_eq!(ack.message_id, "message-a");
            assert!(ack.server_cursor > 0);
        }
        other => panic!("expected durable ack, got {other:?}"),
    }
    assert_eq!(fixture.store.update_count(GRAPH), 1);
    socket.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn owner_manages_remote_graph_memberships_over_authenticated_http() {
    let fixture = fixture(RoomConfig::default());
    let identity = Arc::new(TestIdentity);
    let token = OWNER_TOKEN;
    let app = router(AppState::new(
        fixture.manager,
        identity,
        Arc::new(neoseq_server::Metrics::default()),
        32,
        Duration::from_millis(50),
    ));
    let preflight = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("OPTIONS")
                .uri("/v1/graphs")
                .header("origin", "https://notes.example")
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "authorization")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preflight.status(), 200);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "*"
    );
    let graph_id = "remote-api-graph";
    let response = authorized_request(
        &app,
        "POST",
        "/v1/graphs",
        token,
        &format!(r#"{{"graph_id":"{graph_id}","name":"Remote notes"}}"#),
    )
    .await;
    assert_eq!(response.0, 201, "{}", response.1);

    let graphs = authorized_request(&app, "GET", "/v1/graphs", token, "").await;
    assert_eq!(graphs.0, 200, "{}", graphs.1);
    assert!(graphs.1.contains("Remote notes"));
    assert!(graphs.1.contains("created_at"));
    assert!(graphs.1.contains("updated_at"));

    let members = authorized_request(
        &app,
        "GET",
        &format!("/v1/graphs/{graph_id}/members"),
        token,
        "",
    )
    .await;
    assert_eq!(members.0, 200);
    assert!(members.1.contains(OWNER_USERNAME));
    assert!(members.1.contains("owner"));

    let granted = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        token,
        r#"{"role":"editor"}"#,
    )
    .await;
    assert_eq!(granted.0, 204, "{}", granted.1);
    assert!(fixture.store.authorize(graph_id, INVITED).await.is_ok());

    let revoked = authorized_request(
        &app,
        "DELETE",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        token,
        "",
    )
    .await;
    assert_eq!(revoked.0, 204, "{}", revoked.1);
    assert!(fixture.store.authorize(graph_id, INVITED).await.is_err());
}

async fn probe(app: &axum::Router, path: &str) -> (u16, String) {
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(path)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

async fn authorized_request(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: &str,
) -> (u16, String) {
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

async fn receive_wire(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    let frame = socket.next().await.unwrap().unwrap();
    let WsMessage::Binary(bytes) = frame else {
        panic!("expected binary message")
    };
    decode(
        &bytes,
        sync_protocol::Limits::default().max_frame_bytes as usize,
    )
    .unwrap()
}
