use crate::{
    auth::{
        AccountPatch, AccountStatus, AccountView, AuthError, IdentityService, Principal,
        ServerRole, SessionPurpose,
    },
    metrics::Metrics,
    room::{RoomConfig, RoomConnection, RoomError, RoomManager},
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
    http::{HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode, header},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use domain::GraphId;
use futures_util::{Sink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use sync_protocol::{
    DEFAULT_MAX_GRAPH_BYTES, ErrorCode, ErrorMessage, Hello, Message, PROTOCOL_VERSION,
    SUBPROTOCOL, decode, encode, validate_message,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::time::{interval, timeout};
use tower_http::cors::{Any, CorsLayer};

const GRAPH_BYTE_QUOTA: u64 = DEFAULT_MAX_GRAPH_BYTES as u64;
const MAX_SEEDED_GRAPH_BODY: usize = GRAPH_BYTE_QUOTA as usize + 64 * 1024;
const SERVER_GRAPH_PEER_ID: u64 = u64::MAX - 2;
const CHECKPOINT_EPOCH_HEADER: &str = "x-neoseq-history-epoch";
const CHECKPOINT_VERSION_HEADER: &str = "x-neoseq-version-vector";
const CHECKPOINT_CHECKSUM_HEADER: &str = "x-neoseq-checkpoint-checksum";

#[derive(Clone)]
pub struct AppState {
    rooms: Arc<RoomManager>,
    store: Arc<dyn GraphAdmin>,
    identity: Arc<dyn IdentityService>,
    pub metrics: Arc<Metrics>,
    connections: Arc<Semaphore>,
    membership_recheck: Duration,
    shutdown: watch::Sender<bool>,
}

impl AppState {
    /// Composes HTTP administration and live rooms from one backend instance so
    /// both paths necessarily observe the same durable graph state.
    pub fn new(
        store: Arc<dyn GraphAdmin>,
        identity: Arc<dyn IdentityService>,
        metrics: Arc<Metrics>,
        room_config: RoomConfig,
        max_connections: usize,
        membership_recheck: Duration,
    ) -> Self {
        let room_store: Arc<dyn GraphStore> = store.clone();
        Self {
            rooms: Arc::new(RoomManager::new(room_store, room_config, metrics.clone())),
            store,
            identity,
            metrics,
            connections: Arc::new(Semaphore::new(max_connections)),
            membership_recheck,
            shutdown: watch::channel(false).0,
        }
    }

    pub fn shutdown_handle(&self) -> watch::Sender<bool> {
        self.shutdown.clone()
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/livez", get(liveness))
        .route("/readyz", get(readiness))
        .route("/metrics", get(metrics))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/auth/me", get(current_account))
        .route("/v1/auth/password", put(change_password))
        .route(
            "/v1/admin/accounts",
            get(list_accounts).post(create_account),
        )
        .route("/v1/admin/accounts/{account_id}", patch(update_account))
        .route(
            "/v1/admin/accounts/{account_id}/password",
            put(reset_account_password),
        )
        .route(
            "/v1/admin/accounts/{account_id}/sessions",
            delete(revoke_account_sessions),
        )
        .route("/v1/sync", get(sync_upgrade))
        .route("/v1/graphs", get(list_graphs).post(create_graph))
        .route(
            "/v1/graphs/{graph_id}/checkpoint",
            get(download_graph_checkpoint),
        )
        .route(
            "/v1/graphs/import",
            post(create_seeded_graph).layer(DefaultBodyLimit::max(MAX_SEEDED_GRAPH_BODY)),
        )
        .route("/v1/graphs/{graph_id}/members", get(list_memberships))
        .route(
            "/v1/graphs/{graph_id}/members/{username}",
            put(grant_membership).delete(revoke_membership),
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
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
                .expose_headers([
                    HeaderName::from_static(CHECKPOINT_EPOCH_HEADER),
                    HeaderName::from_static(CHECKPOINT_VERSION_HEADER),
                    HeaderName::from_static(CHECKPOINT_CHECKSUM_HEADER),
                ]),
        )
        .with_state(state)
}

#[derive(Serialize)]
struct GraphResponse {
    graph_id: GraphId,
    display_name: String,
    created_at: String,
    updated_at: String,
    role: GraphRole,
    status: GraphStatus,
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
    graph_id: GraphId,
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
    role: GraphRole,
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
    SessionPurpose::Client.as_str().into()
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
    server_role: ServerRole,
    purpose: SessionPurpose,
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
    ServerRole::User.as_str().into()
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

type ApiResult<T = Response<Body>> = Result<T, ApiError>;

/// HTTP-only error vocabulary. Domain services remain transport-agnostic; this
/// boundary owns the stable status and response-body contract exposed by the API.
enum ApiError {
    Status(StatusCode),
    Message(StatusCode, &'static str),
    Auth(AuthError),
    Store(StoreError),
}

impl ApiError {
    const fn status(status: StatusCode) -> Self {
        Self::Status(status)
    }

    const fn message(status: StatusCode, message: &'static str) -> Self {
        Self::Message(status, message)
    }
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        Self::Auth(error)
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response<Body> {
        match self {
            Self::Status(status) => status.into_response(),
            Self::Message(status, message) => (status, message).into_response(),
            Self::Auth(error) => match error {
                AuthError::Invalid => StatusCode::UNAUTHORIZED.into_response(),
                AuthError::Forbidden => StatusCode::FORBIDDEN.into_response(),
                AuthError::Conflict => {
                    (StatusCode::CONFLICT, "account already exists\n").into_response()
                }
                AuthError::InvalidInput(message) => {
                    (StatusCode::BAD_REQUEST, message).into_response()
                }
                AuthError::LastAdmin => (
                    StatusCode::CONFLICT,
                    "the last active administrator cannot be changed\n",
                )
                    .into_response(),
                AuthError::Unavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            },
            Self::Store(error) => match error {
                StoreError::AccessDenied | StoreError::ReadOnly => {
                    StatusCode::FORBIDDEN.into_response()
                }
                StoreError::QuotaExceeded => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
                StoreError::GraphAlreadyExists => {
                    (StatusCode::CONFLICT, "graph already exists\n").into_response()
                }
                _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            },
        }
    }
}

async fn login(State(state): State<AppState>, Json(request): Json<LoginRequest>) -> ApiResult {
    let purpose = SessionPurpose::parse(&request.purpose)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "invalid session purpose\n"))?;
    let session = state
        .identity
        .login(
            &request.username,
            &request.password,
            purpose,
            purpose == SessionPurpose::Client && request.persistent,
        )
        .await
        .map_err(|error| match error {
            AuthError::Invalid | AuthError::Forbidden => {
                ApiError::message(StatusCode::UNAUTHORIZED, "invalid username or password\n")
            }
            error => error.into(),
        })?;
    Ok(Json(LoginResponse {
        access_token: session.access_token,
        expires_at: session.expires_at,
        account: session.account,
    })
    .into_response())
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let token = bearer_token(&headers).ok_or_else(|| ApiError::status(StatusCode::UNAUTHORIZED))?;
    state.identity.logout(token).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn current_account(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let principal = authenticated_principal(&state, &headers, None).await?;
    Ok(Json(CurrentAccountResponse {
        account_id: principal.id,
        username: principal.username,
        server_role: principal.server_role,
        purpose: principal.purpose,
    })
    .into_response())
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> ApiResult {
    let principal = authenticated_principal(&state, &headers, None).await?;
    state
        .identity
        .change_password(&principal, &request.current_password, &request.new_password)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn list_accounts(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let actor = admin_principal(&state, &headers).await?;
    let accounts = state.identity.list_accounts(&actor).await?;
    Ok(Json(AccountsResponse { accounts }).into_response())
}

async fn create_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateAccountRequest>,
) -> ApiResult {
    let actor = admin_principal(&state, &headers).await?;
    let role = parse_server_role(&request.server_role)?;
    let account = state
        .identity
        .create_account(&actor, &request.username, &request.password, role)
        .await?;
    Ok((StatusCode::CREATED, Json(account)).into_response())
}

async fn update_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Json(request): Json<UpdateAccountRequest>,
) -> ApiResult {
    let actor = admin_principal(&state, &headers).await?;
    let status = request
        .status
        .as_deref()
        .map(|status| {
            AccountStatus::parse(status).ok_or_else(|| {
                ApiError::message(StatusCode::BAD_REQUEST, "invalid account status\n")
            })
        })
        .transpose()?;
    let server_role = match request.server_role.as_deref() {
        None => None,
        Some(role) => Some(parse_server_role(role)?),
    };
    let account = state
        .identity
        .update_account(
            &actor,
            &account_id,
            AccountPatch {
                status,
                server_role,
            },
        )
        .await?;
    Ok(Json(account).into_response())
}

async fn reset_account_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Json(request): Json<ResetPasswordRequest>,
) -> ApiResult {
    let actor = admin_principal(&state, &headers).await?;
    state
        .identity
        .reset_password(&actor, &account_id, &request.password)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn revoke_account_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> ApiResult {
    let actor = admin_principal(&state, &headers).await?;
    state.identity.revoke_sessions(&actor, &account_id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn list_graphs(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let principal = api_principal(&state, &headers).await?;
    let graphs = state.store.list_graphs(&principal).await?;
    Ok(Json(GraphsResponse {
        graphs: graphs
            .into_iter()
            .map(|graph| GraphResponse {
                graph_id: graph.graph_id,
                display_name: graph.display_name,
                created_at: graph.created_at,
                updated_at: graph.updated_at,
                role: graph.role,
                status: graph.status,
                membership_version: graph.membership_version,
            })
            .collect(),
    })
    .into_response())
}

async fn create_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateGraphRequest>,
) -> ApiResult {
    let principal = api_principal(&state, &headers).await?;
    let graph_id = GraphId::new(&request.graph_id)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "invalid graph id\n"))?;
    let display_name = request.name.trim();
    if !valid_graph_name(display_name) {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "invalid graph name\n",
        ));
    }
    let core = graph_core::GraphCore::new(graph_id.clone(), SERVER_GRAPH_PEER_ID, "server:create")
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "invalid graph id\n"))?;
    let snapshot = core
        .export_snapshot()
        .map_err(|_| ApiError::status(StatusCode::INTERNAL_SERVER_ERROR))?;
    let version_vector = core.version_vector();
    let checkpoint_checksum = graph_core::checksum(&snapshot);
    let outcome = state
        .store
        .create_graph(NewGraph {
            graph_id: &graph_id,
            display_name,
            owner_account_id: &principal,
            schema_version: graph_core::SCHEMA_VERSION,
            byte_quota: GRAPH_BYTE_QUOTA,
            snapshot: &snapshot,
            version_vector: &version_vector,
        })
        .await?;
    Ok(created_graph_response(
        outcome,
        graph_id,
        checkpoint_checksum,
    ))
}

