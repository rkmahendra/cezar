#!/usr/bin/env bash
# Fork-local (FORK.md): build this checkout, install it as the global cezar, restart the service.
# Usage: scripts/reinstall-fork.sh [--force]   (--force skips the active-runs check)
# Undo:  npm i -g cezar-run && sudo systemctl restart cezar
set -euo pipefail

PORT="${CEZ_PORT:-4321}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Restarting kills in-flight agent runs, so refuse unless the cockpit reports none.
if [[ "${1:-}" != "--force" ]] && curl -sf "http://127.0.0.1:$PORT/api/v1/runs" -o "$TMP/runs.json"; then
  active=$(node -e 'const j=require(process.argv[1]);const r=[].concat(j.runs??j);console.log(r.filter(x=>["running","queued","waiting","monitoring"].includes(x.status)).length)' "$TMP/runs.json")
  if [[ "$active" != "0" ]]; then
    echo "error: $active run(s) active on :$PORT. Finish them or pass --force." >&2
    exit 1
  fi
fi

echo "==> build ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD)@$(git -C "$ROOT" rev-parse --short HEAD))"
(cd "$ROOT" && npm run build >/dev/null)

echo "==> pack + install"
(cd "$ROOT/packages/cezar" && npm pack --silent --pack-destination "$TMP" >/dev/null)
# The upstream `cezar-run` alias package owns the same bin name; drop it so npm doesn't refuse.
npm ls -g --depth=0 cezar-run >/dev/null 2>&1 && npm uninstall -g cezar-run >/dev/null
npm install -g "$TMP"/open-mercato-cezar-*.tgz >/dev/null

echo "==> restart"
if systemctl cat cezar.service >/dev/null 2>&1; then
  sudo systemctl restart cezar
else
  echo "no cezar.service: restart your cezar process yourself" >&2
fi

# Health: the new build must answer on $PORT and see jcode.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/v1/health" -o "$TMP/health.json"; then
    node -e 'const j=require(process.argv[1]);const c=j.checks.find(c=>c.name==="jcode");console.log(`ok: cezar ${j.version} on :${process.argv[2]}, jcode ${c?.available?c.version:"NOT available"}`);process.exit(c?0:1)' "$TMP/health.json" "$PORT"
    exit $?
  fi
  sleep 1
done
echo "error: cezar did not answer on :$PORT (journalctl -u cezar -n 30)" >&2
exit 1
