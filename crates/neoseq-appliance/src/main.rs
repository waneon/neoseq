use std::{
    env,
    error::Error,
    fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout},
};
use url::Url;

const POSTGRES_MAJOR: &str = "17";
const POSTGRES_USER: &str = "neoseq";
const POSTGRES_DATABASE: &str = "neoseq";
const INTERNAL_SERVER: &str = "http://127.0.0.1:8787";
const INGRESS_HEALTH_PATH: &str = "/__neoseq/health";
const INGRESS_HEALTH_RESPONSE: &str = "neoseq ingress ready";
const RUNTIME_CONFIG_PATH: &str = "/__neoseq/config.json";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DatabaseMode {
    Embedded,
    External,
    Disabled,
}

#[derive(Debug, Clone)]
struct Config {
    enable_client: bool,
    enable_server: bool,
    enable_dashboard: bool,
    database_mode: DatabaseMode,
    database_url: Option<String>,
    neoseq_url: Option<String>,
    upstream_origin: Option<String>,
    http_listen: SocketAddr,
    dashboard_listen: SocketAddr,
    startup_timeout: Duration,
    state_dir: PathBuf,
    pgdata: PathBuf,
    postgres_socket_dir: PathBuf,
    client_root: PathBuf,
    dashboard_root: PathBuf,
}

impl Config {
    fn from_environment() -> Result<Self> {
        let enable_client = boolean("NEOSEQ_ENABLE_CLIENT", true)?;
        let enable_server = boolean("NEOSEQ_ENABLE_SERVER", true)?;
        let enable_dashboard = boolean("NEOSEQ_ENABLE_DASHBOARD", true)?;
        let database_mode = match value("NEOSEQ_DATABASE_MODE", "embedded").as_str() {
            "embedded" => DatabaseMode::Embedded,
            "external" => DatabaseMode::External,
            "disabled" => DatabaseMode::Disabled,
            other => {
                return Err(invalid(format!(
                    "NEOSEQ_DATABASE_MODE must be embedded, external, or disabled; got {other:?}"
                ))
                .into());
            }
        };
        let direct_url = optional("DATABASE_URL");
        let url_file = optional("DATABASE_URL_FILE");
        if direct_url.is_some() && url_file.is_some() {
            return Err(
                invalid("DATABASE_URL and DATABASE_URL_FILE are mutually exclusive").into(),
            );
        }
        let database_url = match (direct_url, url_file) {
            (Some(url), None) => Some(url),
            (None, Some(path)) => Some(read_secret(Path::new(&path), "DATABASE_URL_FILE")?),
            (None, None) => None,
            (Some(_), Some(_)) => unreachable!(),
        };
        match database_mode {
            DatabaseMode::Embedded if database_url.is_some() => {
                return Err(invalid(
                    "DATABASE_URL is owned by the appliance in embedded database mode",
                )
                .into());
            }
            DatabaseMode::External if database_url.is_none() => {
                return Err(invalid(
                    "DATABASE_URL_FILE or DATABASE_URL is required in external database mode",
                )
                .into());
            }
            DatabaseMode::Disabled if database_url.is_some() => {
                return Err(invalid(
                    "DATABASE_URL cannot be set when NEOSEQ_DATABASE_MODE is disabled",
                )
                .into());
            }
            _ => {}
        }
        if enable_server && database_mode == DatabaseMode::Disabled {
            return Err(invalid("the server cannot run with the database disabled").into());
        }

        let neoseq_url = optional("NEOSEQ_URL")
            .map(canonical_neoseq_url)
            .transpose()?;

        let upstream_origin = optional("NEOSEQ_UPSTREAM_ORIGIN");
        if enable_server && upstream_origin.is_some() {
            return Err(invalid(
                "NEOSEQ_UPSTREAM_ORIGIN cannot be set while the internal server is enabled",
            )
            .into());
        }
        if let Some(origin) = &upstream_origin
            && !(origin.starts_with("http://") || origin.starts_with("https://"))
        {
            return Err(invalid("NEOSEQ_UPSTREAM_ORIGIN must be an HTTP or HTTPS origin").into());
        }
        if enable_dashboard && !enable_server && upstream_origin.is_none() {
            return Err(invalid(
                "the dashboard requires the internal server or NEOSEQ_UPSTREAM_ORIGIN",
            )
            .into());
        }

        let http_listen = socket("NEOSEQ_HTTP_LISTEN", "0.0.0.0:8080")?;
        let dashboard_listen = socket("NEOSEQ_DASHBOARD_LISTEN", "0.0.0.0:8081")?;
        let main_ingress = enable_client || enable_server || upstream_origin.is_some();
        if enable_dashboard && main_ingress && http_listen == dashboard_listen {
            return Err(invalid("client/API and dashboard listeners must be distinct").into());
        }
        if !main_ingress && !enable_dashboard && database_mode != DatabaseMode::Embedded {
            return Err(invalid("the configuration enables no appliance component").into());
        }

        let startup_seconds = value("NEOSEQ_STARTUP_TIMEOUT_SECONDS", "60")
            .parse::<u64>()
            .map_err(|_| invalid("NEOSEQ_STARTUP_TIMEOUT_SECONDS must be an integer"))?;
        if startup_seconds == 0 || startup_seconds > 3_600 {
            return Err(
                invalid("NEOSEQ_STARTUP_TIMEOUT_SECONDS must be between 1 and 3600").into(),
            );
        }

        Ok(Self {
            enable_client,
            enable_server,
            enable_dashboard,
            database_mode,
            database_url,
            neoseq_url,
            upstream_origin,
            http_listen,
            dashboard_listen,
            startup_timeout: Duration::from_secs(startup_seconds),
            state_dir: path("NEOSEQ_STATE_DIR", "/run/neoseq"),
            pgdata: path(
                "NEOSEQ_POSTGRES_DATA_DIR",
                "/var/lib/neoseq/postgres/17/data",
            ),
            postgres_socket_dir: path("NEOSEQ_POSTGRES_SOCKET_DIR", "/run/neoseq/postgres"),
            client_root: path("NEOSEQ_CLIENT_ROOT", "/srv/neoseq/client"),
            dashboard_root: path("NEOSEQ_DASHBOARD_ROOT", "/srv/neoseq/dashboard"),
        })
    }

