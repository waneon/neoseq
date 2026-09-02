use std::{
    env,
    error::Error,
    fs, io,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    path::Path,
    process::{ExitStatus, Stdio},
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout},
};

const POSTGRES_MAJOR: &str = "17";
const POSTGRES_USER: &str = "neoseq";
const POSTGRES_DATABASE: &str = "neoseq";
const POSTGRES_DATA_DIR: &str = "/var/lib/neoseq/postgres/data";
const LEGACY_POSTGRES_DATA_DIR: &str = "/var/lib/neoseq/postgres/17/data";
const POSTGRES_SOCKET_DIR: &str = "/run/neoseq/postgres";
const EMBEDDED_DATABASE_URL: &str = "postgresql:///neoseq?host=/run/neoseq/postgres&user=neoseq";
const SERVER_PORT: u16 = 8787;
const PUBLIC_PORT: u16 = 8080;
const CADDYFILE: &str = "/etc/neoseq/Caddyfile";
const CADDY_CONFIG_DIR: &str = "/run/neoseq/caddy/config";
const CADDY_DATA_DIR: &str = "/run/neoseq/caddy/data";

const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(250);
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(50);
const PROCESS_GRACE: Duration = Duration::from_secs(8);
const POSTGRES_CTL_GRACE: Duration = Duration::from_secs(18);
const POSTGRES_SIGNAL_GRACE: Duration = Duration::from_secs(5);
const FORCED_REAP_GRACE: Duration = Duration::from_secs(2);

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, PartialEq, Eq)]
enum Database {
    Embedded,
    External(String),
}

impl Database {
    fn from_environment() -> Result<Self> {
        let direct_url = optional("DATABASE_URL");
        let url_file = optional("DATABASE_URL_FILE");
        match (direct_url, url_file) {
            (Some(_), Some(_)) => {
                Err(invalid("DATABASE_URL and DATABASE_URL_FILE are mutually exclusive").into())
            }
            (Some(url), None) => Ok(Self::External(url)),
            (None, Some(path)) => Ok(Self::External(read_secret(
                Path::new(&path),
                "DATABASE_URL_FILE",
            )?)),
            (None, None) => Ok(Self::Embedded),
        }
    }

    fn url(&self) -> &str {
        match self {
            Self::Embedded => EMBEDDED_DATABASE_URL,
            Self::External(url) => url,
        }
    }
}

struct ServeConfig {
    database: Database,
    startup_timeout: Duration,
}

impl ServeConfig {
    fn from_environment() -> Result<Self> {
        Ok(Self {
            database: Database::from_environment()?,
            startup_timeout: startup_timeout_from_environment()?,
        })
    }
}

struct RestoreConfig {
    startup_timeout: Duration,
}

impl RestoreConfig {
    fn from_environment() -> Result<Self> {
        if matches!(Database::from_environment()?, Database::External(_)) {
            return Err(invalid("restore is supported only for embedded PostgreSQL").into());
        }
        Ok(Self {
            startup_timeout: startup_timeout_from_environment()?,
        })
    }
}

struct Children {
    postgres: Option<Child>,
    server: Option<Child>,
    ingress: Option<Child>,
}

