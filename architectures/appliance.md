# All-in-One Appliance Architecture

## Boundary

The Neoseq appliance is the supported single-container distribution for personal
servers and on-premises installations. One immutable Linux OCI image contains the
release client, dashboard, server, ingress, and PostgreSQL binaries. The container
is one failure and upgrade boundary, while PostgreSQL remains the only durable
application state.

The appliance controller owns initialization, dependency ordering, health, child
process supervision, and ordered shutdown. `tini` is PID 1 and forwards container
signals to the controller. Any unexpected exit of an enabled child terminates the
whole appliance; the container runtime owns restart policy.

The image entrypoint begins with elevated privileges only to reconcile the fixed
runtime and persistent directories with `NEOSEQ_UID` and `NEOSEQ_GID`, both of
which default to `10001`. It then irreversibly drops supplementary groups,
capabilities, UID, and GID before replacing itself with `tini`. UID and GID zero
and malformed identities are rejected. No application child runs as root.

## Runtime Shape

```text
:8080 ── ingress ── client files
           └─────── /v1, /livez, /readyz ──┐
                                           ├──> neoseq-server :8787
:8081 ── ingress ── dashboard files ───────┘          │
                                                      └──> PostgreSQL socket
```

The client and dashboard own separate listeners because both static applications
are rooted at `/`. Ingress is the only public network boundary. The server binds
loopback, and embedded PostgreSQL accepts only local Unix-socket connections.
TLS terminates at an operator-managed reverse proxy in front of the container.

## Configuration

`NEOSEQ_URL` optionally defines the canonical browser-facing origin of the
deployment, which the appliance offers to runtime clients as their default
server URL. It must be a bare HTTP or HTTPS origin; plain HTTP is accepted
because a personal appliance on a private network has no certificate, and TLS
belongs to the reverse proxy in front of the container once the server is
reachable beyond that network. Without it, browser clients use their current
origin.

`NEOSEQ_ENABLE_CLIENT`, `NEOSEQ_ENABLE_SERVER`, and
`NEOSEQ_ENABLE_DASHBOARD` are strict booleans and default to `true`.
`NEOSEQ_DATABASE_MODE` is `embedded` by default and may be `external` or
`disabled`. An enabled server requires either embedded PostgreSQL or an external
URL supplied by `DATABASE_URL_FILE` or `DATABASE_URL`. An enabled dashboard
requires the internal server or `NEOSEQ_UPSTREAM_ORIGIN`.

`NEOSEQ_HTTP_LISTEN` and `NEOSEQ_DASHBOARD_LISTEN` select the public listeners;
the defaults are `0.0.0.0:8080` and `0.0.0.0:8081`. The controller rejects
invalid values and impossible component combinations before starting a child.
Listener addresses determine socket binding only; ingress accepts every HTTP
Host so localhost, IP addresses, and operator-managed domains behave alike. The
external reverse proxy owns public host validation and TLS termination.

The initial administrator continues to use
`NEOSEQ_BOOTSTRAP_ADMIN_USERNAME` and at least one of
`NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD` or
`NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD_FILE`. The secret file takes precedence when
both are set. The image defaults to the username `admin` and the direct password
`change-me-later`; deployments must replace this password.

## State and Lifecycle

The persistent volume is `/var/lib/neoseq`. Embedded PostgreSQL data lives under
`postgres/<major>/data`; the major version in `PG_VERSION` must match the image.
Runtime configuration, sockets, readiness state, and PID records live under
`/run/neoseq` and are disposable. Backups must be written to a separately mounted
path. A storage backend must either permit ownership reconciliation or already
present the configured UID/GID; this matters for virtualized host bind mounts.

Startup validates configuration, initializes an empty PostgreSQL cluster, waits
for database readiness, starts the server and waits for `/readyz`, then publishes
ingress. Schema migrations run transactionally under the server's database
advisory lock before readiness.

Shutdown first removes ingress, then asks the server to drain, then performs a
fast PostgreSQL shutdown. Forced termination is a bounded fallback, never the
normal database shutdown path.

## Operations

The controller exposes `serve`, `health`, `doctor`, `backup`, and `restore`
commands. Docker health is one composite probe over the enabled process set.
Ingress probes require the exact response from an appliance-owned health route,
so an unmatched virtual host cannot appear healthy by returning an empty 200.
Logical backups use PostgreSQL custom format and are atomically renamed into
place. Restore is an offline, explicit-confirmation operation against embedded
PostgreSQL; it never runs beside a serving appliance.

Application schema migrations are forward-only and sequential. A database newer
than the running image fails closed. PostgreSQL minor releases may replace the
binary within one major line; major upgrades require an explicit logical
backup/restore into an image carrying the new major version.

## Image Construction

`outputs.neoseq-docker` composes the existing production client, dashboard,
and server outputs with the appliance controller, Caddy, `tini`, PostgreSQL, and
the small runtime tool closure. Build tools are absent. The image is Linux-only;
amd64 and arm64 artifacts are built on matching Linux builders and may be
published under one multi-architecture manifest.
