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

### YouTube cookies e proxy

#### Entendimento da autenticação

O YouTube usa autenticação baseada em **cookie de sessão + IP**. A combinação precisa ser coerente:

- Se faz login na conta pelo navegador **na região A** (ex: Brasil com ISP), os cookies gerados carregam expectativa de região/IP A.
- Se depois tenta usar esses cookies **da região B** (ex: datacenter nos EUA), o YouTube pode rejeitar com: `"Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication..."`
- Isso **não é erro de instalação ou ffmpeg** — é rejeição da sessão pelo YouTube.

#### Preparando cookies válidos

1. **Exporte de uma sessão real logada:**
   - Use extensão do navegador (ex: Get cookies.txt) ou ferramentas de developer (F12 → Network → Cookies).
   - Ou rode localmente: `yt-dlp --cookies-from-browser firefox --dump-json --skip-download URL` para testar.
   - Exporte em formato JSON array ou Netscape (`# Netscape HTTP Cookie File`).

2. **Inclua essenciais:**
   - `LOGIN_INFO`
   - `SID`
   - `HSID`
   - `SSID`
   - `SAPISID`
   - `__Secure-1PSID`
   - `__Secure-3PSID`

3. **Valide a exportação:**
   - No servidor, o backend processa e alerta se `LOGIN_INFO` ou cookies essenciais estão faltando.
   - Se apenas `__Secure-1PSID` está presente (sem `LOGIN_INFO`), a sessão pode estar incompleta.

#### Usando proxy

Se usar proxy, prefira:

- **Residencial/ISP:** IPs estáveis da mesma região da sessão.
- **Evitar datacenter:** IPs bloqueados automaticamente pelo YouTube.
- **Coerência:** Use proxy na mesma região em que fez login.
- **Rotação:** Se IP/proxy já foi bloqueado/exposto, rotacione.

#### Detectando problemas

**Erro 429 com `YOUTUBE_SESSION_REJECTED`:**

O backend retorna HTTP 429 se `yt-dlp` retorna `"Sign in to confirm you're not a bot"`. Significa:

```json
{
  "error": "YOUTUBE_SESSION_REJECTED",
  "message": "YouTube recusou os cookies de sessão neste servidor/proxy.",
  "retryAfterSeconds": 300
}
```

**Diagnóstico manual:**

No Render Shell ou ambiente similar, teste:

```bash
# Verifica instalação
.bin/yt-dlp --version
ffmpeg -version

# Testa autenticação SEM baixar (retorna metadados ou erro de sessão)
.bin/yt-dlp \
  --cookies /tmp/cookies.txt \
  --proxy "http://PROXY_IP:PROXY_PORT" \
  --dump-json \
  --skip-download \
  "https://youtu.be/VIDEO_ID"
```

Se retorna `"Sign in to confirm you're not a bot"` neste comando, o YouTube rejeitou a sessão. **Não é bug de código** — regenere cookies:

1. Gere cookies novos de uma conta logada.
2. Use na mesma região/IP (se estava no Brasil, mantenha IP Brasil).
3. Se proxy estava exposto, mude para IP novo.
4. Teste primeiro com vídeo público curto.

#### Segurança de logs

**Nunca expor em logs:**

- Valores de cookies (ex: `SID=xyz123`)
- Credenciais do proxy (ex: `http://user:pass@proxy.com`)
- Comando completo contendo URL do vídeo + proxy

O backend usa `safeLog` para redação automática. Se acidentalmente expor em logs de produção:

- Redenominar cookies (`YOUTUBE_COOKIE`)
- Trocar proxy (`YOUTUBE_PROXY_URL`)
- Fazer revoke de tokens se houver

#### Exemplo de teste local

```bash
# 1) Exporte cookies do navegador
#    Salve em ./cookies.txt (formato Netscape)

# 2) Com proxy (teste rápido, sem download)
yt-dlp \
  --cookies ./cookies.txt \
  --proxy "http://127.0.0.1:8080" \
  --dump-json \
  --skip-download \
  "https://youtu.be/KlKKYMQOXr4"

# 3) Se erro "Sign in to confirm", cookies/proxy problema
#    Se sucesso, retorna JSON com metadados do vídeo
```

Se sucesso neste teste, o MP3 deve gerar no servidor. Se falha, o YouTube recusou a sessão naquela região/proxy.