async fn create_seeded_graph(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> ApiResult {
    let principal = api_principal(&state, &headers).await?;
    let request = read_seeded_graph_request(multipart).await?;
    let graph_id = GraphId::new(&request.graph_id)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "invalid graph id\n"))?;
    let display_name = request.name.trim();
    if !valid_graph_name(display_name) {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "invalid graph name\n",
        ));
    }
    if request.checkpoint.len() > state.rooms.limits().max_decompressed_bytes as usize {
        return Err(ApiError::message(
            StatusCode::PAYLOAD_TOO_LARGE,
            "graph checkpoint is too large\n",
        ));
    }
    let checkpoint = request.checkpoint;
    let checkpoint_checksum = graph_core::checksum(&checkpoint);
    if checkpoint_checksum != request.checkpoint_checksum {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "graph checkpoint checksum mismatch\n",
        ));
    }
    let validation_graph_id = graph_id.clone();
    let validated = tokio::task::spawn_blocking(move || {
        graph_core::GraphCore::from_snapshot(validation_graph_id, SERVER_GRAPH_PEER_ID, &checkpoint)
            .map(|core| (checkpoint, core.version_vector()))
    })
    .await;
    let (checkpoint, version_vector) = match validated {
        Ok(Ok(validated)) => validated,
        Ok(Err(_)) => {
            return Err(ApiError::message(
                StatusCode::BAD_REQUEST,
                "invalid graph checkpoint\n",
            ));
        }
        Err(_) => return Err(ApiError::status(StatusCode::INTERNAL_SERVER_ERROR)),
    };
    let outcome = state
        .store
        .create_graph(NewGraph {
            graph_id: &graph_id,
            display_name,
            owner_account_id: &principal,
            schema_version: graph_core::SCHEMA_VERSION,
            byte_quota: GRAPH_BYTE_QUOTA,
            snapshot: &checkpoint,
            version_vector: &version_vector,
        })
        .await?;
    Ok(created_graph_response(
        outcome,
        graph_id,
        checkpoint_checksum,
    ))
}