    fn main_ingress(&self) -> bool {
        self.enable_client || self.backend_origin().is_some()
    }

    fn ingress(&self) -> bool {
        self.main_ingress() || self.enable_dashboard
    }

    fn backend_origin(&self) -> Option<&str> {
        if self.enable_server {
            Some(INTERNAL_SERVER)
        } else {
            self.upstream_origin.as_deref()
        }
    }

    fn embedded_database_url(&self) -> String {
        format!(
            "postgresql:///{POSTGRES_DATABASE}?host={}&user={POSTGRES_USER}",
            self.postgres_socket_dir.display()
        )
    }

    fn server_database_url(&self) -> Result<String> {
        match self.database_mode {
            DatabaseMode::Embedded => Ok(self.embedded_database_url()),
            DatabaseMode::External => self
                .database_url
                .clone()
                .ok_or_else(|| invalid("external database URL is missing").into()),
            DatabaseMode::Disabled => Err(invalid("database is disabled").into()),
        }
    }

    fn caddyfile(&self) -> String {
        let mut output = String::from(
            "{\n\tadmin off\n\tauto_https off\n\tlog default {\n\t\toutput stdout\n\t\tformat json\n\t}\n}\n\n",
        );
        if self.main_ingress() {
            let runtime_config = self.enable_client.then(|| self.runtime_config());
            output.push_str(&site(
                self.http_listen,
                self.backend_origin(),
                self.enable_client.then_some(self.client_root.as_path()),
                runtime_config.as_deref(),
            ));
        }
        if self.enable_dashboard {
            output.push_str(&site(
                self.dashboard_listen,
                self.backend_origin(),
                Some(self.dashboard_root.as_path()),
                None,
            ));
        }
        output.truncate(output.trim_end().len());
        output.push('\n');
        output
    }

