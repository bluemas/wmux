#!/usr/bin/env bash
# Build only the opt-in native C experiment; do not overwrite S-A1 artifacts.
set -euo pipefail
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
node "$REPO_ROOT/scripts/generate-rust-unicode11.mjs" --check
cd "$CRATE_DIR"
"$REPO_ROOT/node_modules/.bin/napi" build --manifest-path ./Cargo.toml \
  --features native-core --output-dir ./dist/native-core --platform --release \
  --js index.cjs --dts index.d.ts
