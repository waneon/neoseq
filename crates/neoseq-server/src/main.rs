mod bootstrap;

use bootstrap::bootstrap_admin_from_environment;
use neoseq_server::{AppState, Metrics, PgIdentity, PgStore, RoomConfig, RoomManager, router};
use std::{env, io, net::SocketAddr, sync::Arc, time::Duration};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::from_default_env())
        .with_current_span(true)
        .init();

    if env::args_os().nth(1).is_some() {
        return Err(io::Error::other("neoseq-server does not accept command arguments").into());
    }

    let database_url = env::var("DATABASE_URL")?;
    let store = Arc::new(PgStore::connect(&database_url, 16).await?);
    serve(store).await
}

async fn serve(store: Arc<PgStore>) -> Result<(), Box<dyn std::error::Error>> {
    let identity = Arc::new(PgIdentity::new(store.pool().clone())?);
    bootstrap_admin_from_environment(&identity).await?;
    let bind = env::var("NEOSEQ_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let address: SocketAddr = bind.parse()?;
    let metrics = Arc::new(Metrics::default());
    let rooms = Arc::new(RoomManager::new(
        store,
        RoomConfig::default(),
        metrics.clone(),
    ));
    let state = AppState::new(rooms, identity, metrics, 4_096, Duration::from_secs(5));
    let shutdown = state.shutdown_handle();
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "sync server listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await?;
    Ok(())
}

async fn shutdown_signal(shutdown: tokio::sync::watch::Sender<bool>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;

    let _ = shutdown.send(true);
    tracing::info!("graceful shutdown requested");
}