    fn runtime_config(&self) -> String {
        match &self.neoseq_url {
            Some(url) => serde_json::json!({ "url": url }).to_string(),
            None => serde_json::json!({}).to_string(),
        }
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
            serve(Config::from_environment()?).await
        }
        "health" => {
            no_more_arguments(arguments)?;
            health(&Config::from_environment()?).await
        }
        "doctor" => {
            no_more_arguments(arguments)?;
            doctor(&Config::from_environment()?)
        }
        "backup" => {
            let destination = required_argument(&mut arguments, "backup destination")?;
            no_more_arguments(arguments)?;
            backup(&Config::from_environment()?, Path::new(&destination)).await
        }
        "restore" => {
            let source = required_argument(&mut arguments, "backup source")?;
            no_more_arguments(arguments)?;
            restore(&Config::from_environment()?, Path::new(&source)).await
        }
        _ => Err(invalid(
            "usage: neoseq-appliance [serve|health|doctor|backup <path>|restore <path>]",
        )
        .into()),
    }
}

async fn serve(config: Config) -> Result<()> {
    prepare_state(&config)?;
    doctor(&config)?;
    let mut children = Children::new();

    if let Err(error) = start_components(&config, &mut children).await {
        shutdown(&config, &mut children).await;
        return Err(error);
    }

    if let Err(error) = fs::write(config.state_dir.join("ready"), b"ready\n") {
        shutdown(&config, &mut children).await;
        return Err(error.into());
    }
    eprintln!("component=appliance level=info message=ready");

    let event = wait_for_event(&mut children).await;
    let _ = fs::remove_file(config.state_dir.join("ready"));
    match event {
        Event::Shutdown => {
            eprintln!("component=appliance level=info message=shutdown-requested");
            shutdown(&config, &mut children).await;
            Ok(())
        }
        Event::Exited(component, status) => {
            eprintln!(
                "component=appliance level=error message=child-exited child={component} status={status}"
            );
            shutdown(&config, &mut children).await;
            Err(invalid(format!("enabled child {component} exited unexpectedly")).into())
        }
        Event::WaitFailed(component, error) => {
            shutdown(&config, &mut children).await;
            Err(io::Error::new(
                error.kind(),
                format!("could not wait for {component}: {error}"),
            )
            .into())
        }
    }
}

