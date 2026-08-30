use crate::{
    auth::{
        AccountPatch, AccountStatus, AccountView, AuthError, IdentityService, Principal,
        ServerRole, SessionPurpose,
    },
    metrics::Metrics,
    room::{RoomConnection, RoomError, RoomManager},
    store::{
        CreateGraphOutcome, GraphAdmin, GraphRole, GraphStatus, GraphStore, NewGraph, StoreError,
    },
};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Multipart, Path, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, Response, StatusCode, header},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
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
    ErrorCode, ErrorMessage, Hello, Message, PROTOCOL_VERSION, SUBPROTOCOL, decode, encode,
    validate_message,
};
use tokio::sync::watch;
use tokio::time::{interval, timeout};
use tower_http::cors::{Any, CorsLayer};

const GRAPH_BYTE_QUOTA: u64 = 64 * 1024 * 1024;
const MAX_SEEDED_GRAPH_BODY: usize = GRAPH_BYTE_QUOTA as usize + 64 * 1024;
const SERVER_GRAPH_PEER_ID: u64 = u64::MAX - 2;

pub struct AppState<S: GraphStore> {
    pub rooms: Arc<RoomManager<S>>,
    identity: Arc<dyn IdentityService>,
    pub metrics: Arc<Metrics>,
    connections: Arc<AtomicUsize>,
    max_connections: usize,
    membership_recheck: Duration,
    shutdown: watch::Sender<bool>,
}

impl<S: GraphStore> Clone for AppState<S> {
    fn clone(&self) -> Self {
        Self {
            rooms: self.rooms.clone(),
            identity: self.identity.clone(),
            metrics: self.metrics.clone(),
            connections: self.connections.clone(),
            max_connections: self.max_connections,
            membership_recheck: self.membership_recheck,
            shutdown: self.shutdown.clone(),
        }
    }
}

