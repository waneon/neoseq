#!/usr/bin/env bash
set -euo pipefail

cd "${DEVENV_ROOT:?Run publish-docker through the devenv shell}"

archive="$(devenv -s x86_64-linux build outputs.neoseq-docker | jq --raw-output --exit-status '."outputs.neoseq-docker"')"
source_image="$(tar --extract --to-stdout --file "$archive" manifest.json | jq --raw-output --exit-status '.[0].RepoTags[0]')"
docker load --input "$archive"

# Read identity from the built artifact, including when the workspace version
# changed after entering the shell. Pin both publications to the same image ID.
metadata="$(docker image inspect "$source_image")"
image_id="$(jq --raw-output --exit-status '.[0] | select(.Os == "linux" and .Architecture == "amd64") | .Id' <<<"$metadata")"
version="$(jq --raw-output --exit-status '.[0].Config.Labels["org.opencontainers.image.version"] | select(type == "string" and length > 0)' <<<"$metadata")"

for tag in "$version" latest; do
  destination="waneon/neoseq:$tag"
  docker tag "$image_id" "$destination"
  docker push "$destination"
done