async fn start_components(config: &Config, children: &mut Children) -> Result<()> {
    let database_url = if config.database_mode == DatabaseMode::Embedded {
        initialize_postgres(config).await?;
        let mut postgres = start_postgres(config)?;
        write_pid(config, "postgres", &postgres)?;
        wait_for_postgres(config, &mut postgres).await?;
        ensure_database(config).await?;
        children.postgres = Some(postgres);
        Some(config.embedded_database_url())
    } else {
        config.database_url.clone()
    };

    if config.enable_server {
        let mut server = Command::new("neoseq-server")
            .env(
                "DATABASE_URL",
                database_url.ok_or_else(|| invalid("server database URL is missing"))?,
            )
            .env("NEOSEQ_BIND", "127.0.0.1:8787")
            .stdin(Stdio::null())
            .spawn()?;
        write_pid(config, "server", &server)?;
        wait_for_http(
            "server",
            "http://127.0.0.1:8787/readyz",
            None,
            &mut server,
            config.startup_timeout,
        )
        .await?;
        children.server = Some(server);
    }

    if config.ingress() {
        let caddy_dir = config.state_dir.join("caddy");
        fs::create_dir_all(&caddy_dir)?;
        let caddyfile = caddy_dir.join("Caddyfile");
        fs::write(&caddyfile, config.caddyfile())?;
        let mut ingress = Command::new("caddy")
            .args(["run", "--config"])
            .arg(&caddyfile)
            .args(["--adapter", "caddyfile"])
            .env("XDG_CONFIG_HOME", caddy_dir.join("config"))
            .env("XDG_DATA_HOME", caddy_dir.join("data"))
            .stdin(Stdio::null())
            .spawn()?;
        write_pid(config, "ingress", &ingress)?;
        if config.main_ingress() {
            wait_for_http(
                "main ingress",
                &ingress_health_url(config.http_listen),
                Some(INGRESS_HEALTH_RESPONSE),
                &mut ingress,
                config.startup_timeout,
            )
            .await?;
            if config.enable_client {
                wait_for_http(
                    "client ingress",
                    &format!("{}/", health_origin(config.http_listen)),
                    None,
                    &mut ingress,
                    config.startup_timeout,
                )
                .await?;
            }
            if config.backend_origin().is_some() {
                wait_for_http(
                    "public API ingress",
                    &format!("{}/readyz", health_origin(config.http_listen)),
                    None,
                    &mut ingress,
                    config.startup_timeout,
                )
                .await?;
            }
        }
        if config.enable_dashboard {
            wait_for_http(
                "dashboard ingress",
                &ingress_health_url(config.dashboard_listen),
                Some(INGRESS_HEALTH_RESPONSE),
                &mut ingress,
                config.startup_timeout,
            )
            .await?;
            wait_for_http(
                "dashboard application",
                &format!("{}/", health_origin(config.dashboard_listen)),
                None,
                &mut ingress,
                config.startup_timeout,
            )
            .await?;
        }
        children.ingress = Some(ingress);
    }

    Ok(())
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

async fn shutdown(config: &Config, children: &mut Children) {
    terminate(&mut children.ingress, libc::SIGTERM, "ingress").await;
    terminate(&mut children.server, libc::SIGTERM, "server").await;
    if let Some(postgres) = &mut children.postgres {
        if postgres.try_wait().ok().flatten().is_none() {
            let status = Command::new("pg_ctl")
                .arg("-D")
                .arg(&config.pgdata)
                .args(["-m", "fast", "-t", "20", "-w", "stop"])
                .status()
                .await;
            if !matches!(status, Ok(status) if status.success()) {
                eprintln!("component=appliance level=warn message=postgres-fast-stop-failed");
                terminate(&mut children.postgres, libc::SIGINT, "postgres").await;
                return;
            }
        }
        wait_or_kill(&mut children.postgres, "postgres").await;
    }
}

async fn terminate(child: &mut Option<Child>, signal: i32, component: &str) {
    let Some(process) = child.as_mut() else {
        return;
    };
    if process.try_wait().ok().flatten().is_none()
        && let Some(pid) = process.id()
    {
        send_signal(pid, signal);
    }
    wait_or_kill(child, component).await;
}

async fn wait_or_kill(child: &mut Option<Child>, component: &str) {
    let Some(process) = child.as_mut() else {
        return;
    };
    if timeout(SHUTDOWN_TIMEOUT, process.wait()).await.is_err() {
        eprintln!(
            "component=appliance level=warn message=forced-child-termination child={component}"
        );
        let _ = process.start_kill();
        let _ = process.wait().await;
    }
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

fn prepare_state(config: &Config) -> Result<()> {
    fs::create_dir_all(&config.state_dir)?;
    for entry in ["ready", "postgres.pid", "server.pid", "ingress.pid"] {
        let _ = fs::remove_file(config.state_dir.join(entry));
    }
    Ok(())
}

async fn initialize_postgres(config: &Config) -> Result<()> {
    fs::create_dir_all(&config.postgres_socket_dir)?;
    let version_file = config.pgdata.join("PG_VERSION");
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
    if config.pgdata.exists() && fs::read_dir(&config.pgdata)?.next().is_some() {
        return Err(invalid(format!(
            "PostgreSQL data directory {} is non-empty but has no PG_VERSION",
            config.pgdata.display()
        ))
        .into());
    }
    fs::create_dir_all(&config.pgdata)?;
    successful(
        Command::new("initdb").arg("-D").arg(&config.pgdata).args([
            "--encoding=UTF8",
            "--locale=C",
            "--username=neoseq",
            "--auth-local=trust",
            "--auth-host=scram-sha-256",
            "--data-checksums",
        ]),
        "initdb",
    )
    .await
}

fn start_postgres(config: &Config) -> Result<Child> {
    Ok(Command::new("postgres")
        .arg("-D")
        .arg(&config.pgdata)
        .arg("-c")
        .arg("listen_addresses=")
        .arg("-c")
        .arg(format!(
            "unix_socket_directories={}",
            config.postgres_socket_dir.display()
        ))
        .arg("-c")
        .arg("unix_socket_permissions=0700")
        .stdin(Stdio::null())
        .spawn()?)
}

async fn wait_for_postgres(config: &Config, child: &mut Child) -> Result<()> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(invalid(format!("PostgreSQL exited during startup with {status}")).into());
        }
        if Command::new("pg_isready")
            .arg("-h")
            .arg(&config.postgres_socket_dir)
            .args(["-U", POSTGRES_USER, "-d", "postgres", "-q"])
            .status()
            .await?
            .success()
        {
            return Ok(());
        }
        if started.elapsed() >= config.startup_timeout {
            return Err(invalid("timed out waiting for PostgreSQL readiness").into());
        }
        sleep(Duration::from_millis(250)).await;
    }
}

