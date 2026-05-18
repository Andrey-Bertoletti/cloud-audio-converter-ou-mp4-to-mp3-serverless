FROM node:22-bookworm-slim

# Dependências de sistema (ffmpeg + curl pra baixar yt-dlp/wgcf/wireproxy + python pra yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp binário (mesmo padrão do Render)
RUN mkdir -p /opt/app/.bin && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /opt/app/.bin/yt-dlp && \
    chmod +x /opt/app/.bin/yt-dlp

# Cloudflare WARP via wgcf + wireproxy (userspace WireGuard com HTTP proxy local).
# Permite que o container saia pelo IP do WARP (não-flagged pelo YouTube como datacenter).
ARG WGCF_VERSION=2.2.24
ARG WIREPROXY_VERSION=1.0.9
RUN curl -fsSL "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_amd64" \
      -o /usr/local/bin/wgcf && \
    chmod +x /usr/local/bin/wgcf && \
    curl -fsSL "https://github.com/whyvl/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_amd64.tar.gz" \
      -o /tmp/wireproxy.tgz && \
    tar -xzf /tmp/wireproxy.tgz -C /usr/local/bin/ wireproxy && \
    chmod +x /usr/local/bin/wireproxy && \
    rm -f /tmp/wireproxy.tgz

WORKDIR /opt/app

# Cache de deps (camada separada acelera rebuild)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Código
COPY . .

# Build do Angular (gera dist/ que o backend serve estático se quiser)
RUN npm run build || echo "build pulado (sem etapa de build do front)"

RUN chmod +x /opt/app/scripts/start.sh

# Hugging Face Spaces exige porta 7860 por padrão
ENV PORT=7860 \
    NODE_ENV=production \
    YTDLP_PATH=/opt/app/.bin/yt-dlp \
    HOME=/tmp \
    WARP_DIR=/tmp/warp \
    WARP_PORT=40001 \
    YOUTUBE_PROXY_URL=http://127.0.0.1:40001

# /tmp é o único writable garantido no HF Spaces — manda npm/yt-dlp/warp pra lá
RUN mkdir -p /tmp/.cache /tmp/warp && chown -R 1000:1000 /opt/app /tmp/.cache /tmp/warp

USER 1000

EXPOSE 7860

CMD ["/opt/app/scripts/start.sh"]
