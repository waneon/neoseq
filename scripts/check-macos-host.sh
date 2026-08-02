#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS host check requires Darwin" >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are not selected" >&2
  exit 1
fi

if ! xcrun --sdk macosx --show-sdk-version >/dev/null 2>&1; then
  echo "The selected developer directory does not expose a macOS SDK" >&2
  exit 1
fi

jq -n \
  --arg developer_dir "$(xcode-select -p)" \
  --arg sdk "$(xcrun --sdk macosx --show-sdk-version)" \
  --arg clang "$(xcrun clang --version | head -1)" \
  '{developer_dir:$developer_dir,macos_sdk:$sdk,clang:$clang,status:"passed"}'