async fn ensure_database(config: &Config) -> Result<()> {
    let output = Command::new("psql")
        .arg("-h")
        .arg(&config.postgres_socket_dir)
        .args([
            "-U",
            POSTGRES_USER,
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname = 'neoseq'",
        ])
        .output()
        .await?;
    if !output.status.success() {
        return Err(invalid("could not inspect the embedded PostgreSQL cluster").into());
    }
    if String::from_utf8(output.stdout)?.trim() != "1" {
        successful(
            Command::new("createdb")
                .arg("-h")
                .arg(&config.postgres_socket_dir)
                .args(["-U", POSTGRES_USER, POSTGRES_DATABASE]),
            "create Neoseq database",
        )
        .await?;
    }
    Ok(())
}

async fn wait_for_http(
    component: &str,
    url: &str,
    expected_body: Option<&str>,
    child: &mut Child,
    limit: Duration,
) -> Result<()> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(invalid(format!("{component} exited during startup with {status}")).into());
        }
        if http_ready(url, expected_body).await {
            return Ok(());
        }
        if started.elapsed() >= limit {
            return Err(invalid(format!("timed out waiting for {component} at {url}")).into());
        }
        sleep(Duration::from_millis(250)).await;
    }
}

async fn http_ready(url: &str, expected_body: Option<&str>) -> bool {
    let Ok(output) = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--max-time", "2", url])
        .stderr(Stdio::null())
        .output()
        .await
    else {
        return false;
    };
    output.status.success()
        && expected_body.is_none_or(|expected| output.stdout.as_slice() == expected.as_bytes())
}

async fn health(config: &Config) -> Result<()> {
    if !config.state_dir.join("ready").is_file() {
        return Err(invalid("appliance has not reached readiness").into());
    }
    for component in ["postgres", "server", "ingress"] {
        let path = config.state_dir.join(format!("{component}.pid"));
        if path.exists() {
            let pid = fs::read_to_string(&path)?
                .trim()
                .parse::<u32>()
                .map_err(|_| invalid(format!("invalid {component} PID record")))?;
            if !pid_running(pid) {
                return Err(invalid(format!("{component} process is not running")).into());
            }
        }
    }
    if config.database_mode == DatabaseMode::Embedded
        && !Command::new("pg_isready")
            .arg("-h")
            .arg(&config.postgres_socket_dir)
            .args(["-U", POSTGRES_USER, "-d", POSTGRES_DATABASE, "-q"])
            .status()
            .await?
            .success()
    {
        return Err(invalid("embedded PostgreSQL is not ready").into());
    }
    if config.enable_server && !http_ready("http://127.0.0.1:8787/readyz", None).await {
        return Err(invalid("server is not ready").into());
    }
    if config.main_ingress()
        && !http_ready(
            &ingress_health_url(config.http_listen),
            Some(INGRESS_HEALTH_RESPONSE),
        )
        .await
    {
        return Err(invalid("main ingress is not ready").into());
    }
    if config.enable_client
        && !http_ready(&format!("{}/", health_origin(config.http_listen)), None).await
    {
        return Err(invalid("client ingress is not ready").into());
    }
    if config.backend_origin().is_some()
        && !http_ready(
            &format!("{}/readyz", health_origin(config.http_listen)),
            None,
        )
        .await
    {
        return Err(invalid("public API ingress is not ready").into());
    }
    if config.enable_dashboard
        && !http_ready(
            &ingress_health_url(config.dashboard_listen),
            Some(INGRESS_HEALTH_RESPONSE),
        )
        .await
    {
        return Err(invalid("dashboard ingress is not ready").into());
    }
    if config.enable_dashboard
        && !http_ready(
            &format!("{}/", health_origin(config.dashboard_listen)),
            None,
        )
        .await
    {
        return Err(invalid("dashboard application is not ready").into());
    }
    Ok(())
}

