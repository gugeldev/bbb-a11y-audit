#!/usr/bin/env bash
# Runs eslint-plugin-jsx-a11y (recommended + a few strict rules) on its own, independent of the
# project's eslint setup and node_modules. Tooling is installed once into a cache directory.
#
#   eslint-a11y.sh <output.json> <path> [<path> ...]
#
# Inline eslint-disable comments are ignored on purpose (--no-inline-config): an a11y rule that
# someone disabled is exactly what an audit wants to see.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <output.json> <path> [<path> ...]" >&2
  exit 1
fi

OUT="$1"; shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${A11Y_ESLINT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/a11y-audit-eslint}"
export A11Y_ESLINT_CACHE="$CACHE"

if [ ! -x "$CACHE/node_modules/.bin/eslint" ]; then
  echo "eslint-a11y: installing eslint tooling into $CACHE (one time)" >&2
  mkdir -p "$CACHE"
  (
    cd "$CACHE"
    [ -f package.json ] || echo '{"name":"a11y-audit-eslint","private":true}' > package.json
    npm install --no-audit --no-fund --silent \
      eslint@8.57.1 eslint-plugin-jsx-a11y@6.10.2 @typescript-eslint/parser@8.45.0 typescript@5.9.2
  )
fi

# eslint exits 1 when it finds problems; that is the normal case here.
set +e
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
  "$@"
STATUS=$?
set -e

if [ "$STATUS" -gt 1 ]; then
  echo "eslint-a11y: eslint failed with status $STATUS" >&2
  exit "$STATUS"
fi

# Make paths repo-relative, like static-scan.mjs.
node -e '
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const root = process.argv[2];
const r = JSON.parse(fs.readFileSync(file, "utf8"));
for (const f of r) f.filePath = path.relative(root, f.filePath);
fs.writeFileSync(file, JSON.stringify(r));
' "$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")" "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

node -e '
const r = require(process.argv[1]);
const counts = {};
let parse = 0;
for (const f of r) for (const m of f.messages) {
  if (!m.ruleId) { parse++; continue; }
  counts[m.ruleId] = (counts[m.ruleId] || 0) + 1;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.error(`eslint-a11y: ${r.length} files, ${total} messages, ${parse} parse errors`);
console.error(JSON.stringify(counts, null, 1));
' "$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