impl<S: GraphStore> AppState<S> {
    pub fn new(
        rooms: Arc<RoomManager<S>>,
        identity: Arc<dyn IdentityService>,
        metrics: Arc<Metrics>,
        max_connections: usize,
        membership_recheck: Duration,
    ) -> Self {
        Self {
            rooms,
            identity,
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

pub fn router<S: GraphAdmin>(state: AppState<S>) -> Router {
    Router::new()
        .route("/livez", get(liveness))
        .route("/readyz", get(readiness::<S>))
        .route("/metrics", get(metrics::<S>))
        .route("/v1/auth/login", post(login::<S>))
        .route("/v1/auth/logout", post(logout::<S>))
        .route("/v1/auth/me", get(current_account::<S>))
        .route("/v1/auth/password", put(change_password::<S>))
        .route(
            "/v1/admin/accounts",
            get(list_accounts::<S>).post(create_account::<S>),
        )
        .route(
            "/v1/admin/accounts/{account_id}",
            patch(update_account::<S>),
        )
        .route(
            "/v1/admin/accounts/{account_id}/password",
            put(reset_account_password::<S>),
        )
        .route(
            "/v1/admin/accounts/{account_id}/sessions",
            delete(revoke_account_sessions::<S>),
        )
        .route("/v1/sync", get(sync_upgrade::<S>))
        .route("/v1/graphs", get(list_graphs::<S>).post(create_graph::<S>))
        .route(
            "/v1/graphs/import",
            post(create_seeded_graph::<S>).layer(DefaultBodyLimit::max(MAX_SEEDED_GRAPH_BODY)),
        )
        .route("/v1/graphs/{graph_id}/members", get(list_memberships::<S>))
        .route(
            "/v1/graphs/{graph_id}/members/{username}",
            put(grant_membership::<S>).delete(revoke_membership::<S>),
        )
        // The client can deliberately connect to repositories on other HTTPS
        // origins. API authentication is bearer-only (never ambient cookies),
        // so allowing browser origins does not confer account authority.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .with_state(state)
}

#[derive(Serialize)]
struct GraphResponse {
    graph_id: String,
    display_name: String,
    created_at: String,
    updated_at: String,
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
    #[serde(default = "default_graph_name")]
    name: String,
}

fn default_graph_name() -> String {
    "Untitled".to_owned()
}

#[derive(Serialize)]
struct CreatedGraphResponse {
    graph_id: String,
    history_epoch: u64,
    checkpoint_checksum: String,
}

struct SeededGraphRequest {
    graph_id: String,
    name: String,
    checkpoint_checksum: String,
    checkpoint: Vec<u8>,
}

#[derive(Serialize)]
struct MembershipResponse {
    account_id: String,
    username: String,
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

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    #[serde(default = "client_purpose")]
    purpose: String,
    #[serde(default)]
    persistent: bool,
}

fn client_purpose() -> String {
    "client".into()
}

#[derive(Serialize)]
struct LoginResponse {
    access_token: String,
    expires_at: i64,
    account: AccountView,
}

#[derive(Serialize)]
struct CurrentAccountResponse {
    account_id: String,
    username: String,
    server_role: &'static str,
    purpose: &'static str,
}

#[derive(Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
struct AccountsResponse {
    accounts: Vec<AccountView>,
}

#[derive(Deserialize)]
struct CreateAccountRequest {
    username: String,
    password: String,
    #[serde(default = "user_role")]
    server_role: String,
}

fn user_role() -> String {
    "user".into()
}

#[derive(Deserialize)]
struct UpdateAccountRequest {
    status: Option<String>,
    server_role: Option<String>,
}

#[derive(Deserialize)]
struct ResetPasswordRequest {
    password: String,
}

async fn login<S: GraphStore>(
    State(state): State<AppState<S>>,
    Json(request): Json<LoginRequest>,
) -> Response<Body> {
    let purpose = match request.purpose.as_str() {
        "client" => SessionPurpose::Client,
        "admin" => SessionPurpose::Admin,
        _ => return (StatusCode::BAD_REQUEST, "invalid session purpose\n").into_response(),
    };
    match state
        .identity
        .login(
            &request.username,
            &request.password,
            purpose,
            purpose == SessionPurpose::Client && request.persistent,
        )
        .await
    {
        Ok(session) => Json(LoginResponse {
            access_token: session.access_token,
            expires_at: session.expires_at,
            account: session.account,
        })
        .into_response(),
        Err(AuthError::Invalid | AuthError::Forbidden) => {
            (StatusCode::UNAUTHORIZED, "invalid username or password\n").into_response()
        }
        Err(error) => auth_error_response(error),
    }
}

async fn logout<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match state.identity.logout(token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn current_account<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
) -> Response<Body> {
    match authenticated_principal(&state, &headers, None).await {
        Ok(principal) => Json(CurrentAccountResponse {
            account_id: principal.id,
            username: principal.username,
            server_role: if principal.is_admin { "admin" } else { "user" },
            purpose: principal.purpose.as_str(),
        })
        .into_response(),
        Err(response) => *response,
    }
}

async fn change_password<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Response<Body> {
    let principal = match authenticated_principal(&state, &headers, None).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state
        .identity
        .change_password(&principal, &request.current_password, &request.new_password)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn list_accounts<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
) -> Response<Body> {
    let actor = match admin_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.identity.list_accounts(&actor).await {
        Ok(accounts) => Json(AccountsResponse { accounts }).into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn create_account<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Json(request): Json<CreateAccountRequest>,
) -> Response<Body> {
    let actor = match admin_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let role = match parse_server_role(&request.server_role) {
        Ok(role) => role,
        Err(error) => return auth_error_response(error),
    };
    match state
        .identity
        .create_account(&actor, &request.username, &request.password, role)
        .await
    {
        Ok(account) => (StatusCode::CREATED, Json(account)).into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn update_account<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Json(request): Json<UpdateAccountRequest>,
) -> Response<Body> {
    let actor = match admin_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let status = match request.status.as_deref() {
        None => None,
        Some("active") => Some(AccountStatus::Active),
        Some("disabled") => Some(AccountStatus::Disabled),
        Some(_) => return (StatusCode::BAD_REQUEST, "invalid account status\n").into_response(),
    };
    let server_role = match request.server_role.as_deref() {
        None => None,
        Some(role) => match parse_server_role(role) {
            Ok(role) => Some(role),
            Err(error) => return auth_error_response(error),
        },
    };
    match state
        .identity
        .update_account(
            &actor,
            &account_id,
            AccountPatch {
                status,
                server_role,
            },
        )
        .await
    {
        Ok(account) => Json(account).into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn reset_account_password<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Json(request): Json<ResetPasswordRequest>,
) -> Response<Body> {
    let actor = match admin_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state
        .identity
        .reset_password(&actor, &account_id, &request.password)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn revoke_account_sessions<S: GraphStore>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Response<Body> {
    let actor = match admin_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.identity.revoke_sessions(&actor, &account_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn list_graphs<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
) -> Response<Body> {
    let principal = match api_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.rooms.store().list_graphs(&principal).await {
        Ok(graphs) => Json(GraphsResponse {
            graphs: graphs
                .into_iter()
                .map(|graph| GraphResponse {
                    graph_id: graph.graph_id,
                    display_name: graph.display_name,
                    created_at: graph.created_at,
                    updated_at: graph.updated_at,
                    role: role_name(graph.role),
                    status: match graph.status {
                        GraphStatus::Active => "active",
                        GraphStatus::ReadOnly => "read_only",
                    },
                    membership_version: graph.membership_version,
                })
                .collect(),
        })
        .into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn create_graph<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Json(request): Json<CreateGraphRequest>,
) -> Response<Body> {
    let principal = match api_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let graph_id = match domain::GraphId::new(&request.graph_id) {
        Ok(graph_id) => graph_id,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid graph id\n").into_response(),
    };
    let display_name = request.name.trim();
    if !valid_graph_name(display_name) {
        return (StatusCode::BAD_REQUEST, "invalid graph name\n").into_response();
    }
    let core = match graph_core::GraphCore::new(graph_id, SERVER_GRAPH_PEER_ID, "server:create") {
        Ok(core) => core,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid graph id\n").into_response(),
    };
    let snapshot = match core.export_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let version_vector = core.version_vector();
    let checkpoint_checksum = graph_core::checksum(&snapshot);
    let result = state
        .rooms
        .store()
        .create_graph(NewGraph {
            graph_id: &request.graph_id,
            display_name,
            owner_account_id: &principal,
            schema_version: graph_core::SCHEMA_VERSION,
            byte_quota: GRAPH_BYTE_QUOTA,
            snapshot: &snapshot,
            version_vector: &version_vector,
        })
        .await;
    match result {
        Ok(outcome) => created_graph_response(outcome, request.graph_id, checkpoint_checksum),
        Err(error) => api_store_error(error),
    }
}

async fn create_seeded_graph<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response<Body> {
    let principal = match api_principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = match read_seeded_graph_request(multipart).await {
        Ok(request) => request,
        Err(response) => return response,
    };
    let graph_id = match domain::GraphId::new(&request.graph_id) {
        Ok(graph_id) => graph_id,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid graph id\n").into_response(),
    };
    let display_name = request.name.trim();
    if !valid_graph_name(display_name) {
        return (StatusCode::BAD_REQUEST, "invalid graph name\n").into_response();
    }
    if request.checkpoint.len() > state.rooms.limits().max_decompressed_bytes as usize {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "graph checkpoint is too large\n",
        )
            .into_response();
    }
    let checkpoint = request.checkpoint;
    let checkpoint_checksum = graph_core::checksum(&checkpoint);
    if checkpoint_checksum != request.checkpoint_checksum {
        return (
            StatusCode::BAD_REQUEST,
            "graph checkpoint checksum mismatch\n",
        )
            .into_response();
    }
    let validated = tokio::task::spawn_blocking(move || {
        graph_core::GraphCore::from_snapshot(graph_id, SERVER_GRAPH_PEER_ID, &checkpoint)
            .map(|core| (checkpoint, core.version_vector()))
    })
    .await;
    let (checkpoint, version_vector) = match validated {
        Ok(Ok(validated)) => validated,
        Ok(Err(_)) => {
            return (StatusCode::BAD_REQUEST, "invalid graph checkpoint\n").into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = state
        .rooms
        .store()
        .create_graph(NewGraph {
            graph_id: &request.graph_id,
            display_name,
            owner_account_id: &principal,
            schema_version: graph_core::SCHEMA_VERSION,
            byte_quota: GRAPH_BYTE_QUOTA,
            snapshot: &checkpoint,
            version_vector: &version_vector,
        })
        .await;
    match result {
        Ok(outcome) => created_graph_response(outcome, request.graph_id, checkpoint_checksum),
        Err(error) => api_store_error(error),
    }
}

async fn read_seeded_graph_request(
    mut multipart: Multipart,
) -> Result<SeededGraphRequest, Response<Body>> {
    let mut graph_id = None;
    let mut name = None;
    let mut checkpoint_checksum = None;
    let mut checkpoint = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response())?
    {
        match field.name() {
            Some("graph_id") if graph_id.is_none() => {
                graph_id = Some(field.text().await.map_err(|_| {
                    (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response()
                })?);
            }
            Some("name") if name.is_none() => {
                name = Some(field.text().await.map_err(|_| {
                    (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response()
                })?);
            }
            Some("checkpoint_checksum") if checkpoint_checksum.is_none() => {
                checkpoint_checksum = Some(field.text().await.map_err(|_| {
                    (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response()
                })?);
            }
            Some("checkpoint") if checkpoint.is_none() => {
                checkpoint = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| {
                            (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response()
                        })?
                        .to_vec(),
                );
            }
            _ => {
                return Err(
                    (StatusCode::BAD_REQUEST, "invalid graph import body\n").into_response()
                );
            }
        }
    }
    match (graph_id, name, checkpoint_checksum, checkpoint) {
        (Some(graph_id), Some(name), Some(checkpoint_checksum), Some(checkpoint))
            if !checkpoint.is_empty() =>
        {
            Ok(SeededGraphRequest {
                graph_id,
                name,
                checkpoint_checksum,
                checkpoint,
            })
        }
        _ => Err((StatusCode::BAD_REQUEST, "incomplete graph import body\n").into_response()),
    }
}

fn created_graph_response(
    outcome: CreateGraphOutcome,
    graph_id: String,
    checkpoint_checksum: String,
) -> Response<Body> {
    (
        match outcome {
            CreateGraphOutcome::Created => StatusCode::CREATED,
            CreateGraphOutcome::Existing => StatusCode::OK,
        },
        Json(CreatedGraphResponse {
            graph_id,
            history_epoch: 0,
            checkpoint_checksum,
        }),
    )
        .into_response()
}

fn valid_graph_name(display_name: &str) -> bool {
    !display_name.is_empty()
        && display_name.chars().count() <= 160
        && !display_name.chars().any(char::is_control)
}

async fn list_memberships<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path(graph_id): Path<String>,
) -> Response<Body> {
    if let Err(response) = require_owner(&state, &headers, &graph_id).await {
        return *response;
    }
    match state.rooms.store().list_memberships(&graph_id).await {
        Ok(memberships) => {
            let mut response = Vec::with_capacity(memberships.len());
            for membership in memberships {
                let username = match state.identity.username_for(&membership.account_id).await {
                    Ok(Some(username)) => username,
                    Ok(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    Err(error) => return auth_error_response(error),
                };
                response.push(MembershipResponse {
                    account_id: membership.account_id,
                    username,
                    role: role_name(membership.role),
                    version: membership.version,
                });
            }
            Json(MembershipsResponse {
                memberships: response,
            })
            .into_response()
        }
        Err(error) => api_store_error(error),
    }
}

async fn grant_membership<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path((graph_id, username)): Path<(String, String)>,
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
    let account_id = match membership_account(&state, &username).await {
        Ok(account_id) => account_id,
        Err(response) => return response,
    };
    match state
        .rooms
        .store()
        .grant_membership(&graph_id, &account_id, role)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn revoke_membership<S: GraphAdmin>(
    State(state): State<AppState<S>>,
    headers: HeaderMap,
    Path((graph_id, username)): Path<(String, String)>,
) -> Response<Body> {
    let owner = match require_owner(&state, &headers, &graph_id).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    let account_id = match membership_account(&state, &username).await {
        Ok(account_id) => account_id,
        Err(response) => return response,
    };
    if owner == account_id {
        return (
            StatusCode::BAD_REQUEST,
            "owner membership cannot be revoked\n",
        )
            .into_response();
    }
    match state
        .rooms
        .store()
        .revoke_membership(&graph_id, &account_id)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_store_error(error),
    }
}

async fn api_principal<S: GraphStore>(
    state: &AppState<S>,
    headers: &HeaderMap,
) -> Result<String, Box<Response<Body>>> {
    authenticated_principal(state, headers, Some(SessionPurpose::Client))
        .await
        .map(|principal| principal.id)
}

async fn require_owner<S: GraphStore>(
    state: &AppState<S>,
    headers: &HeaderMap,
    graph_id: &str,
) -> Result<String, Box<Response<Body>>> {
    let principal = api_principal(state, headers).await?;
    match state.rooms.store().authorize(graph_id, &principal).await {
        Ok(membership) if membership.role == GraphRole::Owner => Ok(principal),
        Ok(_) | Err(StoreError::AccessDenied) => {
            Err(Box::new(StatusCode::FORBIDDEN.into_response()))
        }
        Err(error) => Err(Box::new(api_store_error(error))),
    }
}

async fn authenticated_principal<S: GraphStore>(
    state: &AppState<S>,
    headers: &HeaderMap,
    expected_purpose: Option<SessionPurpose>,
) -> Result<Principal, Box<Response<Body>>> {
    let token =
        bearer_token(headers).ok_or_else(|| Box::new(StatusCode::UNAUTHORIZED.into_response()))?;
    let principal = state
        .identity
        .verify(token)
        .await
        .map_err(|_| Box::new(StatusCode::UNAUTHORIZED.into_response()))?;
    if expected_purpose.is_some_and(|purpose| purpose != principal.purpose) {
        return Err(Box::new(StatusCode::FORBIDDEN.into_response()));
    }
    Ok(principal)
}

async fn admin_principal<S: GraphStore>(
    state: &AppState<S>,
    headers: &HeaderMap,
) -> Result<Principal, Box<Response<Body>>> {
    let principal = authenticated_principal(state, headers, Some(SessionPurpose::Admin)).await?;
    if principal.is_admin {
        Ok(principal)
    } else {
        Err(Box::new(StatusCode::FORBIDDEN.into_response()))
    }
}

async fn membership_account<S: GraphStore>(
    state: &AppState<S>,
    username: &str,
) -> Result<String, Response<Body>> {
    state
        .identity
        .resolve_username(username)
        .await
        .map_err(auth_error_response)
}

fn parse_server_role(value: &str) -> Result<ServerRole, AuthError> {
    match value {
        "user" => Ok(ServerRole::User),
        "admin" => Ok(ServerRole::Admin),
        _ => Err(AuthError::InvalidInput("invalid server role")),
    }
}

fn auth_error_response(error: AuthError) -> Response<Body> {
    match error {
        AuthError::Invalid => StatusCode::UNAUTHORIZED.into_response(),
        AuthError::Forbidden => StatusCode::FORBIDDEN.into_response(),
        AuthError::Conflict => (StatusCode::CONFLICT, "account already exists\n").into_response(),
        AuthError::InvalidInput(message) => (StatusCode::BAD_REQUEST, message).into_response(),
        AuthError::LastAdmin => (
            StatusCode::CONFLICT,
            "the last active administrator cannot be changed\n",
        )
            .into_response(),
        AuthError::Unavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
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
        StoreError::GraphAlreadyExists => {
            (StatusCode::CONFLICT, "graph already exists\n").into_response()
        }
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

async fn readiness<S: GraphStore>(State(state): State<AppState<S>>) -> impl IntoResponse {
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

async fn metrics<S: GraphStore>(State(state): State<AppState<S>>) -> Response<Body> {
    let mut response = Response::new(Body::from(state.metrics.render()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/openmetrics-text; version=1.0.0; charset=utf-8"),
    );
    response
}

async fn sync_upgrade<S: GraphStore>(
    State(state): State<AppState<S>>,
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
    let Ok(principal) = state.identity.verify(&token).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if principal.purpose != SessionPurpose::Client {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(permit) = ConnectionPermit::acquire(state.connections.clone(), state.max_connections)
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let max_frame = state.rooms.limits().max_frame_bytes as usize;
    upgrade
        .protocols([SUBPROTOCOL])
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

async fn session<S: GraphStore>(
    mut socket: WebSocket,
    state: AppState<S>,
    token: String,
    _permit: ConnectionPermit,
) {
    let Some(principal) = state.identity.verify(&token).await.ok() else {
        return;
    };
    if principal.purpose != SessionPurpose::Client {
        return;
    }
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
    if hello.protocol != PROTOCOL_VERSION {
        let _ = send_error(
            &mut socket,
            &state,
            ErrorCode::UnsupportedProtocol,
            false,
            "unsupported protocol version",
        )
        .await;
        return;
    }
    if hello.schema != graph_core::SCHEMA_VERSION as u16 {
        let _ = send_error(
            &mut socket,
            &state,
            ErrorCode::UnsupportedSchema,
            false,
            "unsupported graph schema",
        )
        .await;
        return;
    }

    let opened = match state
        .rooms
        .open_with_base_status(
            &hello.graph_id,
            &hello.session_id,
            &principal.id,
            hello.history_epoch,
            &hello.version_vector,
            hello.has_server_base,
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

    run_session(socket, state, opened.connection, token).await;
}

async fn receive_hello<S: GraphStore>(
    socket: &mut WebSocket,
    state: &AppState<S>,
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

async fn run_session<S: GraphStore>(
    socket: WebSocket,
    state: AppState<S>,
    mut connection: RoomConnection,
    token: String,
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
                if state.identity.verify(&token).await.is_err() {
                    break;
                }
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

async fn send_message<S: GraphStore>(
    socket: &mut WebSocket,
    state: &AppState<S>,
    message: &Message,
) -> Result<(), ()> {
    let frame = encode(message, state.rooms.limits().max_frame_bytes as usize).map_err(|_| ())?;
    socket
        .send(WsMessage::Binary(frame.into()))
        .await
        .map_err(|_| ())
}

async fn send_sink<S, T>(sink: &mut T, state: &AppState<S>, message: &Message) -> Result<(), ()>
where
    S: GraphStore,
    T: futures_util::Sink<WsMessage> + Unpin,
{
    let frame = encode(message, state.rooms.limits().max_frame_bytes as usize).map_err(|_| ())?;
    sink.send(WsMessage::Binary(frame.into()))
        .await
        .map_err(|_| ())
}

async fn send_error<S: GraphStore>(
    socket: &mut WebSocket,
    state: &AppState<S>,
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