fn doctor(config: &Config) -> Result<()> {
    for command in ["curl", "caddy", "pg_dump", "pg_restore"] {
        executable(command)?;
    }
    if config.database_mode == DatabaseMode::Embedded {
        for command in [
            "initdb",
            "postgres",
            "pg_ctl",
            "pg_isready",
            "psql",
            "createdb",
            "dropdb",
        ] {
            executable(command)?;
        }
        if config.pgdata.join("PG_VERSION").exists() {
            let found = fs::read_to_string(config.pgdata.join("PG_VERSION"))?;
            if found.trim() != POSTGRES_MAJOR {
                return Err(invalid(format!(
                    "PostgreSQL data major {} does not match image major {POSTGRES_MAJOR}",
                    found.trim()
                ))
                .into());
            }
        }
    }
    if config.enable_server {
        executable("neoseq-server")?;
    }
    if config.enable_client && !config.client_root.join("index.html").is_file() {
        return Err(invalid(format!(
            "client release is missing from {}",
            config.client_root.display()
        ))
        .into());
    }
    if config.enable_dashboard && !config.dashboard_root.join("index.html").is_file() {
        return Err(invalid(format!(
            "dashboard release is missing from {}",
            config.dashboard_root.display()
        ))
        .into());
    }
    eprintln!(
        "component=appliance level=info message=configuration-valid client={} server={} dashboard={} database={:?}",
        config.enable_client, config.enable_server, config.enable_dashboard, config.database_mode
    );
    Ok(())
}

async fn backup(config: &Config, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(invalid(format!(
            "backup destination already exists: {}",
            destination.display()
        ))
        .into());
    }
    let url = config.server_database_url()?;
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
            .arg(&url),
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