async fn download_graph_checkpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(graph_id): Path<String>,
) -> ApiResult {
    let principal = api_principal(&state, &headers).await?;
    let graph_id = private_graph_id(&graph_id)?;
    let checkpoint = match state.rooms.export_checkpoint(&graph_id, &principal).await {
        Ok(checkpoint) => checkpoint,
        Err(RoomError::Store(error)) => return Err(error.into()),
        Err(_) => return Err(ApiError::status(StatusCode::SERVICE_UNAVAILABLE)),
    };
    let metadata = [
        (
            CHECKPOINT_EPOCH_HEADER,
            checkpoint.history_epoch.to_string(),
        ),
        (
            CHECKPOINT_VERSION_HEADER,
            URL_SAFE_NO_PAD.encode(&checkpoint.server_version_vector),
        ),
        (CHECKPOINT_CHECKSUM_HEADER, checkpoint.checksum),
    ];
    let mut response = Response::new(Body::from(checkpoint.bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.neoseq.checkpoint"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for (name, value) in metadata {
        let value = HeaderValue::from_str(&value)
            .map_err(|_| ApiError::status(StatusCode::INTERNAL_SERVER_ERROR))?;
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), value);
    }
    Ok(response)
}

async fn read_seeded_graph_request(mut multipart: Multipart) -> ApiResult<SeededGraphRequest> {
    let invalid_body = || ApiError::message(StatusCode::BAD_REQUEST, "invalid graph import body\n");
    let mut graph_id = None;
    let mut name = None;
    let mut checkpoint_checksum = None;
    let mut checkpoint = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| invalid_body())? {
        match field.name() {
            Some("graph_id") if graph_id.is_none() => {
                graph_id = Some(field.text().await.map_err(|_| invalid_body())?);
            }
            Some("name") if name.is_none() => {
                name = Some(field.text().await.map_err(|_| invalid_body())?);
            }
            Some("checkpoint_checksum") if checkpoint_checksum.is_none() => {
                checkpoint_checksum = Some(field.text().await.map_err(|_| invalid_body())?);
            }
            Some("checkpoint") if checkpoint.is_none() => {
                checkpoint = Some(field.bytes().await.map_err(|_| invalid_body())?.to_vec());
            }
            _ => return Err(invalid_body()),
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
        _ => Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "incomplete graph import body\n",
        )),
    }
}

