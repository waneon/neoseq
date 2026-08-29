mod bootstrap;

use bootstrap::bootstrap_admin_from_environment;
use domain::GraphId;
use graph_core::{GraphCore, SCHEMA_VERSION};
use std::{env, io, net::SocketAddr, sync::Arc, time::Duration};
use sync_server::{
    AppState, GraphRole, Metrics, PgIdentity, PgStore, RoomConfig, RoomManager, TestIssuer, router,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::from_default_env())
        .with_current_span(true)
        .init();

    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "serve".into());
    if command == "issue-token" {
        let principal = arguments.next().ok_or_else(usage)?;
        require_no_more(arguments)?;
        let issuer = test_issuer()?;
        println!("{}", issuer.issue(&principal)?);
        return Ok(());
    }

    let database_url = env::var("DATABASE_URL")?;
    let store = Arc::new(PgStore::connect(&database_url, 16).await?);
    match command.as_str() {
        "serve" => {
            require_no_more(arguments)?;
            serve(store).await
        }
        "create-graph" => {
            let graph_id = arguments.next().ok_or_else(usage)?;
            let owner = arguments.next().ok_or_else(usage)?;
            let byte_quota = arguments
                .next()
                .map(|value| value.parse())
                .transpose()?
                .unwrap_or(64 * 1024 * 1024);
            require_no_more(arguments)?;
            let graph = GraphId::new(&graph_id)?;
            let core = GraphCore::new(graph, u64::MAX - 2, "server:create")?;
            store
                .create_graph(
                    &graph_id,
                    &owner,
                    SCHEMA_VERSION,
                    byte_quota,
                    &core.export_snapshot()?,
                    &core.version_vector(),
                )
                .await?;
            println!("created graph {graph_id}");
            Ok(())
        }
        "grant" => {
            let graph_id = arguments.next().ok_or_else(usage)?;
            let principal = arguments.next().ok_or_else(usage)?;
            let role = parse_role(&arguments.next().ok_or_else(usage)?)?;
            require_no_more(arguments)?;
            store.grant(&graph_id, &principal, role).await?;
            println!("granted membership for {principal}");
            Ok(())
        }
        "revoke" => {
            let graph_id = arguments.next().ok_or_else(usage)?;
            let principal = arguments.next().ok_or_else(usage)?;
            require_no_more(arguments)?;
            store.revoke(&graph_id, &principal).await?;
            println!("revoked membership for {principal}");
            Ok(())
        }
        "bootstrap-admin" => {
            let username = arguments.next().ok_or_else(usage)?;
            require_no_more(arguments)?;
            let password = rpassword::prompt_password("Password: ")?;
            let confirmation = rpassword::prompt_password("Confirm password: ")?;
            if password != confirmation {
                return Err(io::Error::other("passwords do not match").into());
            }
            let identity = PgIdentity::new(store.pool().clone(), optional_test_issuer()?)?;
            let account = identity.bootstrap_admin(&username, &password).await?;
            println!("created administrator {}", account.username);
            Ok(())
        }
        _ => Err(usage().into()),
    }
}

async fn serve(store: Arc<PgStore>) -> Result<(), Box<dyn std::error::Error>> {
    let identity = Arc::new(PgIdentity::new(
        store.pool().clone(),
        optional_test_issuer()?,
    )?);
    bootstrap_admin_from_environment(&identity).await?;
    let bind = env::var("NEOSEQ_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let address: SocketAddr = bind.parse()?;
    let metrics = Arc::new(Metrics::default());
    let rooms = Arc::new(RoomManager::new(
        store,
        RoomConfig::default(),
        metrics.clone(),
    ));
    let state = AppState::new(
        rooms,
        identity.clone(),
        metrics,
        4_096,
        Duration::from_secs(5),
    )
    .with_identity(identity);
    let shutdown = state.shutdown_handle();
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "sync server listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await?;
    Ok(())
}

fn test_issuer() -> Result<TestIssuer, Box<dyn std::error::Error>> {
    let secret = env::var("NEOSEQ_TEST_AUTH_SECRET").map_err(|_| {
        io::Error::other(
            "NEOSEQ_TEST_AUTH_SECRET is required by the development issue-token command",
        )
    })?;
    Ok(TestIssuer::new(secret)?)
}

fn optional_test_issuer() -> Result<Option<TestIssuer>, Box<dyn std::error::Error>> {
    env::var("NEOSEQ_TEST_AUTH_SECRET")
        .ok()
        .map(TestIssuer::new)
        .transpose()
        .map_err(Into::into)
}

fn parse_role(value: &str) -> Result<GraphRole, io::Error> {
    match value {
        "owner" => Ok(GraphRole::Owner),
        "editor" => Ok(GraphRole::Editor),
        "viewer" => Ok(GraphRole::Viewer),
        _ => Err(usage()),
    }
}

fn require_no_more(mut arguments: impl Iterator<Item = String>) -> Result<(), io::Error> {
    if arguments.next().is_none() {
        Ok(())
    } else {
        Err(usage())
    }
}

fn usage() -> io::Error {
    io::Error::other(
        "usage: sync-server [serve | bootstrap-admin <username> | create-graph <graph> <owner> [byte-quota] | grant <graph> <principal> <owner|editor|viewer> | revoke <graph> <principal> | issue-token <principal>]",
    )
}

async fn shutdown_signal(shutdown: tokio::sync::watch::Sender<bool>) {
    let _ = tokio::signal::ctrl_c().await;
    let _ = shutdown.send(true);
    tracing::info!("graceful shutdown requested");
}
