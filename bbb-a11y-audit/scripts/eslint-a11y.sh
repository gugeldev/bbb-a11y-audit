#!/usr/bin/env bash
# Static layer: runs eslint-plugin-jsx-a11y on its own, independent of the project's eslint setup
# and node_modules. The tooling is installed once into a cache directory.
#
#   eslint-a11y.sh <output.json> <path> [<path> ...]
#
# Inline eslint-disable comments are ignored on purpose (--no-inline-config): an accessibility rule
# that someone disabled is exactly what an audit wants to see.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <output.json> <path> [<path> ...]" >&2
  exit 1
fi

OUT="$1"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${A11Y_ESLINT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/a11y-audit-eslint}"
export A11Y_ESLINT_CACHE="$CACHE" # read by eslint-a11y.cjs to resolve the parser

TOOLING=(eslint@8.57.1 eslint-plugin-jsx-a11y@6.10.2 @typescript-eslint/parser@8.45.0 typescript@5.9.2)

install_tooling() {
  echo "eslint-a11y: installing eslint tooling into $CACHE (one time)" >&2
  mkdir -p "$CACHE"
  (
    cd "$CACHE"
    [ -f package.json ] || echo '{"name":"a11y-audit-eslint","private":true}' >package.json
    npm install --no-audit --no-fund --silent "${TOOLING[@]}"
  )
}

[ -x "$CACHE/node_modules/.bin/eslint" ] || install_tooling

# eslint exits 1 when it finds problems, which is the normal case here; 2 means it crashed.
status=0
"$CACHE/node_modules/.bin/eslint" \
  --no-eslintrc \
  --no-inline-config \
  --config "$HERE/eslint-a11y.cjs" \
  --resolve-plugins-relative-to "$CACHE" \
  --ext .js,.jsx,.ts,.tsx \
  --ignore-pattern '**/node_modules/**' \
  --ignore-pattern '**/*.spec.*' \
  --ignore-pattern '**/*.test.*' \
  --no-error-on-unmatched-pattern \
  --format json \
  --output-file "$OUT" \
  "$@" || status=$?

if [ "$status" -gt 1 ]; then
  echo "eslint-a11y: eslint failed with status $status" >&2
  exit "$status"
fi

OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
node "$HERE/lib/eslint-postprocess.mjs" "$OUT_ABS" "$REPO_ROOT"
