# All-in-One Appliance Architecture

## Boundary

The Neoseq appliance is the supported single-container distribution for personal
servers and on-premises installations. One immutable Linux OCI image always runs
the release client, dashboard, synchronization server, ingress, and, unless an
external database URL is supplied, PostgreSQL. The container is one failure and
upgrade boundary; PostgreSQL is its only durable application state.

The image deliberately has one application topology. It is not a component
orchestrator and does not expose switches for removing, replacing, or rebinding
members of the stack. Deployments that need independently scaled components use
the component artifacts rather than partially disabling this image.

The appliance runs as the fixed unprivileged identity `10001:10001`. `tini` is
PID 1 and forwards container signals to the lifecycle controller. The controller
owns every child from spawn until reap. An unexpected child exit terminates the
whole appliance, and the container runtime owns restart policy.

## Runtime Shape

```text
:8080 ── ingress ── client files
           └─────── /v1, /livez, /readyz ──┐
                                           ├──> neoseq-server :8787
:8081 ── ingress ── dashboard files ───────┘          │
                                                      └──> PostgreSQL
```

The client and dashboard remain on separate listeners because both applications
are rooted at `/`. Ingress is the only public network boundary. The server binds
loopback. Embedded PostgreSQL accepts only local Unix-socket connections. TLS
terminates at an operator-managed reverse proxy in front of the container.

Ports, internal addresses, static roots, runtime paths, and the ingress
configuration are image invariants. Browser clients use their current origin as
the default synchronization origin, so same-origin deployments need no runtime
client configuration.

## Configuration

Database selection has two states. Exactly one of `DATABASE_URL_FILE` or
`DATABASE_URL` selects an external PostgreSQL database. If neither is present,
the appliance owns embedded PostgreSQL. There is no separate database-mode
setting.

The initial administrator continues to use
`NEOSEQ_BOOTSTRAP_ADMIN_USERNAME` and at least one of
`NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD` or
`NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD_FILE`. The secret file takes precedence when
both are set. The image defaults to the username `admin` and the direct password
`change-me-later`; deployments must replace this password.

## State and Lifecycle

The persistent volume is `/var/lib/neoseq`. Embedded PostgreSQL data lives at
`/var/lib/neoseq/postgres/data`; `PG_VERSION` is the authoritative format marker
and must match the image. Sockets and transient runtime configuration live under
`/run/neoseq`. Backups belong on a separately mounted `/backups` volume. Named
volumes inherit the image's fixed ownership; operator-provided bind mounts must
already be writable by `10001:10001`.

Startup validates only the selected database configuration, initializes an empty
embedded cluster when needed, waits for database readiness, starts the server and
waits for `/readyz`, then publishes ingress. Schema migrations run transactionally
under the server's database advisory lock before readiness. One startup deadline
bounds the complete sequence.

Shutdown first removes ingress, then asks the server to drain, then performs a
fast embedded PostgreSQL shutdown. Each phase shares one deadline shorter than
the container's 60-second stop grace; forced termination is the bounded fallback.

## Operations

The controller exposes `serve`, `health`, `backup`, and `restore`. Health checks
the public contract at `http://127.0.0.1:8080/readyz`; the server's readiness
already proves its database dependency. Logical backups use PostgreSQL custom
format and are atomically renamed into place. Restore is an offline,
explicit-confirmation operation against embedded PostgreSQL and cannot run beside
a serving appliance. Database startup and shutdown in both paths use the same
bounded lifecycle operations.

Application schema migrations are forward-only and sequential. A database newer
than the running image fails closed. PostgreSQL minor releases may replace the
binary within one major line; major upgrades require an explicit logical
backup/restore into an image carrying the new major version.

## Image Construction

`outputs.neoseq-docker` composes the production client and dashboard with the
server output, Caddy, `tini`, PostgreSQL, and the small runtime closure. The server
output supplies both the synchronization server and lifecycle controller from one
Cargo build. Build tools and privilege-changing utilities are absent. The image
is Linux-only; amd64 and arm64 artifacts are built on matching Linux builders and
may be published under one multi-architecture manifest.