fn created_graph_response(
    outcome: CreateGraphOutcome,
    graph_id: GraphId,
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

async fn list_memberships(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(graph_id): Path<String>,
) -> ApiResult {
    let (_, graph_id) = owner_for_private_graph_lookup(&state, &headers, &graph_id).await?;
    let memberships = state.store.list_memberships(&graph_id).await?;
    let mut response = Vec::with_capacity(memberships.len());
    for membership in memberships {
        let username = state
            .identity
            .username_for(&membership.account_id)
            .await?
            .ok_or_else(|| ApiError::status(StatusCode::INTERNAL_SERVER_ERROR))?;
        response.push(MembershipResponse {
            account_id: membership.account_id,
            username,
            role: membership.role,
            version: membership.version,
        });
    }
    Ok(Json(MembershipsResponse {
        memberships: response,
    })
    .into_response())
}

async fn grant_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((graph_id, username)): Path<(String, String)>,
    Json(request): Json<GrantRequest>,
) -> ApiResult {
    let (actor_account_id, graph_id) =
        owner_for_private_graph_lookup(&state, &headers, &graph_id).await?;
    let role = GraphRole::parse(&request.role)
        .filter(|role| *role != GraphRole::Owner)
        .ok_or_else(|| {
            ApiError::message(StatusCode::BAD_REQUEST, "role must be editor or viewer\n")
        })?;
    let account_id = membership_account(&state, &username).await?;
    state
        .store
        .grant_membership(&graph_id, &actor_account_id, &account_id, role)
        .await
        .map_err(|error| match error {
            StoreError::InvalidMembershipRole => ApiError::message(
                StatusCode::BAD_REQUEST,
                "owner membership cannot be changed\n",
            ),
            error => error.into(),
        })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn revoke_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((graph_id, username)): Path<(String, String)>,
) -> ApiResult {
    let (actor_account_id, graph_id) =
        owner_for_private_graph_lookup(&state, &headers, &graph_id).await?;
    let account_id = membership_account(&state, &username).await?;
    state
        .store
        .revoke_membership(&graph_id, &actor_account_id, &account_id)
        .await
        .map_err(|error| match error {
            StoreError::InvalidMembershipRole => ApiError::message(
                StatusCode::BAD_REQUEST,
                "owner membership cannot be revoked\n",
            ),
            error => error.into(),
        })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn api_principal(state: &AppState, headers: &HeaderMap) -> ApiResult<String> {
    authenticated_principal(state, headers, Some(SessionPurpose::Client))
        .await
        .map(|principal| principal.id)
}

/// Read-only privacy gate before resolving graph-scoped identifiers such as a
/// target username. Membership mutations still reauthorize the actor inside
/// their store transaction; this check is not their authority boundary.
async fn owner_for_private_graph_lookup(
    state: &AppState,
    headers: &HeaderMap,
    graph_id: &str,
) -> ApiResult<(String, GraphId)> {
    let principal = api_principal(state, headers).await?;
    let graph_id = private_graph_id(graph_id)?;
    match state.store.authorize(&graph_id, &principal).await {
        Ok(membership) if membership.role == GraphRole::Owner => Ok((principal, graph_id)),
        Ok(_) | Err(StoreError::AccessDenied) => Err(ApiError::status(StatusCode::FORBIDDEN)),
        Err(error) => Err(error.into()),
    }
}

fn private_graph_id(value: &str) -> ApiResult<GraphId> {
    GraphId::new(value).map_err(|_| ApiError::status(StatusCode::FORBIDDEN))
}

async fn authenticated_principal(
    state: &AppState,
    headers: &HeaderMap,
    expected_purpose: Option<SessionPurpose>,
) -> ApiResult<Principal> {
    let token = bearer_token(headers).ok_or_else(|| ApiError::status(StatusCode::UNAUTHORIZED))?;
    let principal = state
        .identity
        .verify(token)
        .await
        .map_err(|_| ApiError::status(StatusCode::UNAUTHORIZED))?;
    if expected_purpose.is_some_and(|purpose| purpose != principal.purpose) {
        return Err(ApiError::status(StatusCode::FORBIDDEN));
    }
    Ok(principal)
}

async fn admin_principal(state: &AppState, headers: &HeaderMap) -> ApiResult<Principal> {
    let principal = authenticated_principal(state, headers, Some(SessionPurpose::Admin)).await?;
    if principal.is_admin() {
        Ok(principal)
    } else {
        Err(ApiError::status(StatusCode::FORBIDDEN))
    }
}

async fn membership_account(state: &AppState, username: &str) -> ApiResult<String> {
    Ok(state.identity.resolve_username(username).await?)
}

fn parse_server_role(value: &str) -> Result<ServerRole, AuthError> {
    ServerRole::parse(value).ok_or(AuthError::InvalidInput("invalid server role"))
}

async fn liveness() -> &'static str {
    "ok\n"
}

