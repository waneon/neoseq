mod support;

use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use std::{sync::Arc, time::Duration};
use support::*;
use sync_protocol::{Hello, Message, PROTOCOL_VERSION, VersionRange, decode, encode};
use sync_server::{AppState, RoomConfig, TestIssuer, router};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};
use tower::ServiceExt;

#[tokio::test]
async fn authenticated_binary_websocket_syncs_and_acknowledges() {
    let fixture = fixture(RoomConfig::default());
    let issuer = Arc::new(TestIssuer::new(b"0123456789abcdef").unwrap());
    let token = issuer.issue(OWNER).unwrap();
    let state = AppState::new(
        fixture.manager.clone(),
        issuer,
        Arc::new(sync_server::Metrics::default()),
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
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    let hello = Message::Hello(Hello {
        protocol: VersionRange::exact(PROTOCOL_VERSION),
        schema: VersionRange::exact(graph_core::SCHEMA_VERSION as u16),
        graph_id: GRAPH.into(),
        session_id: "websocket-client".into(),
        version_vector: fixture.base_version.clone(),
        last_acknowledgement: None,
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
