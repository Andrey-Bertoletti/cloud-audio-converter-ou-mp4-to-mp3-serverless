# MP4 to MP3 Converter (Angular + Supabase)

Aplicação fullstack preparada para nuvem com:

- **Frontend**: Angular + Tailwind CSS
- **Conversão**: `ffmpeg.wasm` no client-side
- **Backend**: API Node.js/Express
- **Persistência**: Supabase PostgreSQL (`conversoes`) e Storage (`converted-audio`)

## 1) Configuração

1. Instale dependências:

```bash
npm install
```

2. Copie `.env.example` para `.env` e preencha:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

3. Atualize também `src/environments/environment.ts` com:

- `supabaseUrl`
- `supabaseAnonKey`
- `apiBaseUrl`

## 2) Criar tabela e bucket no Supabase

Execute o SQL do arquivo:

`supabase/setup.sql`

Isso cria:

- tabela `public.conversoes`
- índice por `criado_em`
- bucket `converted-audio`

## 3) Rodar localmente

```bash
npm run start
```

- Frontend Angular: `http://localhost:4200`
- API Node: `http://localhost:3000`

## 4) Deploy em nuvem

- Deploy do frontend em Vercel/Netlify.
- Deploy da API (Express) em Render/Fly.io/Railway/Vercel Functions.
- Configure variáveis de ambiente da API no provedor.
- Aponte `apiBaseUrl` do Angular para a URL pública da API.

### Render

Se o deploy usar Render sem Dockerfile, o binário do `yt-dlp` precisa ser baixado explicitamente no build. Use esta sequência como base:

```bash
npm install
npm run build
mkdir -p .bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o .bin/yt-dlp
chmod +x .bin/yt-dlp
```

Depois configure no Render:

- `ENABLE_YTDLP_FALLBACK=true`
- `YTDLP_PATH=/opt/render/project/src/.bin/yt-dlp`

Importante:

- `ffmpeg-static` não instala `yt-dlp`.
- Ao remover `youtube-dl-exec`, o binário que vinha em `node_modules/youtube-dl-exec/bin/yt-dlp` também deixa de existir.
- Por isso o projeto agora instala `yt-dlp` explicitamente no ambiente de deploy.

## 5) Conversão de links do YouTube (Backend)

O endpoint `POST /api/youtube/convert` baixa o áudio do YouTube e converte para MP3 no servidor.

Variáveis de ambiente (veja `.env.example`):

- `YOUTUBE_COOKIE`: aceita JSON array exportado, cookie header ou base64 (sessão logada).
- `YOUTUBE_PROXY_URL`: recomendado proxy residencial/ISP estável (IPs de datacenter costumam ser bloqueados).

Segurança: se cookies/proxy já foram expostos em logs, prints ou Git, trate como comprometidos e **rotacione/regenere** imediatamente.

Observação importante: a mensagem **"Sign in to confirm you’re not a bot"** é um bloqueio do próprio YouTube (muito comum em IPs de datacenter). Mesmo com cookies/proxy, não é possível garantir 100% de sucesso em produção — quando ocorrer, o backend retorna `429` com `Retry-After`.

Fallback técnico: quando o `@distube/ytdl-core` falha com bloqueio/429, o backend tenta um fallback com `yt-dlp` (executado via `child_process.spawn`). Para funcionar, o binário precisa estar disponível no servidor e apontado por `YTDLP_PATH`.

Segurança (reforço): se o proxy/cookies vazaram em logs de produção, **rotacione imediatamente**. Nunca cole logs contendo `YOUTUBE_PROXY_URL` real nem valores de cookies.
