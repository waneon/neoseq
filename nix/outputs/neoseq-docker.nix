{
  appliance,
  bash,
  cacert,
  caddy,
  client,
  coreutils,
  curl,
  dashboard,
  dockerTools,
  findutils,
  postgresql_17,
  server,
  tini,
  util-linux,
  writeShellApplication,
}:

let
  version = (builtins.fromTOML (builtins.readFile ../../Cargo.toml)).workspace.package.version;
  defaultUid = "10001";
  defaultGid = "10001";
  entrypoint = writeShellApplication {
    name = "neoseq-entrypoint";
    runtimeInputs = [
      coreutils
      findutils
      util-linux
    ];
    text = ''
      uid="''${NEOSEQ_UID:-${defaultUid}}"
      gid="''${NEOSEQ_GID:-${defaultGid}}"

      validate_id() {
        local name="$1"
        local number="$2"
        if [[ ! "$number" =~ ^[1-9][0-9]{0,9}$ ]] || (( number > 4294967294 )); then
          echo "neoseq-entrypoint: $name must be an integer between 1 and 4294967294; got '$number'" >&2
          exit 64
        fi
      }

      run_as_neoseq() {
        if (( EUID == uid && EGID == gid )); then
          exec "$@"
        fi
        if (( EUID != 0 )); then
          echo "neoseq-entrypoint: expected to run as root or $uid:$gid; got $EUID:$EGID" >&2
          exit 77
        fi
        exec setpriv \
          --reuid="$uid" \
          --regid="$gid" \
          --clear-groups \
          --inh-caps=-all \
          --ambient-caps=-all \
          --bounding-set=-all \
          --no-new-privs \
          "$@"
      }

      validate_id NEOSEQ_UID "$uid"
      validate_id NEOSEQ_GID "$gid"

      if [[ "''${1:-}" == "--run-as-neoseq" ]]; then
        shift
        run_as_neoseq "$@"
      fi

      if (( EUID != 0 )); then
        echo "neoseq-entrypoint: initial directory setup requires root" >&2
        exit 77
      fi

      identity_dir="$(mktemp -d /etc/neoseq-identity.XXXXXX)"
      trap 'rm -rf -- "$identity_dir"' EXIT
      printf 'root:x:0:0:root:/root:/bin/false\nneoseq:x:%s:%s:Neoseq appliance:/home/neoseq:/bin/false\n' \
        "$uid" "$gid" > "$identity_dir/passwd"
      printf 'root:x:0:\nneoseq:x:%s:\n' "$gid" > "$identity_dir/group"
      install -m 0644 "$identity_dir/passwd" /etc/passwd
      install -m 0644 "$identity_dir/group" /etc/group
      rm -rf -- "$identity_dir"
      trap - EXIT

      prepare_directory() {
        local directory="$1"
        local mode="$2"
        local remaining
        mkdir -p "$directory"
        find "$directory" -xdev \( ! -uid "$uid" -o ! -gid "$gid" \) \
          -exec chown --no-dereference "$uid:$gid" '{}' + 2>/dev/null || true
        remaining="$(
          find "$directory" -xdev \( ! -uid "$uid" -o ! -gid "$gid" \) -print -quit
        )"
        if [[ -n "$remaining" ]]; then
          echo "neoseq-entrypoint: cannot set $remaining to $uid:$gid; set NEOSEQ_UID and NEOSEQ_GID to the bind-mount owner or use storage that permits chown" >&2
          exit 77
        fi
        chmod "$mode" "$directory"
      }

      prepare_directory /home/neoseq 0700
      prepare_directory /run/neoseq 0700
      prepare_directory /var/lib/neoseq 0750

      run_as_neoseq \
        ${tini}/bin/tini -- \
        ${appliance}/bin/neoseq-appliance "$@"
    '';
  };
in
dockerTools.buildLayeredImage {
  name = "neoseq";
  tag = version;
  contents = [
    appliance
    bash
    cacert
    caddy
    coreutils
    curl
    entrypoint
    postgresql_17
    server
    tini
  ];

  extraCommands = ''
    mkdir -p \
      ./etc \
      ./home/neoseq \
      ./run/neoseq \
      ./srv/neoseq \
      ./var/lib/neoseq
    ln -s ${client} ./srv/neoseq/client
    ln -s ${dashboard} ./srv/neoseq/dashboard

    printf 'root:x:0:0:root:/root:/bin/false\nneoseq:x:${defaultUid}:${defaultGid}:Neoseq appliance:/home/neoseq:/bin/false\n' > ./etc/passwd
    printf 'root:x:0:\nneoseq:x:${defaultGid}:\n' > ./etc/group
    printf 'root:!x:::::::\nneoseq:!x:::::::\n' > ./etc/shadow
    printf 'root:!::\nneoseq:!::\n' > ./etc/gshadow
    echo 'hosts: files dns' > ./etc/nsswitch.conf
  '';

  fakeRootCommands = ''
    chown 0:0 \
      ./etc/gshadow \
      ./etc/group \
      ./etc/nsswitch.conf \
      ./etc/passwd \
      ./etc/shadow
    chmod 0644 ./etc/group ./etc/nsswitch.conf ./etc/passwd
    chmod 0600 ./etc/gshadow ./etc/shadow
    chown -R ${defaultUid}:${defaultGid} \
      ./home/neoseq \
      ./run/neoseq \
      ./var/lib/neoseq
    chmod 0700 ./home/neoseq ./run/neoseq
    chmod 0750 ./var/lib/neoseq
  '';

  config = {
    Entrypoint = [ "${entrypoint}/bin/neoseq-entrypoint" ];
    Cmd = [ "serve" ];
    User = "0:0";
    WorkingDir = "/var/lib/neoseq";
    Env = [
      "HOME=/home/neoseq"
      "PATH=/bin"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "NEOSEQ_ENABLE_CLIENT=true"
      "NEOSEQ_ENABLE_SERVER=true"
      "NEOSEQ_ENABLE_DASHBOARD=true"
      "NEOSEQ_DATABASE_MODE=embedded"
      "NEOSEQ_BOOTSTRAP_ADMIN_USERNAME=admin"
      "NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD=change-me-later"
      "NEOSEQ_UID=${defaultUid}"
      "NEOSEQ_GID=${defaultGid}"
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
        "${entrypoint}/bin/neoseq-entrypoint"
        "--run-as-neoseq"
        "${appliance}/bin/neoseq-appliance"
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
