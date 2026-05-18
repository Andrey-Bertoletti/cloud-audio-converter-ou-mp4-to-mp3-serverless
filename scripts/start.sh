#!/usr/bin/env bash
# Entrypoint do container: sobe Cloudflare WARP (HTTP proxy local) antes do Node.
# WARP dá ao container um IP de saída que o YouTube trata como "cliente", não datacenter.
#
# Estratégia: o endpoint UDP padrão (2408) costuma ser bloqueado por firewalls de
# provedores (HF Spaces inclusive). Cloudflare aceita o mesmo handshake WireGuard
# em várias portas UDP — tentamos cada uma até alguma confirmar warp=on.
set -u

WARP_DIR="${WARP_DIR:-/tmp/warp}"
WARP_PORT="${WARP_PORT:-40001}"
WARP_HEALTHCHECK_URL="${WARP_HEALTHCHECK_URL:-https://www.cloudflare.com/cdn-cgi/trace}"
WARP_WAIT_PER_PORT="${WARP_WAIT_PER_PORT:-12}"
# Portas a tentar para o endpoint do WARP. 2408 é o default; 443/500/1701/4500
# são alternativas que o servidor Cloudflare aceita e que costumam estar abertas.
WARP_PORTS_TO_TRY="${WARP_PORTS_TO_TRY:-2408 443 500 1701 4500}"

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

# Função: monta wireproxy.conf trocando a porta UDP do Endpoint para $1.
build_wireproxy_conf() {
  local port="$1"
  awk -v port="$port" '
    BEGIN { in_iface=0 }
    /^\[Interface\]/ { in_iface=1; print; next }
    /^\[Peer\]/ { in_iface=0; print; next }
    in_iface && /^DNS/ { next }
    in_iface && /^MTU/ { next }
    /^Endpoint *=/ {
      # Substitui a porta após o último ":"
      sub(/:[0-9]+$/, ":" port)
      print
      next
    }
    { print }
  ' wgcf-profile.conf > wireproxy.conf
  cat >> wireproxy.conf <<EOF

[http]
BindAddress = 127.0.0.1:${WARP_PORT}
EOF
}

# Função: tenta subir wireproxy com a porta atual e valida com healthcheck.
try_port() {
  local port="$1"
  echo "[start][warp] tentando endpoint UDP/$port..."
  build_wireproxy_conf "$port"

  /usr/local/bin/wireproxy -c "$WARP_DIR/wireproxy.conf" >/tmp/wireproxy.log 2>&1 &
  local pid=$!

  for i in $(seq 1 "$WARP_WAIT_PER_PORT"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[start][warp] wireproxy morreu na porta $port. log:"
      sed -e 's/^/[start][warp][proxy] /' /tmp/wireproxy.log | tail -10
      return 1
    fi
    if curl -fsS --max-time 3 --proxy "http://127.0.0.1:${WARP_PORT}" "$WARP_HEALTHCHECK_URL" >/tmp/warp-trace.txt 2>/dev/null; then
      if grep -q '^warp=on' /tmp/warp-trace.txt; then
        echo "[start][warp] ✓ WARP ativo via UDP/$port (IP de saída via Cloudflare)."
        return 0
      fi
    fi
    sleep 1
  done

  echo "[start][warp] UDP/$port não passou healthcheck — matando."
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 1
}

# 3) Iterar portas até alguma funcionar.
ready=0
for port in $WARP_PORTS_TO_TRY; do
  if try_port "$port"; then
    ready=1
    break
  fi
done

if [ "$ready" != "1" ]; then
  echo "[start][warp] Nenhuma porta UDP funcionou (firewall bloqueando). Node sobe sem proxy."
  unset YOUTUBE_PROXY_URL
fi

exec node /opt/app/server/index.js
