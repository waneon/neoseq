use crate::{
    auth::TokenVerifier,
    metrics::Metrics,
    room::{RoomConnection, RoomError, RoomManager},
    store::{GraphAdmin, GraphRole, GraphStore, StoreError},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    response::IntoResponse,
    routing::{get, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use sync_protocol::{
    ErrorCode, ErrorMessage, Hello, Message, PROTOCOL_VERSION, VersionRange, decode, encode,
    validate_message,
};
use tokio::sync::watch;
use tokio::time::{interval, timeout};

pub struct AppState<S: GraphStore, V: TokenVerifier> {
    pub rooms: Arc<RoomManager<S>>,
    pub verifier: Arc<V>,
    pub metrics: Arc<Metrics>,
    connections: Arc<AtomicUsize>,
    max_connections: usize,
    membership_recheck: Duration,
    shutdown: watch::Sender<bool>,
}

impl<S: GraphStore, V: TokenVerifier> Clone for AppState<S, V> {
    fn clone(&self) -> Self {
        Self {
            rooms: self.rooms.clone(),
            verifier: self.verifier.clone(),
            metrics: self.metrics.clone(),
            connections: self.connections.clone(),
            max_connections: self.max_connections,
            membership_recheck: self.membership_recheck,
            shutdown: self.shutdown.clone(),
        }
    }
}

impl<S: GraphStore, V: TokenVerifier> AppState<S, V> {
    pub fn new(
        rooms: Arc<RoomManager<S>>,
        verifier: Arc<V>,
        metrics: Arc<Metrics>,
        max_connections: usize,
        membership_recheck: Duration,
    ) -> Self {
        Self {
            rooms,
            verifier,
            metrics,
            connections: Arc::new(AtomicUsize::new(0)),
            max_connections,
            membership_recheck,
            shutdown: watch::channel(false).0,
        }
    }

    pub fn shutdown_handle(&self) -> watch::Sender<bool> {
        self.shutdown.clone()
    }
}

pub fn router<S: GraphAdmin, V: TokenVerifier>(state: AppState<S, V>) -> Router {
    Router::new()
        .route("/livez", get(liveness))
        .route("/readyz", get(readiness::<S, V>))
        .route("/metrics", get(metrics::<S, V>))
        .route("/v1/sync", get(sync_upgrade::<S, V>))
        .route(
            "/v1/graphs",
            get(list_graphs::<S, V>).post(create_graph::<S, V>),
        )
        .route(
            "/v1/graphs/{graph_id}/members",
            get(list_memberships::<S, V>),
        )
        .route(
            "/v1/graphs/{graph_id}/members/{principal_id}",
            put(grant_membership::<S, V>).delete(revoke_membership::<S, V>),
        )
        .with_state(state)
}

#[derive(Serialize)]
struct GraphResponse {
    graph_id: String,
    role: &'static str,
    status: &'static str,
    membership_version: u64,
}

#[derive(Serialize)]
struct GraphsResponse {
    graphs: Vec<GraphResponse>,
}

#[derive(Deserialize)]
struct CreateGraphRequest {
    graph_id: String,
}

#[derive(Serialize)]
struct CreatedGraphResponse {
    graph_id: String,
}

#[derive(Serialize)]
struct MembershipResponse {
    principal_id: String,
    role: &'static str,
    version: u64,
}

#[derive(Serialize)]
struct MembershipsResponse {
    memberships: Vec<MembershipResponse>,
}

#[derive(Deserialize)]
struct GrantRequest {
    role: String,
}

async fn list_graphs<S: GraphAdmin, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
) -> Response<Body> {
    let principal = match api_principal(&state, &headers) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.rooms.store().list_graphs(&principal).await {
        Ok(graphs) => Json(GraphsResponse {
            graphs: graphs
                .into_iter()
                .map(|graph| GraphResponse {
                    graph_id: graph.graph_id,
                    role: role_name(graph.role),
                    status: match graph.status {
                        sync_protocol::GraphStatus::Active => "active",
                        sync_protocol::GraphStatus::ReadOnly => "read_only",
                    },
                    membership_version: graph.membership_version,
                })
                .collect(),
        })
        .into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn create_graph<S: GraphAdmin, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
    Json(request): Json<CreateGraphRequest>,
) -> Response<Body> {
    let principal = match api_principal(&state, &headers) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let graph_id = match domain::GraphId::new(&request.graph_id) {
        Ok(graph_id) => graph_id,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid graph id\n").into_response(),
    };
    let core = match graph_core::GraphCore::new(graph_id, u64::MAX - 2, "server:create") {
        Ok(core) => core,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid graph id\n").into_response(),
    };
    let snapshot = match core.export_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match state
        .rooms
        .store()
        .create_remote_graph(
            &request.graph_id,
            &principal,
            graph_core::SCHEMA_VERSION,
            64 * 1024 * 1024,
            &snapshot,
            &core.version_vector(),
        )
        .await
    {
        Ok(()) => (
            StatusCode::CREATED,
            Json(CreatedGraphResponse {
                graph_id: request.graph_id,
            }),
        )
            .into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn list_memberships<S: GraphAdmin, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
    Path(graph_id): Path<String>,
) -> Response<Body> {
    let principal = match require_owner(&state, &headers, &graph_id).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let _ = principal;
    match state.rooms.store().list_memberships(&graph_id).await {
        Ok(memberships) => Json(MembershipsResponse {
            memberships: memberships
                .into_iter()
                .map(|membership| MembershipResponse {
                    principal_id: membership.principal_id,
                    role: role_name(membership.role),
                    version: membership.version,
                })
                .collect(),
        })
        .into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn grant_membership<S: GraphAdmin, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
    Path((graph_id, principal_id)): Path<(String, String)>,
    Json(request): Json<GrantRequest>,
) -> Response<Body> {
    if let Err(response) = require_owner(&state, &headers, &graph_id).await {
        return *response;
    }
    let role = match request.role.as_str() {
        "editor" => GraphRole::Editor,
        "viewer" => GraphRole::Viewer,
        _ => return (StatusCode::BAD_REQUEST, "role must be editor or viewer\n").into_response(),
    };
    match state
        .rooms
        .store()
        .grant_membership(&graph_id, &principal_id, role)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn revoke_membership<S: GraphAdmin, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
    Path((graph_id, principal_id)): Path<(String, String)>,
) -> Response<Body> {
    let owner = match require_owner(&state, &headers, &graph_id).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    if owner == principal_id {
        return (
            StatusCode::BAD_REQUEST,
            "owner membership cannot be revoked\n",
        )
            .into_response();
    }
    match state
        .rooms
        .store()
        .revoke_membership(&graph_id, &principal_id)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_store_error(error),
    }
}

fn api_principal<S: GraphStore, V: TokenVerifier>(
    state: &AppState<S, V>,
    headers: &HeaderMap,
) -> Result<String, Box<Response<Body>>> {
    let token =
        bearer_token(headers).ok_or_else(|| Box::new(StatusCode::UNAUTHORIZED.into_response()))?;
    state
        .verifier
        .verify(token)
        .map(|principal| principal.id)
        .map_err(|_| Box::new(StatusCode::UNAUTHORIZED.into_response()))
}

async fn require_owner<S: GraphStore, V: TokenVerifier>(
    state: &AppState<S, V>,
    headers: &HeaderMap,
    graph_id: &str,
) -> Result<String, Box<Response<Body>>> {
    let principal = api_principal(state, headers)?;
    match state.rooms.store().authorize(graph_id, &principal).await {
        Ok(membership) if membership.role == GraphRole::Owner => Ok(principal),
        Ok(_) | Err(StoreError::AccessDenied) => {
            Err(Box::new(StatusCode::FORBIDDEN.into_response()))
        }
        Err(error) => Err(Box::new(api_store_error(error))),
    }
}

fn role_name(role: GraphRole) -> &'static str {
    match role {
        GraphRole::Owner => "owner",
        GraphRole::Editor => "editor",
        GraphRole::Viewer => "viewer",
    }
}

fn api_store_error(error: StoreError) -> Response<Body> {
    match error {
        StoreError::AccessDenied | StoreError::ReadOnly => StatusCode::FORBIDDEN.into_response(),
        StoreError::QuotaExceeded => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        StoreError::Database(message)
            if message.contains("duplicate key") || message.contains("already exists") =>
        {
            (StatusCode::CONFLICT, "graph already exists\n").into_response()
        }
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn liveness() -> &'static str {
    "ok\n"
}

async fn readiness<S: GraphStore, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
) -> impl IntoResponse {
    let request_id = state.metrics.next_request_id();
    match state.rooms.store().ready().await {
        Ok(()) => {
            tracing::info!(request_id, endpoint = "readyz", result = "ready");
            (StatusCode::OK, "ready\n")
        }
        Err(_) => {
            tracing::warn!(request_id, endpoint = "readyz", result = "not_ready");
            (StatusCode::SERVICE_UNAVAILABLE, "not ready\n")
        }
    }
}

async fn metrics<S: GraphStore, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
) -> Response<Body> {
    let mut response = Response::new(Body::from(state.metrics.render()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/openmetrics-text; version=1.0.0; charset=utf-8"),
    );
    response
}

async fn sync_upgrade<S: GraphStore, V: TokenVerifier>(
    State(state): State<AppState<S, V>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    let token = bearer_token(&headers)
        .map(str::to_owned)
        .or_else(|| websocket_token(&headers));
    let Some(token) = token else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    // Verify before upgrade, but never log or retain the credential.
    if state.verifier.verify(&token).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(permit) = ConnectionPermit::acquire(state.connections.clone(), state.max_connections)
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let max_frame = state.rooms.limits().max_frame_bytes as usize;
    upgrade
        .protocols(["neoseq.v2"])
        .max_message_size(max_frame)
        .max_frame_size(max_frame)
        .on_upgrade(move |socket| session(socket, state, token, permit))
        .into_response()
}

fn websocket_token(headers: &HeaderMap) -> Option<String> {
    let encoded = headers
        .get("sec-websocket-protocol")?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix("neoseq.auth."))
        .filter(|token| !token.is_empty())?;
    String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
}

struct ConnectionPermit {
    connections: Arc<AtomicUsize>,
}

impl ConnectionPermit {
    fn acquire(connections: Arc<AtomicUsize>, max: usize) -> Option<Self> {
        connections
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                (current < max).then_some(current + 1)
            })
            .ok()?;
        Some(Self { connections })
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn session<S: GraphStore, V: TokenVerifier>(
    mut socket: WebSocket,
    state: AppState<S, V>,
    token: String,
    _permit: ConnectionPermit,
) {
    let Some(principal) = state.verifier.verify(&token).ok() else {
        return;
    };
    let hello = match timeout(Duration::from_secs(10), receive_hello(&mut socket, &state)).await {
        Ok(Ok(hello)) => hello,
        Ok(Err(message)) => {
            let _ = send_message(&mut socket, &state, &message).await;
            return;
        }
        Err(_) => {
            let _ = send_error(
                &mut socket,
                &state,
                ErrorCode::InvalidMessage,
                false,
                "hello timeout",
            )
            .await;
            return;
        }
    };
    if hello
        .protocol
        .select(VersionRange::exact(PROTOCOL_VERSION))
        .is_none()
    {
        let _ = send_error(
            &mut socket,
            &state,
            ErrorCode::UnsupportedProtocol,
            false,
            "no compatible protocol version",
        )
        .await;
        return;
    }
    if hello
        .schema
        .select(VersionRange::exact(graph_core::SCHEMA_VERSION as u16))
        .is_none()
    {
        let _ = send_error(
            &mut socket,
            &state,
            ErrorCode::UnsupportedSchema,
            false,
            "no compatible graph schema",
        )
        .await;
        return;
    }

    let opened = match state
        .rooms
        .open_replica(
            &hello.graph_id,
            &hello.session_id,
            &principal.id,
            hello.replica_id,
            hello.history_epoch,
            &hello.version_vector,
        )
        .await
    {
        Ok(opened) => opened,
        Err(error) => {
            let message = room_error_message(&error);
            let _ = send_message(&mut socket, &state, &message).await;
            return;
        }
    };
    if send_message(&mut socket, &state, &Message::Welcome(opened.welcome))
        .await
        .is_err()
    {
        state.rooms.disconnect(&opened.connection).await;
        return;
    }

    run_session(socket, state, opened.connection).await;
}

async fn receive_hello<S: GraphStore, V: TokenVerifier>(
    socket: &mut WebSocket,
    state: &AppState<S, V>,
) -> Result<Hello, Message> {
    let frame = match socket.recv().await {
        Some(Ok(WsMessage::Binary(frame))) => frame,
        _ => {
            return Err(error_message(
                ErrorCode::InvalidMessage,
                false,
                "first message must be a binary hello",
            ));
        }
    };
    let message =
        decode(&frame, state.rooms.limits().max_frame_bytes as usize).map_err(|error| {
            state.metrics.frame_rejected();
            error_message(error.code, false, error.diagnostic)
        })?;
    validate_message(&message, state.rooms.limits()).map_err(|error| {
        state.metrics.frame_rejected();
        error_message(error.code, false, error.diagnostic)
    })?;
    match message {
        Message::Hello(hello) => Ok(hello),
        _ => Err(error_message(
            ErrorCode::InvalidMessage,
            false,
            "first message must be hello",
        )),
    }
}

async fn run_session<S: GraphStore, V: TokenVerifier>(
    socket: WebSocket,
    state: AppState<S, V>,
    mut connection: RoomConnection,
) {
    let mut outbound = connection.take_outbound();
    let (mut sink, mut stream) = socket.split();
    let mut membership_tick = interval(state.membership_recheck);
    let mut shutdown = state.shutdown.subscribe();
    membership_tick.tick().await;
    let mut presence_window = Instant::now();
    let mut presence_count = 0_u32;
    let mut update_window = Instant::now();
    let mut update_count = 0_u32;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            outgoing = outbound.recv() => {
                let Some(message) = outgoing else { break };
                let frame = match encode(&message, state.rooms.limits().max_frame_bytes as usize) {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                if sink.send(WsMessage::Binary(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = stream.next() => {
                let Some(Ok(incoming)) = incoming else { break };
                let WsMessage::Binary(frame) = incoming else {
                    if matches!(incoming, WsMessage::Close(_)) { break; }
                    continue;
                };
                let message = match decode(&frame, state.rooms.limits().max_frame_bytes as usize)
                    .and_then(|message| {
                        validate_message(&message, state.rooms.limits())?;
                        Ok(message)
                    }) {
                    Ok(message) => message,
                    Err(error) => {
                        state.metrics.frame_rejected();
                        let message = error_message(error.code, true, error.diagnostic);
                        if send_sink(&mut sink, &state, &message).await.is_err() { break; }
                        continue;
                    }
                };
                let result = match message {
                    Message::Update(update) => {
                        if update_window.elapsed() >= Duration::from_secs(1) {
                            update_window = Instant::now();
                            update_count = 0;
                        }
                        update_count += 1;
                        if update_count > 100 {
                            Err(RoomError::LimitReached)
                        } else {
                            state.rooms.submit_update(&connection, update).await
                        }
                    },
                    Message::Presence(presence) => {
                        if presence_window.elapsed() >= Duration::from_secs(1) {
                            presence_window = Instant::now();
                            presence_count = 0;
                        }
                        presence_count += 1;
                        if presence_count > 20 {
                            Err(RoomError::LimitReached)
                        } else {
                            state.rooms.relay_presence(&connection, presence).await
                        }
                    }
                    _ => Err(RoomError::InvalidSession),
                };
                if let Err(error) = result {
                    let message = room_error_message(&error);
                    if send_sink(&mut sink, &state, &message).await.is_err() { break; }
                    if matches!(
                        error,
                        RoomError::Store(StoreError::AccessDenied)
                            | RoomError::ReconnectRequired
                            | RoomError::StaleHistory
                            | RoomError::SlowConsumer
                    ) {
                        break;
                    }
                }
            }
            _ = membership_tick.tick() => {
                if let Err(error) = state.rooms.recheck(&connection).await {
                    let message = room_error_message(&error);
                    let _ = send_sink(&mut sink, &state, &message).await;
                    break;
                }
            }
        }
    }
    state.rooms.disconnect(&connection).await;
}

async fn send_message<S: GraphStore, V: TokenVerifier>(
    socket: &mut WebSocket,
    state: &AppState<S, V>,
    message: &Message,
) -> Result<(), ()> {
    let frame = encode(message, state.rooms.limits().max_frame_bytes as usize).map_err(|_| ())?;
    socket
        .send(WsMessage::Binary(frame.into()))
        .await
        .map_err(|_| ())
}

async fn send_sink<S, V, T>(
    sink: &mut T,
    state: &AppState<S, V>,
    message: &Message,
) -> Result<(), ()>
where
    S: GraphStore,
    V: TokenVerifier,
    T: futures_util::Sink<WsMessage> + Unpin,
{
    let frame = encode(message, state.rooms.limits().max_frame_bytes as usize).map_err(|_| ())?;
    sink.send(WsMessage::Binary(frame.into()))
        .await
        .map_err(|_| ())
}

async fn send_error<S: GraphStore, V: TokenVerifier>(
    socket: &mut WebSocket,
    state: &AppState<S, V>,
    code: ErrorCode,
    recoverable: bool,
    diagnostic: &str,
) -> Result<(), ()> {
    send_message(socket, state, &error_message(code, recoverable, diagnostic)).await
}

fn error_message(code: ErrorCode, recoverable: bool, diagnostic: &str) -> Message {
    Message::Error(ErrorMessage {
        code,
        recoverable,
        diagnostic: diagnostic.to_owned(),
    })
}

fn room_error_message(error: &RoomError) -> Message {
    let (code, recoverable, diagnostic) = match error {
        RoomError::Store(StoreError::AccessDenied) => {
            (ErrorCode::AccessDenied, false, "graph access denied")
        }
        RoomError::Store(StoreError::ReadOnly) => {
            (ErrorCode::AccessDenied, false, "graph is read-only")
        }
        RoomError::Store(StoreError::QuotaExceeded) => (
            ErrorCode::GraphLimitExceeded,
            false,
            "graph byte quota exceeded",
        ),
        RoomError::Store(StoreError::MessageConflict) => (
            ErrorCode::InvalidUpdate,
            false,
            "message id conflicts with durable update",
        ),
        RoomError::Store(StoreError::StaleHistory) | RoomError::StaleHistory => (
            ErrorCode::StaleHistory,
            true,
            "client history epoch is stale",
        ),
        RoomError::Store(_) => (
            ErrorCode::StorageUnavailable,
            true,
            "durable storage is unavailable",
        ),
        RoomError::InvalidGraph | RoomError::InvalidSession => {
            (ErrorCode::InvalidMessage, false, "invalid session metadata")
        }
        RoomError::InvalidVersionVector | RoomError::InvalidUpdate => (
            ErrorCode::InvalidUpdate,
            true,
            "invalid CRDT synchronization data",
        ),
        RoomError::UnsupportedSchema => (
            ErrorCode::UnsupportedSchema,
            false,
            "graph schema is unsupported",
        ),
        RoomError::LimitReached => (ErrorCode::RateLimited, true, "service limit reached"),
        RoomError::SlowConsumer => (ErrorCode::SlowConsumer, true, "session queue is full"),
        RoomError::ReconnectRequired => (
            ErrorCode::Internal,
            true,
            "reconnect from durable graph state",
        ),
    };
    error_message(code, recoverable, diagnostic)
}
