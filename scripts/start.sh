#!/usr/bin/env bash
# Entrypoint do container: sobe Cloudflare WARP (HTTP proxy local) antes do Node.
# WARP dá ao container um IP de saída que o YouTube trata como "cliente", não datacenter.
set -u

WARP_DIR="${WARP_DIR:-/tmp/warp}"
WARP_PORT="${WARP_PORT:-40001}"
WARP_HEALTHCHECK_URL="${WARP_HEALTHCHECK_URL:-https://www.cloudflare.com/cdn-cgi/trace}"
WARP_MAX_WAIT_SECONDS="${WARP_MAX_WAIT_SECONDS:-30}"

mkdir -p "$WARP_DIR"
cd "$WARP_DIR" || { echo "[start] não consegui acessar $WARP_DIR"; exec node /opt/app/server/index.js; }

if [ ! -x /usr/local/bin/wgcf ] || [ ! -x /usr/local/bin/wireproxy ]; then
  echo "[start] wgcf/wireproxy ausente — pulando WARP, iniciando Node sem proxy."
  exec node /opt/app/server/index.js
fi

# 1) Registrar conta WARP (idempotente — arquivo persistido na primeira execução).
if [ ! -f wgcf-account.toml ]; then
  echo "[start][warp] registrando nova conta WARP..."
  if ! /usr/local/bin/wgcf register --accept-tos >/tmp/wgcf-register.log 2>&1; then
    echo "[start][warp] falha ao registrar — sobe sem proxy. log:"
    sed -e 's/^/[start][warp][reg] /' /tmp/wgcf-register.log || true
    exec node /opt/app/server/index.js
  fi
fi

# 2) Gerar perfil WireGuard.
if [ ! -f wgcf-profile.conf ]; then
  echo "[start][warp] gerando perfil WireGuard..."
  if ! /usr/local/bin/wgcf generate >/tmp/wgcf-generate.log 2>&1; then
    echo "[start][warp] falha ao gerar perfil — sobe sem proxy."
    sed -e 's/^/[start][warp][gen] /' /tmp/wgcf-generate.log || true
    exec node /opt/app/server/index.js
  fi
fi

# 3) Montar wireproxy.conf — usa o WireGuard do WARP em userspace e expõe HTTP proxy.
cat > wireproxy.conf <<EOF
$(awk '
  /^\[Interface\]/ { in_iface=1; print; next }
  /^\[Peer\]/ { in_iface=0; print; next }
  in_iface && /^DNS/ { next }
  in_iface && /^MTU/ { next }
  { print }
' wgcf-profile.conf)

[http]
BindAddress = 127.0.0.1:${WARP_PORT}
EOF

# 4) Subir wireproxy em background.
echo "[start][warp] subindo wireproxy em 127.0.0.1:${WARP_PORT}..."
/usr/local/bin/wireproxy -c "$WARP_DIR/wireproxy.conf" >/tmp/wireproxy.log 2>&1 &
WIREPROXY_PID=$!

# 5) Esperar o proxy responder.
ready=0
for i in $(seq 1 "$WARP_MAX_WAIT_SECONDS"); do
  if ! kill -0 "$WIREPROXY_PID" 2>/dev/null; then
    echo "[start][warp] wireproxy morreu — sobe sem proxy. log:"
    sed -e 's/^/[start][warp][proxy] /' /tmp/wireproxy.log || true
    break
  fi
  if curl -fsS --max-time 3 --proxy "http://127.0.0.1:${WARP_PORT}" "$WARP_HEALTHCHECK_URL" >/tmp/warp-trace.txt 2>/dev/null; then
    if grep -q '^warp=on' /tmp/warp-trace.txt; then
      echo "[start][warp] ✓ WARP ativo (IP de saída via Cloudflare)."
      ready=1
      break
    fi
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "[start][warp] WARP não confirmou em ${WARP_MAX_WAIT_SECONDS}s — Node sobe sem YOUTUBE_PROXY_URL."
  kill "$WIREPROXY_PID" 2>/dev/null || true
  unset YOUTUBE_PROXY_URL
fi

exec node /opt/app/server/index.js