async fn restore(config: &Config, source: &Path) -> Result<()> {
    if config.database_mode != DatabaseMode::Embedded {
        return Err(invalid("restore is supported only for embedded PostgreSQL").into());
    }
    if optional("NEOSEQ_RESTORE_CONFIRM").as_deref() != Some("replace-neoseq-data") {
        return Err(invalid(
            "set NEOSEQ_RESTORE_CONFIRM=replace-neoseq-data for destructive restore",
        )
        .into());
    }
    if !source.is_file() {
        return Err(invalid(format!("backup does not exist: {}", source.display())).into());
    }
    if config.state_dir.join("ready").exists() || config.pgdata.join("postmaster.pid").exists() {
        return Err(invalid("restore requires a stopped appliance and PostgreSQL cluster").into());
    }

    prepare_state(config)?;
    initialize_postgres(config).await?;
    let mut postgres = start_postgres(config)?;
    let restore_result = async {
        wait_for_postgres(config, &mut postgres).await?;
        ensure_database(config).await?;
        successful(
            Command::new("dropdb")
                .arg("-h")
                .arg(&config.postgres_socket_dir)
                .args(["-U", POSTGRES_USER, "--force", POSTGRES_DATABASE]),
            "drop database for restore",
        )
        .await?;
        successful(
            Command::new("createdb")
                .arg("-h")
                .arg(&config.postgres_socket_dir)
                .args(["-U", POSTGRES_USER, POSTGRES_DATABASE]),
            "create database for restore",
        )
        .await?;
        successful(
            Command::new("pg_restore")
                .args(["--exit-on-error", "--no-owner", "--dbname"])
                .arg(config.embedded_database_url())
                .arg(source),
            "database restore",
        )
        .await
    }
    .await;

    let _ = Command::new("pg_ctl")
        .arg("-D")
        .arg(&config.pgdata)
        .args(["-m", "fast", "-t", "20", "-w", "stop"])
        .status()
        .await;
    let _ = postgres.wait().await;
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

fn site(
    listen: SocketAddr,
    backend: Option<&str>,
    root: Option<&Path>,
    runtime_config: Option<&str>,
) -> String {
    let bind = match listen.ip() {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => format!("[{address}]"),
    };
    let response =
        serde_json::to_string(INGRESS_HEALTH_RESPONSE).expect("serialize health response");
    let mut output = format!(
        "http://:{} {{\n\tbind {bind}\n\tlog\n\tencode zstd gzip\n\thandle {INGRESS_HEALTH_PATH} {{\n\t\trespond {response} 200\n\t}}\n",
        listen.port()
    );
    if let Some(runtime_config) = runtime_config {
        let runtime_config =
            serde_json::to_string(runtime_config).expect("serialize runtime configuration");
        output.push_str(&format!(
            "\thandle {RUNTIME_CONFIG_PATH} {{\n\t\theader Content-Type \"application/json\"\n\t\theader Cache-Control \"no-store\"\n\t\trespond {runtime_config} 200\n\t}}\n"
        ));
    }
    if let Some(backend) = backend {
        let backend = serde_json::to_string(backend).expect("serialize backend origin");
        for path in ["/v1/*", "/livez", "/readyz"] {
            output.push_str(&format!(
                "\thandle {path} {{\n\t\treverse_proxy {backend}\n\t}}\n"
            ));
        }
    }
    if let Some(root) = root {
        let root = serde_json::to_string(&root.display().to_string()).expect("serialize root path");
        output.push_str(&format!(
            "\thandle {{\n\t\troot * {root}\n\t\ttry_files {{path}} /index.html\n\t\tfile_server\n\t}}\n"
        ));
    } else {
        output.push_str("\thandle {\n\t\trespond \"not found\" 404\n\t}\n");
    }
    output.push_str("}\n\n");
    output
}

fn health_origin(listen: SocketAddr) -> String {
    let address = match listen.ip() {
        IpAddr::V4(address) if address.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(address) if address.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        address => address,
    };
    format!("http://{}", SocketAddr::new(address, listen.port()))
}

fn ingress_health_url(listen: SocketAddr) -> String {
    format!("{}{INGRESS_HEALTH_PATH}", health_origin(listen))
}

fn write_pid(config: &Config, component: &str, child: &Child) -> Result<()> {
    let pid = child
        .id()
        .ok_or_else(|| invalid(format!("{component} has no process ID")))?;
    fs::write(
        config.state_dir.join(format!("{component}.pid")),
        pid.to_string(),
    )?;
    Ok(())
}

fn pid_running(pid: u32) -> bool {
    #[cfg(unix)]
    // SAFETY: signal zero performs a process-existence check and dereferences no memory.
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn executable(command: &str) -> Result<()> {
    let path = env::var_os("PATH").unwrap_or_default();
    if env::split_paths(&path).any(|directory| directory.join(command).is_file()) {
        Ok(())
    } else {
        Err(invalid(format!(
            "required executable is missing from PATH: {command}"
        ))
        .into())
    }
}

fn boolean(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) => match value.as_str() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(invalid(format!(
                "{name} must be true, false, 1, or 0; got {value:?}"
            ))
            .into()),
        },
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error.into()),
    }
}

fn socket(name: &str, default: &str) -> Result<SocketAddr> {
    value(name, default)
        .parse()
        .map_err(|_| invalid(format!("{name} must be an IP socket address")).into())
}

fn path(name: &str, default: &str) -> PathBuf {
    PathBuf::from(value(name, default))
}