impl Children {
    fn new() -> Self {
        Self {
            postgres: None,
            server: None,
            ingress: None,
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("component=appliance level=error message={error:?}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "serve".into());
    match command.as_str() {
        "serve" => {
            no_more_arguments(arguments)?;
            serve(ServeConfig::from_environment()?).await
        }
        "health" => {
            no_more_arguments(arguments)?;
            health().await
        }
        "backup" => {
            let destination = required_argument(&mut arguments, "backup destination")?;
            no_more_arguments(arguments)?;
            backup(Database::from_environment()?, Path::new(&destination)).await
        }
        "restore" => {
            let source = required_argument(&mut arguments, "backup source")?;
            no_more_arguments(arguments)?;
            restore(RestoreConfig::from_environment()?, Path::new(&source)).await
        }
        _ => Err(
            invalid("usage: neoseq-appliance [serve|health|backup <path>|restore <path>]").into(),
        ),
    }
}

async fn serve(config: ServeConfig) -> Result<()> {
    prepare_runtime()?;
    let mut children = Children::new();
    let startup = match timeout(
        config.startup_timeout,
        start_components(&config.database, &mut children),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(invalid("timed out starting the appliance").into()),
    };
    if let Err(error) = startup {
        shutdown(&mut children).await;
        return Err(error);
    }

    eprintln!("component=appliance level=info message=ready");
    match wait_for_event(&mut children).await {
        Event::Shutdown => {
            eprintln!("component=appliance level=info message=shutdown-requested");
            shutdown(&mut children).await;
            Ok(())
        }
        Event::Exited(component, status) => {
            eprintln!(
                "component=appliance level=error message=child-exited child={component} status={status}"
            );
            shutdown(&mut children).await;
            Err(invalid(format!("child {component} exited unexpectedly")).into())
        }
        Event::WaitFailed(component, error) => {
            shutdown(&mut children).await;
            Err(io::Error::new(
                error.kind(),
                format!("could not wait for {component}: {error}"),
            )
            .into())
        }
    }
}

async fn start_components(database: &Database, children: &mut Children) -> Result<()> {
    if database == &Database::Embedded {
        initialize_postgres().await?;
        children.postgres = Some(start_postgres()?);
        wait_for_postgres(
            children
                .postgres
                .as_mut()
                .expect("PostgreSQL was just started"),
        )
        .await?;
        ensure_database().await?;
    }

    children.server = Some(
        Command::new("neoseq-server")
            .env("DATABASE_URL", database.url())
            .env("NEOSEQ_BIND", "127.0.0.1:8787")
            .stdin(Stdio::null())
            .spawn()?,
    );
    wait_for_server(children).await?;

    children.ingress = Some(
        Command::new("caddy")
            .args(["run", "--config", CADDYFILE, "--adapter", "caddyfile"])
            .env("XDG_CONFIG_HOME", CADDY_CONFIG_DIR)
            .env("XDG_DATA_HOME", CADDY_DATA_DIR)
            .stdin(Stdio::null())
            .spawn()?,
    );
    wait_for_public_readiness(children).await
}

enum Event {
    Shutdown,
    Exited(&'static str, ExitStatus),
    WaitFailed(&'static str, io::Error),
}

async fn wait_for_event(children: &mut Children) -> Event {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut interrupt = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = terminate.recv() => Event::Shutdown,
            _ = interrupt.recv() => Event::Shutdown,
            result = wait_optional(&mut children.ingress) => child_event("ingress", result),
            result = wait_optional(&mut children.server) => child_event("server", result),
            result = wait_optional(&mut children.postgres) => child_event("postgres", result),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = children;
        let _ = tokio::signal::ctrl_c().await;
        Event::Shutdown
    }
}

fn child_event(component: &'static str, result: io::Result<ExitStatus>) -> Event {
    match result {
        Ok(status) => Event::Exited(component, status),
        Err(error) => Event::WaitFailed(component, error),
    }
}

async fn wait_optional(child: &mut Option<Child>) -> io::Result<ExitStatus> {
    match child {
        Some(child) => child.wait().await,
        None => std::future::pending().await,
    }
}

async fn shutdown(children: &mut Children) {
    let deadline = Instant::now() + SHUTDOWN_BUDGET;
    terminate(&mut children.ingress, libc::SIGTERM, "ingress", deadline).await;
    terminate(&mut children.server, libc::SIGTERM, "server", deadline).await;
    stop_postgres(&mut children.postgres, deadline).await;
}

async fn terminate(
    slot: &mut Option<Child>,
    signal: i32,
    component: &str,
    global_deadline: Instant,
) {
    let Some(mut child) = slot.take() else {
        return;
    };
    if child_has_exited(&mut child, component) {
        return;
    }
    if let Some(pid) = child.id() {
        send_signal(pid, signal);
    }
    if wait_until(
        &mut child,
        capped_deadline(global_deadline, PROCESS_GRACE),
        component,
    )
    .await
    {
        return;
    }
    force_kill(child, component, global_deadline).await;
}

async fn stop_postgres(slot: &mut Option<Child>, global_deadline: Instant) {
    let Some(mut postgres) = slot.take() else {
        return;
    };
    if child_has_exited(&mut postgres, "postgres") {
        return;
    }

    let control_deadline = capped_deadline(global_deadline, POSTGRES_CTL_GRACE);
    let timeout_seconds = POSTGRES_CTL_GRACE.as_secs().to_string();
    let mut command = Command::new("pg_ctl");
    command
        .arg("-D")
        .arg(POSTGRES_DATA_DIR)
        .args(["-m", "fast", "-t", &timeout_seconds, "-w", "stop"])
        .kill_on_drop(true);
    let stopped = match timeout(remaining(control_deadline), command.status()).await {
        Ok(Ok(status)) if status.success() => {
            wait_until(&mut postgres, control_deadline, "postgres").await
        }
        _ => false,
    };
    if stopped {
        return;
    }

    eprintln!("component=appliance level=warn message=postgres-fast-stop-failed");
    if let Some(pid) = postgres.id() {
        send_signal(pid, libc::SIGINT);
    }
    if wait_until(
        &mut postgres,
        capped_deadline(global_deadline, POSTGRES_SIGNAL_GRACE),
        "postgres",
    )
    .await
    {
        return;
    }
    force_kill(postgres, "postgres", global_deadline).await;
}

fn child_has_exited(child: &mut Child, component: &str) -> bool {
    match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            eprintln!(
                "component=appliance level=warn message=child-status-failed child={component} error={error}"
            );
            false
        }
    }
}

async fn wait_until(child: &mut Child, deadline: Instant, component: &str) -> bool {
    if child_has_exited(child, component) {
        return true;
    }
    match timeout(remaining(deadline), child.wait()).await {
        Ok(Ok(_)) => true,
        Ok(Err(error)) => {
            eprintln!(
                "component=appliance level=warn message=child-wait-failed child={component} error={error}"
            );
            false
        }
        Err(_) => false,
    }
}

async fn force_kill(mut child: Child, component: &str, global_deadline: Instant) {
    eprintln!("component=appliance level=warn message=forced-child-termination child={component}");
    let _ = child.start_kill();
    let deadline = capped_deadline(global_deadline, FORCED_REAP_GRACE);
    let _ = timeout(remaining(deadline), child.wait()).await;
}

fn capped_deadline(global_deadline: Instant, cap: Duration) -> Instant {
    global_deadline.min(Instant::now() + cap)
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn send_signal(pid: u32, signal: i32) {
    #[cfg(unix)]
    // SAFETY: `kill` does not dereference memory. The PID came from a live child.
    unsafe {
        libc::kill(pid as i32, signal);
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}

fn prepare_runtime() -> Result<()> {
    fs::create_dir_all(CADDY_CONFIG_DIR)?;
    fs::create_dir_all(CADDY_DATA_DIR)?;
    Ok(())
}

async fn initialize_postgres() -> Result<()> {
    migrate_legacy_postgres_data(
        Path::new(POSTGRES_DATA_DIR),
        Path::new(LEGACY_POSTGRES_DATA_DIR),
    )?;
    fs::create_dir_all(POSTGRES_SOCKET_DIR)?;
    let pgdata = Path::new(POSTGRES_DATA_DIR);
    let version_file = pgdata.join("PG_VERSION");
    if version_file.exists() {
        let found = fs::read_to_string(&version_file)?.trim().to_owned();
        if found != POSTGRES_MAJOR {
            return Err(invalid(format!(
                "PostgreSQL data major {found} cannot run with image major {POSTGRES_MAJOR}"
            ))
            .into());
        }
        return Ok(());
    }
    if pgdata.exists() && fs::read_dir(pgdata)?.next().is_some() {
        return Err(invalid(format!(
            "PostgreSQL data directory {} is non-empty but has no PG_VERSION",
            pgdata.display()
        ))
        .into());
    }
    fs::create_dir_all(pgdata)?;
    let mut command = Command::new("initdb");
    command
        .arg("-D")
        .arg(pgdata)
        .args([
            "--encoding=UTF8",
            "--locale=C",
            "--username=neoseq",
            "--auth-local=trust",
            "--auth-host=scram-sha-256",
            "--data-checksums",
        ])
        .kill_on_drop(true);
    successful(&mut command, "initdb").await
}

fn migrate_legacy_postgres_data(current: &Path, legacy: &Path) -> Result<()> {
    match (current.exists(), legacy.exists()) {
        (true, true) => Err(invalid(format!(
            "PostgreSQL data exists at both {} and {}; resolve the ambiguity before starting",
            current.display(),
            legacy.display()
        ))
        .into()),
        (false, true) => {
            fs::rename(legacy, current)?;
            eprintln!(
                "component=appliance level=info message=postgres-data-migrated from={} to={}",
                legacy.display(),
                current.display()
            );
            Ok(())
        }
        _ => Ok(()),
    }
}

fn start_postgres() -> Result<Child> {
    Ok(Command::new("postgres")
        .arg("-D")
        .arg(POSTGRES_DATA_DIR)
        .arg("-c")
        .arg("listen_addresses=")
        .arg("-c")
        .arg(format!("unix_socket_directories={POSTGRES_SOCKET_DIR}"))
        .arg("-c")
        .arg("unix_socket_permissions=0700")
        .stdin(Stdio::null())
        .spawn()?)
}

async fn wait_for_postgres(child: &mut Child) -> Result<()> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(invalid(format!("PostgreSQL exited during startup with {status}")).into());
        }
        let mut command = Command::new("pg_isready");
        command
            .arg("-h")
            .arg(POSTGRES_SOCKET_DIR)
            .args(["-U", POSTGRES_USER, "-d", "postgres", "-q"])
            .kill_on_drop(true);
        if command.status().await?.success() {
            return Ok(());
        }
        sleep(STARTUP_POLL_INTERVAL).await;
    }
}

async fn ensure_database() -> Result<()> {
    let mut inspect = Command::new("psql");
    inspect
        .arg("-h")
        .arg(POSTGRES_SOCKET_DIR)
        .args([
            "-U",
            POSTGRES_USER,
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname = 'neoseq'",
        ])
        .kill_on_drop(true);
    let output = inspect.output().await?;
    if !output.status.success() {
        return Err(invalid("could not inspect the embedded PostgreSQL cluster").into());
    }
    if String::from_utf8(output.stdout)?.trim() != "1" {
        let mut create = Command::new("createdb");
        create
            .arg("-h")
            .arg(POSTGRES_SOCKET_DIR)
            .args(["-U", POSTGRES_USER, POSTGRES_DATABASE])
            .kill_on_drop(true);
        successful(&mut create, "create Neoseq database").await?;
    }
    Ok(())
}

async fn wait_for_server(children: &mut Children) -> Result<()> {
    loop {
        check_startup_child(&mut children.server, "server")?;
        check_startup_child(&mut children.postgres, "postgres")?;
        if readiness_probe(SERVER_PORT).await {
            return Ok(());
        }
        sleep(STARTUP_POLL_INTERVAL).await;
    }
}

async fn wait_for_public_readiness(children: &mut Children) -> Result<()> {
    loop {
        check_startup_child(&mut children.ingress, "ingress")?;
        check_startup_child(&mut children.server, "server")?;
        check_startup_child(&mut children.postgres, "postgres")?;
        if readiness_probe(PUBLIC_PORT).await {
            return Ok(());
        }
        sleep(STARTUP_POLL_INTERVAL).await;
    }
}

fn check_startup_child(child: &mut Option<Child>, component: &str) -> Result<()> {
    if let Some(child) = child
        && let Some(status) = child.try_wait()?
    {
        return Err(invalid(format!("{component} exited during startup with {status}")).into());
    }
    Ok(())
}

async fn readiness_probe(port: u16) -> bool {
    tokio::task::spawn_blocking(move || readiness_probe_blocking(port))
        .await
        .unwrap_or(false)
}

fn readiness_probe_blocking(port: u16) -> bool {
    let timeout = Duration::from_secs(2);
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
        || write!(
            stream,
            "GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .is_err()
    {
        return false;
    }

    let mut response = Vec::new();
    if stream.take(8 * 1024).read_to_end(&mut response).is_err() {
        return false;
    }
    readiness_response(&response)
}

fn readiness_response(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return false;
    };
    response.starts_with(b"HTTP/1.1 200 ") && response[header_end + 4..] == *b"ready\n"
}

async fn health() -> Result<()> {
    if readiness_probe(PUBLIC_PORT).await {
        Ok(())
    } else {
        Err(invalid("appliance is not ready").into())
    }
}

async fn backup(database: Database, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(invalid(format!(
            "backup destination already exists: {}",
            destination.display()
        ))
        .into());
    }
    let temporary = destination.with_extension(format!(
        "{}.partial",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("dump")
    ));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let result = successful(
        Command::new("pg_dump")
            .args(["--format=custom", "--no-owner", "--file"])
            .arg(&temporary)
            .arg(database.url()),
        "database backup",
    )
    .await;
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, destination)?;
    eprintln!(
        "component=appliance level=info message=backup-complete path={}",
        destination.display()
    );
    Ok(())
}

