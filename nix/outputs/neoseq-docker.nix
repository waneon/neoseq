{
  bash,
  cacert,
  caddy,
  client,
  coreutils,
  dashboard,
  dockerTools,
  postgresql_17,
  server,
  tini,
}:

let
  version = (builtins.fromTOML (builtins.readFile ../../Cargo.toml)).workspace.package.version;
  uid = "10001";
  gid = "10001";
in
dockerTools.buildLayeredImage {
  name = "neoseq";
  tag = version;
  contents = [
    # PostgreSQL tools invoke /bin/sh while locating and starting the server.
    bash
    cacert
    caddy
    coreutils
    postgresql_17
    server
    tini
  ];

  extraCommands = ''
    mkdir -p \
      ./backups \
      ./etc/neoseq \
      ./home/neoseq \
      ./run/neoseq \
      ./srv/neoseq \
      ./var/lib/neoseq
    ln -s ${client} ./srv/neoseq/client
    ln -s ${dashboard} ./srv/neoseq/dashboard
    cp ${./neoseq.Caddyfile} ./etc/neoseq/Caddyfile

    printf 'root:x:0:0:root:/root:/bin/false\nneoseq:x:${uid}:${gid}:Neoseq appliance:/home/neoseq:/bin/false\n' > ./etc/passwd
    printf 'root:x:0:\nneoseq:x:${gid}:\n' > ./etc/group
    echo 'hosts: files dns' > ./etc/nsswitch.conf
  '';

  fakeRootCommands = ''
    chown 0:0 \
      ./etc/group \
      ./etc/neoseq/Caddyfile \
      ./etc/nsswitch.conf \
      ./etc/passwd
    chmod 0644 ./etc/group ./etc/nsswitch.conf ./etc/passwd
    chmod 0644 ./etc/neoseq/Caddyfile
    chown -R ${uid}:${gid} \
      ./backups \
      ./home/neoseq \
      ./run/neoseq \
      ./var/lib/neoseq
    chmod 0700 ./home/neoseq ./run/neoseq
    chmod 0750 ./backups ./var/lib/neoseq
  '';

  config = {
    Entrypoint = [
      "${tini}/bin/tini"
      "--"
      "${server}/bin/neoseq-appliance"
    ];
    Cmd = [ "serve" ];
    # The controller prepares volume ownership, then drops privileges before
    # starting its async runtime or any application process.
    User = "0:0";
    WorkingDir = "/var/lib/neoseq";
    Env = [
      "HOME=/home/neoseq"
      "PATH=/bin"
      "PUID=${uid}"
      "PGID=${gid}"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "NEOSEQ_BOOTSTRAP_ADMIN_USERNAME=admin"
      "NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD=change-me-later"
    ];
    ExposedPorts = {
      "8080/tcp" = { };
      "8081/tcp" = { };
    };
    Volumes = {
      "/var/lib/neoseq" = { };
    };
    Healthcheck = {
      Test = [
        "CMD"
        "${server}/bin/neoseq-appliance"
        "health"
      ];
      Interval = 30000000000;
      Timeout = 10000000000;
      StartPeriod = 60000000000;
      Retries = 3;
    };
    StopSignal = "SIGTERM";
    Labels = {
      "org.opencontainers.image.title" = "Neoseq";
      "org.opencontainers.image.version" = version;
      "org.opencontainers.image.licenses" = "AGPL-3.0-only";
    };
  };
}
