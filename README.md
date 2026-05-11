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

## 5) Conversão de links do YouTube (Backend)

O endpoint `POST /api/youtube/convert` baixa o áudio do YouTube e converte para MP3 no servidor.

Variáveis de ambiente (veja `.env.example`):

- `YOUTUBE_COOKIE` (JSON) ou `YOUTUBE_COOKIE_BASE64`: cookies exportados do navegador (sessão logada).
- `YOUTUBE_COOKIE_HEADER`: alternativa em formato de header `Cookie:` bruto.
- `YOUTUBE_PROXY_URI`: opcional (restrição regional).

Observação importante: a mensagem **"Sign in to confirm you’re not a bot"** é um bloqueio do próprio YouTube (muito comum em IPs de datacenter). Mesmo com cookies/proxy, não é possível garantir 100% de sucesso em produção — quando ocorrer, o backend retorna `429` com `Retry-After`.
