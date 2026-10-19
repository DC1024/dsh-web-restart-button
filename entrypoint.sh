#!/usr/bin/env bash
# Entrypoint: with args -> run dsh directly (headless, plugin, etc.)
#             no args   -> start dsh web on 127.0.0.1 and nginx on 0.0.0.0:8080
set -euo pipefail

# e.g. docker run --rm dsh-web:local --profile headless "fix the failing tests"
if [[ $# -gt 0 ]]; then
  exec dsh "$@"
fi

DSH_PORT="${DSH_PORT:-3080}"
PROXY_PORT="${PROXY_PORT:-8080}"
# port the UI is published on by docker compose (for the hint below only)
PUBLISHED_PORT="${PUBLISHED_PORT:-3080}"

args=(web --no-open --host 127.0.0.1 --port "${DSH_PORT}")
if [[ -n "${DSH_TRUSTED_HOST:-}" ]]; then
  # required when the browser reaches the UI through a proxy on another host:
  # without it the API answers 401/403 (DNS-rebinding / cross-site guard)
  args+=(--trusted-host "${DSH_TRUSTED_HOST}")
fi

dsh "${args[@]}" > /tmp/dsh.log 2>&1 &
DSH_PID=$!

# Start tailing right away: if dsh dies during boot we want the crash in
# `docker logs` immediately instead of after the 60s readiness loop.
tail -f /tmp/dsh.log &
TAIL_PID=$!

echo "waiting for dsh on 127.0.0.1:${DSH_PORT} ..."
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:${DSH_PORT}/"; then break; fi
  sleep 1
done

# NOTE: dsh 0.2.0-rc.2 no longer prints the launch token to stdout, so this
# grep normally finds nothing. The `|| true` is required: with `set -e` a
# non-matching grep would abort the whole entrypoint and the container would
# exit -> `unless-stopped` would restart it forever (the exact loop we hit).
TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/dsh.log 2>/dev/null | head -1 | cut -d= -f2)" || true
export TOKEN

# nginx reads this include to build the /go redirect. dsh mints a new launch
# token on every start, so nothing may be hard-coded in nginx.conf.
printf 'set $dsh_token "%s";\n' "${TOKEN}" > /tmp/nginx-dsh-token.conf

if [[ -n "${TOKEN}" ]]; then
  echo "=============================================================="
  echo " dsh web is up."
  echo " BOOKMARK THIS:  http://<host>:${PUBLISHED_PORT}/go"
  echo "   -> auto-exchanges the launch token, no manual copying."
  echo " raw token (changes every restart):"
  echo "   http://<host>:${PUBLISHED_PORT}/?token=${TOKEN}"
  echo " login: HTTP Basic Auth (admin / see ./htpasswd)"
  echo "=============================================================="
fi

terminate() { kill "${DSH_PID}" 2>/dev/null || true; }
trap terminate TERM INT

# nginx goes to the background and dsh is what we wait on.
#
# Previously this was `exec nginx`, which made nginx PID 1: if dsh died (crash,
# or a "restart" plugin killing it on purpose) the container stayed up with a
# dead backend and nothing would ever bring it back. Now dsh's death ends the
# script, the container exits, and Docker's `restart: unless-stopped` policy
# rebuilds the whole stack -- including a fresh launch token for /go.
# Restart switch: nginx proxies /__restart here, this kills dsh on request.
# 127.0.0.1 only, so it is unreachable except through nginx's Basic Auth.
node /usr/local/bin/restart-endpoint.js > /tmp/restart-endpoint.log 2>&1 &
RESTART_PID=$!

nginx -c /etc/nginx/nginx.conf &
NGINX_PID=$!

set +e
wait "${DSH_PID}"
DSH_RC=$?
set -euo pipefail

echo "dsh exited (rc=${DSH_RC}); stopping the container so the restart policy recovers it"
kill "${NGINX_PID}" "${TAIL_PID}" "${RESTART_PID}" 2>/dev/null || true
exit "${DSH_RC}"
