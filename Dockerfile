FROM node:22-bookworm-slim

# Dependências de sistema (ffmpeg + curl pra baixar yt-dlp + python pra yt-dlp)
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

WORKDIR /opt/app

# Cache de deps (camada separada acelera rebuild)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Código
COPY . .

# Build do Angular (gera dist/ que o backend serve estático se quiser)
RUN npm run build || echo "build pulado (sem etapa de build do front)"

# Hugging Face Spaces exige porta 7860 por padrão
ENV PORT=7860 \
    NODE_ENV=production \
    YTDLP_PATH=/opt/app/.bin/yt-dlp \
    HOME=/tmp

# /tmp é o único writable garantido no HF Spaces — manda npm/yt-dlp pra lá
RUN mkdir -p /tmp/.cache && chown -R 1000:1000 /opt/app /tmp/.cache

USER 1000

EXPOSE 7860

CMD ["node", "server/index.js"]
