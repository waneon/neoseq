{
  cacert,
  caddy,
  client,
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
    cacert
    caddy
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
    User = "${uid}:${gid}";
    WorkingDir = "/var/lib/neoseq";
    Env = [
      "HOME=/home/neoseq"
      "PATH=/bin"
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