async fn restore(config: RestoreConfig, source: &Path) -> Result<()> {
    if optional("NEOSEQ_RESTORE_CONFIRM").as_deref() != Some("replace-neoseq-data") {
        return Err(invalid(
            "set NEOSEQ_RESTORE_CONFIRM=replace-neoseq-data for destructive restore",
        )
        .into());
    }
    if !source.is_file() {
        return Err(invalid(format!("backup does not exist: {}", source.display())).into());
    }
    if [POSTGRES_DATA_DIR, LEGACY_POSTGRES_DATA_DIR]
        .iter()
        .any(|directory| Path::new(directory).join("postmaster.pid").exists())
    {
        return Err(invalid("restore requires a stopped PostgreSQL cluster").into());
    }

    prepare_runtime()?;
    let mut postgres = None;
    let startup = match timeout(config.startup_timeout, async {
        initialize_postgres().await?;
        postgres = Some(start_postgres()?);
        wait_for_postgres(postgres.as_mut().expect("PostgreSQL was just started")).await
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(invalid("timed out starting PostgreSQL for restore").into()),
    };
    if let Err(error) = startup {
        stop_postgres(&mut postgres, Instant::now() + SHUTDOWN_BUDGET).await;
        return Err(error);
    }

    let restore_result = async {
        successful(
            Command::new("dropdb")
                .arg("-h")
                .arg(POSTGRES_SOCKET_DIR)
                .args([
                    "-U",
                    POSTGRES_USER,
                    "--if-exists",
                    "--force",
                    POSTGRES_DATABASE,
                ]),
            "drop database for restore",
        )
        .await?;
        successful(
            Command::new("createdb")
                .arg("-h")
                .arg(POSTGRES_SOCKET_DIR)
                .args(["-U", POSTGRES_USER, POSTGRES_DATABASE]),
            "create database for restore",
        )
        .await?;
        successful(
            Command::new("pg_restore")
                .args(["--exit-on-error", "--no-owner", "--dbname"])
                .arg(EMBEDDED_DATABASE_URL)
                .arg(source),
            "database restore",
        )
        .await
    }
    .await;

    stop_postgres(&mut postgres, Instant::now() + SHUTDOWN_BUDGET).await;
    restore_result?;
    eprintln!("component=appliance level=info message=restore-complete");
    Ok(())
}

async fn successful(command: &mut Command, operation: &str) -> Result<()> {
    let status = command.status().await?;
    if status.success() {
        Ok(())
    } else {
        Err(invalid(format!("{operation} failed with {status}")).into())
    }
}

fn startup_timeout_from_environment() -> Result<Duration> {
    let seconds = env::var("NEOSEQ_STARTUP_TIMEOUT_SECONDS")
        .unwrap_or_else(|_| "60".into())
        .parse::<u64>()
        .map_err(|_| invalid("NEOSEQ_STARTUP_TIMEOUT_SECONDS must be an integer"))?;
    if seconds == 0 || seconds > 3_600 {
        return Err(invalid("NEOSEQ_STARTUP_TIMEOUT_SECONDS must be between 1 and 3600").into());
    }
    Ok(Duration::from_secs(seconds))
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn read_secret(path: &Path, name: &str) -> Result<String> {
    let mut value = fs::read_to_string(path)
        .map_err(|error| io::Error::new(error.kind(), format!("could not read {name}: {error}")))?;
    if value.ends_with("\r\n") {
        value.truncate(value.len() - 2);
    } else if value.ends_with('\n') {
        value.truncate(value.len() - 1);
    }
    Ok(value)
}

fn required_argument(
    arguments: &mut impl Iterator<Item = String>,
    description: &str,
) -> Result<String> {
    arguments
        .next()
        .ok_or_else(|| invalid(format!("missing {description}")).into())
}

fn no_more_arguments(mut arguments: impl Iterator<Item = String>) -> Result<()> {
    if arguments.next().is_some() {
        Err(invalid("unexpected command arguments").into())
    } else {
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    static ENVIRONMENT: Mutex<()> = Mutex::new(());
    const VARIABLES: &[&str] = &[
        "DATABASE_URL",
        "DATABASE_URL_FILE",
        "NEOSEQ_STARTUP_TIMEOUT_SECONDS",
        "NEOSEQ_RESTORE_CONFIRM",
    ];

    fn environment() -> MutexGuard<'static, ()> {
        let guard = ENVIRONMENT.lock().unwrap();
        for name in VARIABLES {
            // SAFETY: tests serialize all access to these process environment keys.
            unsafe { env::remove_var(name) };
        }
        guard
    }

    fn set(name: &str, value: &str) {
        // SAFETY: tests serialize all access to these process environment keys.
        unsafe { env::set_var(name, value) };
    }

    #[test]
    fn database_defaults_to_embedded() {
        let _guard = environment();
        assert_eq!(Database::from_environment().unwrap(), Database::Embedded);
    }

    #[test]
    fn database_url_selects_external_database() {
        let _guard = environment();
        set("DATABASE_URL", "postgresql://database.example/neoseq");
        assert_eq!(
            Database::from_environment().unwrap(),
            Database::External("postgresql://database.example/neoseq".into())
        );
    }

    #[test]
    fn database_url_file_selects_external_database() {
        let _guard = environment();
        let path = env::temp_dir().join(format!(
            "neoseq-appliance-database-url-{}",
            std::process::id()
        ));
        fs::write(&path, "postgresql://database.example/neoseq\n").unwrap();
        set("DATABASE_URL_FILE", path.to_str().unwrap());
        assert_eq!(
            Database::from_environment().unwrap(),
            Database::External("postgresql://database.example/neoseq".into())
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn database_url_sources_are_mutually_exclusive() {
        let _guard = environment();
        set("DATABASE_URL", "postgresql:///neoseq");
        set("DATABASE_URL_FILE", "/run/secrets/database-url");
        assert!(Database::from_environment().is_err());
    }

    #[test]
    fn startup_timeout_is_bounded() {
        let _guard = environment();
        set("NEOSEQ_STARTUP_TIMEOUT_SECONDS", "0");
        assert!(ServeConfig::from_environment().is_err());
        set("NEOSEQ_STARTUP_TIMEOUT_SECONDS", "3601");
        assert!(ServeConfig::from_environment().is_err());
        set("NEOSEQ_STARTUP_TIMEOUT_SECONDS", "75");
        assert_eq!(
            ServeConfig::from_environment().unwrap().startup_timeout,
            Duration::from_secs(75)
        );
    }

    #[test]
    fn restore_rejects_external_database_configuration() {
        let _guard = environment();
        set("DATABASE_URL", "postgresql:///neoseq");
        assert!(RestoreConfig::from_environment().is_err());
    }

    #[test]
    fn migrates_only_the_unambiguous_legacy_postgres_directory() {
        let _guard = environment();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "neoseq-appliance-postgres-migration-{}-{nonce}",
            std::process::id(),
        ));
        let current = root.join("data");
        let legacy = root.join("17/data");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("PG_VERSION"), "17\n").unwrap();

        migrate_legacy_postgres_data(&current, &legacy).unwrap();
        assert_eq!(
            fs::read_to_string(current.join("PG_VERSION")).unwrap(),
            "17\n"
        );
        assert!(!legacy.exists());

        fs::create_dir_all(&legacy).unwrap();
        assert!(migrate_legacy_postgres_data(&current, &legacy).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readiness_requires_success_and_the_expected_body() {
        let ready = b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nready\n";
        assert!(readiness_response(ready));

        let unavailable = b"HTTP/1.1 503 Service Unavailable\r\n\r\nnot ready\n";
        assert!(!readiness_response(unavailable));
        assert!(!readiness_response(b"HTTP/1.1 200 OK\r\n\r\nok\n"));
    }
}