async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    let request_id = state.metrics.next_request_id();
    match state.store.ready().await {
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

async fn metrics(State(state): State<AppState>) -> Response<Body> {
    let mut response = Response::new(Body::from(state.metrics.render()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/openmetrics-text; version=1.0.0; charset=utf-8"),
    );
    response
}

async fn sync_upgrade(
    State(state): State<AppState>,
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
    let Ok(permit) = state.connections.clone().try_acquire_owned() else {
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

async fn session(
    mut socket: WebSocket,
    state: AppState,
    token: String,
    _permit: OwnedSemaphorePermit,
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

async fn receive_hello(socket: &mut WebSocket, state: &AppState) -> Result<Hello, Message> {
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

async fn run_session(
    socket: WebSocket,
    state: AppState,
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
                if send_message(&mut sink, &state, &message).await.is_err() {
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
                        if send_message(&mut sink, &state, &message).await.is_err() { break; }
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
                    if send_message(&mut sink, &state, &message).await.is_err() { break; }
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
                    let _ = send_message(&mut sink, &state, &message).await;
                    break;
                }
            }
        }
    }
    state.rooms.disconnect(&connection).await;
}

async fn send_message<S>(sink: &mut S, state: &AppState, message: &Message) -> Result<(), ()>
where
    S: Sink<WsMessage> + Unpin,
{
    let frame = encode(message, state.rooms.limits().max_frame_bytes as usize).map_err(|_| ())?;
    sink.send(WsMessage::Binary(frame.into()))
        .await
        .map_err(|_| ())
}

async fn send_error<S>(
    sink: &mut S,
    state: &AppState,
    code: ErrorCode,
    recoverable: bool,
    diagnostic: &str,
) -> Result<(), ()>
where
    S: Sink<WsMessage> + Unpin,
{
    send_message(sink, state, &error_message(code, recoverable, diagnostic)).await
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
        RoomError::InvalidSession => (ErrorCode::InvalidMessage, false, "invalid session metadata"),
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
