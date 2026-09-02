mod support;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use domain::{Command, CommandEnvelope, CommandId, GraphId, OutlineOwner, PageId};
use futures_util::{SinkExt, StreamExt};
use graph_core::GraphCore;
use http_body_util::BodyExt;
use neoseq_server::{AppState, GraphAdmin, GraphRole, GraphStore, RoomConfig, StoreError, router};
use std::{sync::Arc, time::Duration};
use support::*;
use sync_protocol::{
    Hello, Limits, Message, PROTOCOL_VERSION, SUBPROTOCOL, WelcomePayload, decode, encode,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::HeaderValue},
};
use tower::ServiceExt;

#[tokio::test]
async fn authenticated_binary_websocket_syncs_and_acknowledges() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();
    let identity = Arc::new(TestIdentity);
    let token = OWNER_TOKEN;
    let state = AppState::new(
        fixture.store.clone(),
        identity,
        Arc::new(neoseq_server::Metrics::default()),
        RoomConfig::default(),
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
        graph_id: graph_id.clone(),
        session_id: "websocket-client".into(),
        history_epoch: 0,
        has_server_base: true,
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
    assert_eq!(fixture.store.update_count(&graph_id), 1);
    socket.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn membership_mutation_requires_the_current_owner_at_the_store_boundary() {
    let fixture = fixture(RoomConfig::default());
    let graph_id = GraphId::new(GRAPH).unwrap();

    assert!(matches!(
        fixture
            .store
            .grant_membership(&graph_id, PEER, INVITED, GraphRole::Viewer)
            .await,
        Err(StoreError::AccessDenied)
    ));
    assert!(matches!(
        fixture
            .store
            .grant_membership(&graph_id, OWNER, INVITED, GraphRole::Owner)
            .await,
        Err(StoreError::InvalidMembershipRole)
    ));
    assert!(matches!(
        fixture
            .store
            .revoke_membership(&graph_id, OWNER, OWNER)
            .await,
        Err(StoreError::InvalidMembershipRole)
    ));
    assert!(fixture.store.authorize(&graph_id, OWNER).await.is_ok());

    // Simulate the old check/use seam: authority existed, then was revoked
    // before the mutation reached storage. The mutation must recheck it.
    fixture.store.revoke(&graph_id, OWNER);
    assert!(matches!(
        fixture
            .store
            .grant_membership(&graph_id, OWNER, INVITED, GraphRole::Editor)
            .await,
        Err(StoreError::AccessDenied)
    ));
    assert!(matches!(
        fixture
            .store
            .revoke_membership(&graph_id, OWNER, PEER)
            .await,
        Err(StoreError::AccessDenied)
    ));
    assert!(matches!(
        fixture.store.authorize(&graph_id, INVITED).await,
        Err(StoreError::AccessDenied)
    ));
    assert!(fixture.store.authorize(&graph_id, PEER).await.is_ok());
}

#[tokio::test]
async fn owner_manages_remote_graph_memberships_over_authenticated_http() {
    let fixture = fixture(RoomConfig::default());
    let identity = Arc::new(TestIdentity);
    let token = OWNER_TOKEN;
    let app = router(AppState::new(
        fixture.store.clone(),
        identity,
        Arc::new(neoseq_server::Metrics::default()),
        RoomConfig::default(),
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
    let invalid_graph_id = "x".repeat(161);
    let invalid_create = authorized_request(
        &app,
        "POST",
        "/v1/graphs",
        token,
        &format!(r#"{{"graph_id":"{invalid_graph_id}","name":"Invalid"}}"#),
    )
    .await;
    assert_eq!(invalid_create, (400, "invalid graph id\n".to_owned()));

    let graph_id = "remote-api-graph";
    let graph = GraphId::new(graph_id).unwrap();
    let response = authorized_request(
        &app,
        "POST",
        "/v1/graphs",
        token,
        &format!(r#"{{"graph_id":"{graph_id}","name":"Remote notes"}}"#),
    )
    .await;
    assert_eq!(response.0, 201, "{}", response.1);
    assert!(response.1.contains(r#""graph_id":"remote-api-graph""#));

    let graphs = authorized_request(&app, "GET", "/v1/graphs", token, "").await;
    assert_eq!(graphs.0, 200, "{}", graphs.1);
    assert!(graphs.1.contains("Remote notes"));
    assert!(graphs.1.contains(r#""graph_id":"remote-api-graph""#));
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

    let unauthorized = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        PEER_TOKEN,
        r#"{"role":"editor"}"#,
    )
    .await;
    let unknown_target = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{graph_id}/members/unknown-account"),
        PEER_TOKEN,
        r#"{"role":"editor"}"#,
    )
    .await;
    let unknown_graph = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/unknown-graph/members/{INVITED_USERNAME}"),
        token,
        r#"{"role":"editor"}"#,
    )
    .await;
    let invalid_graph = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{invalid_graph_id}/members/{INVITED_USERNAME}"),
        token,
        r#"{"role":"editor"}"#,
    )
    .await;
    assert_eq!(unauthorized, unknown_target);
    assert_eq!(unauthorized, unknown_graph);
    assert_eq!(invalid_graph, unknown_graph);
    assert_eq!(unauthorized.0, 403);
    assert!(fixture.store.authorize(&graph, INVITED).await.is_err());

    let immutable_owner = authorized_request(
        &app,
        "DELETE",
        &format!("/v1/graphs/{graph_id}/members/{OWNER_USERNAME}"),
        token,
        "",
    )
    .await;
    assert_eq!(immutable_owner.0, 400);
    assert_eq!(immutable_owner.1, "owner membership cannot be revoked\n");
    assert!(fixture.store.authorize(&graph, OWNER).await.is_ok());

    let owner_role = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        token,
        r#"{"role":"owner"}"#,
    )
    .await;
    assert_eq!(owner_role.0, 400);
    assert_eq!(owner_role.1, "role must be editor or viewer\n");

    let granted = authorized_request(
        &app,
        "PUT",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        token,
        r#"{"role":"editor"}"#,
    )
    .await;
    assert_eq!(granted.0, 204, "{}", granted.1);
    assert!(fixture.store.authorize(&graph, INVITED).await.is_ok());

    let revoked = authorized_request(
        &app,
        "DELETE",
        &format!("/v1/graphs/{graph_id}/members/{INVITED_USERNAME}"),
        token,
        "",
    )
    .await;
    assert_eq!(revoked.0, 204, "{}", revoked.1);
    assert!(fixture.store.authorize(&graph, INVITED).await.is_err());
}

#[tokio::test]
async fn seeded_graph_creation_atomically_installs_a_validated_checkpoint_and_is_idempotent() {
    let fixture = fixture(RoomConfig::default());
    let app = router(AppState::new(
        fixture.store.clone(),
        Arc::new(TestIdentity),
        Arc::new(neoseq_server::Metrics::default()),
        RoomConfig::default(),
        32,
        Duration::from_millis(50),
    ));
    let graph_id = "seeded-remote-graph";
    let graph = GraphId::new(graph_id).unwrap();
    let mut core = GraphCore::new(graph.clone(), 77, "seed").unwrap();
    let mut random_state = 0x9e37_79b9_u32;
    let mut random_markdown = || {
        (0..600 * 1024)
            .map(|_| {
                random_state ^= random_state << 13;
                random_state ^= random_state >> 17;
                random_state ^= random_state << 5;
                char::from(b' ' + (random_state % 95) as u8)
            })
            .collect::<String>()
    };
    let large_markdown_a = random_markdown();
    let large_markdown_b = random_markdown();
    core.execute(
        CommandEnvelope {
            graph_id: graph.clone(),
            command_id: CommandId::new("seed-page").unwrap(),
            command: Command::EnsurePage {
                page_id: PageId::new("imported-page").unwrap(),
                title: "Imported page".to_owned(),
            },
        },
        "seed",
    )
    .unwrap();
    core.execute(
        CommandEnvelope {
            graph_id: GraphId::new(graph_id).unwrap(),
            command_id: CommandId::new("seed-large-block").unwrap(),
            command: Command::InsertBlock {
                owner: OutlineOwner::Page {
                    id: PageId::new("imported-page").unwrap(),
                },
                parent: None,
                index: 0,
                markdown: large_markdown_a,
            },
        },
        "seed",
    )
    .unwrap();
    core.execute(
        CommandEnvelope {
            graph_id: GraphId::new(graph_id).unwrap(),
            command_id: CommandId::new("seed-large-block-b").unwrap(),
            command: Command::InsertBlock {
                owner: OutlineOwner::Page {
                    id: PageId::new("imported-page").unwrap(),
                },
                parent: None,
                index: 1,
                markdown: large_markdown_b,
            },
        },
        "seed",
    )
    .unwrap();
    let checkpoint = core.export_gc_checkpoint().unwrap();
    assert!(checkpoint.len() > Limits::default().max_frame_bytes as usize);
    assert!(checkpoint.len() < Limits::default().max_decompressed_bytes as usize);

    let created = authorized_multipart_request(
        &app,
        "/v1/graphs/import",
        OWNER_TOKEN,
        graph_id,
        "Imported graph",
        &checkpoint,
    )
    .await;
    assert_eq!(created.0, 201, "{}", created.1);
    assert!(created.1.contains(&graph_core::checksum(&checkpoint)));

    let loaded = fixture.store.load_graph(&graph).await.unwrap();
    assert_eq!(loaded.checkpoint.snapshot, checkpoint);
    let restored = GraphCore::from_snapshot(
        GraphId::new(graph_id).unwrap(),
        78,
        &loaded.checkpoint.snapshot,
    )
    .unwrap();
    assert!(
        restored
            .summary()
            .unwrap()
            .pages
            .iter()
            .any(|page| page.title == "Imported page")
    );

    let retried = authorized_multipart_request(
        &app,
        "/v1/graphs/import",
        OWNER_TOKEN,
        graph_id,
        "Imported graph",
        &loaded.checkpoint.snapshot,
    )
    .await;
    assert_eq!(retried.0, 200, "{}", retried.1);

    let conflict = authorized_multipart_request(
        &app,
        "/v1/graphs/import",
        OWNER_TOKEN,
        graph_id,
        "Different graph",
        &loaded.checkpoint.snapshot,
    )
    .await;
    assert_eq!(conflict.0, 409, "{}", conflict.1);
    assert_eq!(conflict.1, "graph already exists\n");

    let invalid = authorized_multipart_request(
        &app,
        "/v1/graphs/import",
        OWNER_TOKEN,
        "invalid-seeded-graph",
        "Invalid graph",
        b"not a loro checkpoint",
    )
    .await;
    assert_eq!(invalid.0, 400, "{}", invalid.1);

    let downloaded = authorized_binary_request(
        &app,
        &format!("/v1/graphs/{graph_id}/checkpoint"),
        OWNER_TOKEN,
    )
    .await;
    assert_eq!(downloaded.0, 200);
    assert_eq!(downloaded.2, checkpoint);
    assert_eq!(
        downloaded.1["x-neoseq-checkpoint-checksum"]
            .to_str()
            .unwrap(),
        graph_core::checksum(&downloaded.2)
    );
    assert_eq!(
        downloaded.1["x-neoseq-history-epoch"].to_str().unwrap(),
        "0"
    );
    let invalid_graph_id = "x".repeat(161);
    let invalid_download = authorized_binary_request(
        &app,
        &format!("/v1/graphs/{invalid_graph_id}/checkpoint"),
        OWNER_TOKEN,
    )
    .await;
    assert_eq!(invalid_download.0, 403);
    assert!(invalid_download.2.is_empty());

    // A second browser has no local provenance for this graph. Its Hello must
    // receive the exact server-owned Base rather than an incremental delta.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("ws://{address}/v1/sync");
    let mut websocket_request = url.into_client_request().unwrap();
    websocket_request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!(
            "{SUBPROTOCOL}, neoseq.auth.{}",
            URL_SAFE_NO_PAD.encode(OWNER_TOKEN)
        ))
        .unwrap(),
    );
    let (mut socket, _) = connect_async(websocket_request).await.unwrap();
    let hello = Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        schema: graph_core::SCHEMA_VERSION as u16,
        graph_id: GraphId::new(graph_id).unwrap(),
        session_id: "fresh-import-reader".to_owned(),
        history_epoch: 0,
        has_server_base: false,
        version_vector: Vec::new(),
    });
    socket
        .send(WsMessage::Binary(
            encode(&hello, Limits::default().max_frame_bytes as usize)
                .unwrap()
                .into(),
        ))
        .await
        .unwrap();
    let welcome = match receive_wire(&mut socket).await {
        Message::Welcome(welcome) => welcome,
        other => panic!("expected Welcome, got {other:?}"),
    };
    assert_eq!(welcome.payload, WelcomePayload::ReplaceDownload {});
    let fresh =
        GraphCore::from_snapshot(GraphId::new(graph_id).unwrap(), 79, &downloaded.2).unwrap();
    assert!(
        fresh
            .summary()
            .unwrap()
            .pages
            .iter()
            .any(|page| page.title == "Imported page")
    );
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

async fn authorized_multipart_request(
    app: &axum::Router,
    path: &str,
    token: &str,
    graph_id: &str,
    name: &str,
    checkpoint: &[u8],
) -> (u16, String) {
    let boundary = "neoseq-seeded-graph-boundary";
    let mut body = Vec::new();
    let checkpoint_checksum = graph_core::checksum(checkpoint);
    for (field, value) in [
        ("graph_id", graph_id),
        ("name", name),
        ("checkpoint_checksum", checkpoint_checksum.as_str()),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"checkpoint\"; filename=\"graph.loro\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(checkpoint);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

async fn authorized_binary_request(
    app: &axum::Router,
    path: &str,
    token: &str,
) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body.to_vec())
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