fn value(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.into())
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn canonical_neoseq_url(value: String) -> Result<String> {
    let url = Url::parse(&value).map_err(|_| invalid("NEOSEQ_URL must be an absolute URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("NEOSEQ_URL must use HTTP or HTTPS").into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("NEOSEQ_URL must not contain credentials").into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            invalid("NEOSEQ_URL must be an origin without a path, query, or fragment").into(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| invalid("NEOSEQ_URL must contain a host"))?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if url.scheme() != "https" && !local {
        return Err(invalid("NEOSEQ_URL requires HTTPS for non-local hosts").into());
    }
    Ok(url.origin().ascii_serialization())
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
        "NEOSEQ_ENABLE_CLIENT",
        "NEOSEQ_ENABLE_SERVER",
        "NEOSEQ_ENABLE_DASHBOARD",
        "NEOSEQ_DATABASE_MODE",
        "DATABASE_URL",
        "DATABASE_URL_FILE",
        "NEOSEQ_URL",
        "NEOSEQ_UPSTREAM_ORIGIN",
        "NEOSEQ_HTTP_LISTEN",
        "NEOSEQ_DASHBOARD_LISTEN",
        "NEOSEQ_STARTUP_TIMEOUT_SECONDS",
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
    fn all_application_components_default_to_enabled() {
        let _guard = environment();
        let config = Config::from_environment().unwrap();
        assert!(config.enable_client);
        assert!(config.enable_server);
        assert!(config.enable_dashboard);
        assert_eq!(config.database_mode, DatabaseMode::Embedded);
        assert_eq!(config.neoseq_url, None);
    }

    #[test]
    fn validates_and_canonicalizes_neoseq_url() {
        let _guard = environment();
        set("NEOSEQ_URL", "https://NEOSEQ.example.test:443/");
        let config = Config::from_environment().unwrap();
        assert_eq!(
            config.neoseq_url.as_deref(),
            Some("https://neoseq.example.test")
        );
        assert!(
            config
                .caddyfile()
                .contains("respond \"{\\\"url\\\":\\\"https://neoseq.example.test\\\"}\" 200")
        );

        set("NEOSEQ_URL", "https://neoseq.example.test/notes");
        assert!(Config::from_environment().is_err());

        set("NEOSEQ_URL", "http://neoseq.example.test");
        assert!(Config::from_environment().is_err());
    }

    #[test]
    fn rejects_ambiguous_or_incomplete_dependencies() {
        let _guard = environment();
        set("NEOSEQ_DATABASE_MODE", "external");
        assert!(Config::from_environment().is_err());

        set("DATABASE_URL", "postgresql:///neoseq");
        set("NEOSEQ_ENABLE_SERVER", "false");
        assert!(Config::from_environment().is_err());

        set("NEOSEQ_UPSTREAM_ORIGIN", "https://sync.example.test");
        assert!(Config::from_environment().is_ok());
    }

    #[test]
    fn caddy_keeps_the_two_rooted_apps_on_distinct_sites() {
        let _guard = environment();
        let config = Config::from_environment().unwrap();
        let caddyfile = config.caddyfile();
        assert!(caddyfile.contains("http://:8080 {\n\tbind 0.0.0.0"));
        assert!(caddyfile.contains("http://:8081 {\n\tbind 0.0.0.0"));
        assert!(caddyfile.contains("/srv/neoseq/client"));
        assert!(caddyfile.contains("/srv/neoseq/dashboard"));
        assert_eq!(caddyfile.matches(RUNTIME_CONFIG_PATH).count(), 1);
        assert!(caddyfile.contains("respond \"{}\" 200"));
        assert_eq!(caddyfile.matches("handle /v1/*").count(), 2);
        assert_eq!(caddyfile.matches("handle /__neoseq/health").count(), 2);
    }

    #[test]
    fn caddy_separates_listener_binding_from_host_matching() {
        let ipv4 = site("127.0.0.1:8080".parse().unwrap(), None, None, None);
        assert!(ipv4.starts_with("http://:8080 {\n\tbind 127.0.0.1\n"));

        let ipv6 = site("[::1]:8081".parse().unwrap(), None, None, None);
        assert!(ipv6.starts_with("http://:8081 {\n\tbind [::1]\n"));
        assert!(ipv6.contains("respond \"neoseq ingress ready\" 200"));
    }

    #[test]
    fn listener_health_uses_loopback_for_wildcard_binds() {
        assert_eq!(
            health_origin("0.0.0.0:8080".parse().unwrap()),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            health_origin("[::]:8080".parse().unwrap()),
            "http://[::1]:8080"
        );
        assert_eq!(
            ingress_health_url("0.0.0.0:8080".parse().unwrap()),
            "http://127.0.0.1:8080/__neoseq/health"
        );
    }
}
