const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { safeLog } = require('./utils/safeLog');
const { normalizeYoutubeCookie, assertValidCookieHeader } = require('./utils/normalizeYoutubeCookie');
const { runYtDlpToMp3 } = require('./youtube/ytDlpFallback');

const YT_HEADERS_TV = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'X-Youtube-Client-Name': '5',
  'X-Youtube-Client-Version': '2.20230922.00.00'
};

const YT_HEADERS_WEB = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
};

const YT_METADATA_MAX_RETRIES = 3;
const YT_METADATA_BACKOFF_MS = 1200;

const YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS = 300;

function remainingSeconds(untilMs) {
  if (!untilMs) return 0;
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

function safeFileName(input) {
  const baseName = String(input || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const clipped = baseName.slice(0, 80);
  return clipped || `audio-${Date.now()}`;
}

function extractHttpStatusFromError(err) {
  const candidates = [
    err?.statusCode,
    err?.code,
    err?.status,
    err?.response?.status,
    err?.cause?.statusCode,
    err?.cause?.code,
    err?.cause?.status,
    err?.cause?.response?.status
  ];

  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
      return parsed;
    }
  }

  const text = [
    String(err?.message || ''),
    String(err?.stack || ''),
    String(err?.cause?.message || ''),
    String(err?.cause?.stack || '')
  ].join(' ');

  const matched = text.match(/\b([1-5]\d{2})\b/);
  if (matched) {
    const parsed = Number(matched[1]);
    if (parsed >= 100 && parsed <= 599) {
      return parsed;
    }
  }

  return null;
}

function errorText(err) {
  return [
    String(err?.name || ''),
    String(err?.message || ''),
    String(err?.stack || ''),
    String(err?.cause?.name || ''),
    String(err?.cause?.message || ''),
    String(err?.cause?.stack || '')
  ]
    .join(' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isYouTubeBotOrRateLimitError(err) {
  const text = errorText(err);
  const status = extractHttpStatusFromError(err);

  if (status === 429) return true;

  return (
    (text.includes('sign in to confirm') && text.includes('not a bot')) ||
    text.includes("confirm you're not a bot") ||
    (text.includes('faca login para confirmar') && text.includes('nao e um bot')) ||
    text.includes('too many requests') ||
    text.includes(' 429 ') ||
    text.includes('429 too many requests')
  );
}

function isYoutubeBotChallenge(error) {
  const rawText = [error?.message, error?.code, error?.stack, String(error)].filter(Boolean).join(' ');
  const text = rawText
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  return /yt_bot_challenge|youtube_bot_challenge|sign in to confirm|faca login para confirmar|too many requests|429/i.test(
    text
  );
}

function cookieHeaderToCookieArray(cookieHeader) {
  const raw = String(cookieHeader || '').trim();
  if (!raw) return [];

  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      if (index <= 0) return null;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name || !value) return null;

      return {
        domain: '.youtube.com',
        hostOnly: false,
        httpOnly: false,
        name,
        path: '/',
        sameSite: 'lax',
        secure: true,
        value
      };
    })
    .filter(Boolean);
}

function countCookiePairs(cookieHeader) {
  if (!cookieHeader) return 0;
  return cookieHeader
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean).length;
}

function readYoutubeCookieEnvInput() {
  return (
    process.env.YOUTUBE_COOKIE ||
    process.env.YOUTUBE_COOKIE_HEADER ||
    process.env.YOUTUBE_COOKIE_BASE64 ||
    process.env.YOUTUBE_COOKIE_HEADER_BASE64 ||
    process.env.YOUTUBE_COOKIES ||
    process.env.YOUTUBE_COOKIES_BASE64
  );
}

function readYoutubeProxyUrl() {
  return process.env.YOUTUBE_PROXY_URL || process.env.YOUTUBE_PROXY_URI || process.env.YOUTUBE_PROXY_URL;
}

function isYtDlpFallbackEnabled() {
  const raw = String(process.env.ENABLE_YTDLP_FALLBACK ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return true;
}

function buildYtdlOptions(agent, profile, cookieHeader) {
  const base =
    profile === 'tv'
      ? {
          agent,
          playerClients: ['TV'],
          requestOptions: { headers: YT_HEADERS_TV }
        }
      : {
          agent,
          playerClients: ['WEB_EMBEDDED'],
          requestOptions: { headers: YT_HEADERS_WEB }
        };

  // Garantia extra: mesmo se a lib não carregar cookies no jar (config incorreta),
  // ainda tentamos passar o header normalizado (sem logar valor).
  if (cookieHeader) {
    assertValidCookieHeader(cookieHeader);
    base.requestOptions.headers = Object.assign({}, base.requestOptions.headers, {
      Cookie: cookieHeader
    });
  }

  return base;
}

function isInvalidCookieHeaderError(error) {
  const text = [error?.name, error?.message, error?.code, String(error)].filter(Boolean).join(' ');
  return /invalid cookie header|UND_ERR_INVALID_ARG|Invalid normalized YouTube cookie/i.test(text);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYouTubeInfoWithFallback({ ytdl, youtubeUrl, agent, cookieHeader, state }) {
  const cooldownSeconds = remainingSeconds(state.ytBotChallengeBlockedUntilMs);
  if (cooldownSeconds > 0) {
    const err = new Error(
      `YouTube solicitou verificação anti-bot recentemente. Aguarde ${cooldownSeconds}s e tente novamente.`
    );
    err.code = 'YT_BOT_CHALLENGE';
    err.retryAfterSeconds = cooldownSeconds;
    throw err;
  }

  const profiles = ['web', 'tv'];
  let lastError;

  for (const profile of profiles) {
    for (let attempt = 1; attempt <= YT_METADATA_MAX_RETRIES; attempt += 1) {
      try {
        safeLog(
          'log',
          `[YouTube] Tentando metadata com perfil: ${profile} (tentativa ${attempt}/${YT_METADATA_MAX_RETRIES})`
        );
        return await ytdl.getInfo(youtubeUrl, buildYtdlOptions(agent, profile, cookieHeader));
      } catch (err) {
        lastError = err;

        if (isInvalidCookieHeaderError(err)) {
          safeLog.error('[YouTube] Cookie inválido para undici/ytdl-core (falha não-temporária).', {
            name: err?.name,
            code: err?.code,
            message: err?.message
          });
          throw err;
        }

        safeLog('error', `[YouTube] Falha no perfil ${profile} (tentativa ${attempt}):`, err);

        if (isYouTubeBotOrRateLimitError(err)) {
          // Não insistir com retries rápidos quando o YouTube bloqueou
          break;
        }

        if (attempt < YT_METADATA_MAX_RETRIES) {
          const jitter = Math.floor(Math.random() * 350);
          const backoff = YT_METADATA_BACKOFF_MS * attempt + jitter;
          safeLog('log', `[YouTube] Erro temporário. Aguardando ${backoff}ms para nova tentativa...`);
          await wait(backoff);
        }
      }
    }
  }

  if (isYouTubeBotOrRateLimitError(lastError)) {
    state.ytBotChallengeBlockedUntilMs = Date.now() + YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS * 1000;
    lastError.code = 'YT_BOT_CHALLENGE';
    lastError.retryAfterSeconds = YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS;
  }

  throw lastError;
}

async function convertWithYtdlCore({ ytdl, youtubeUrl, info, agent, cookieHeader, tempFilePath }) {
  return new Promise((resolve, reject) => {
    const streamOptions = {
      quality: 'highestaudio',
      filter: 'audioonly',
      highWaterMark: 1 << 25,
      ...buildYtdlOptions(agent, 'web', cookieHeader)
    };

    const stream = ytdl.downloadFromInfo(info, streamOptions);

    const downloadTimeoutMs = 45_000;
    const timeoutHandle = setTimeout(() => {
      if (stream && !stream.destroyed) {
        stream.destroy(new Error('Timeout ao baixar áudio do YouTube.'));
      }
    }, downloadTimeoutMs);
    timeoutHandle.unref?.();

    const clearTimeoutSafe = () => clearTimeout(timeoutHandle);
    stream.once('end', clearTimeoutSafe);
    stream.once('close', clearTimeoutSafe);
    stream.once('error', clearTimeoutSafe);

    ffmpeg(stream)
      .toFormat('mp3')
      .audioBitrate(192)
      .on('error', (err) => reject(err))
      .on('end', () => resolve(true))
      .save(tempFilePath);
  });
}

function botChallengeResponse(res, retryAfterSeconds = YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: 'YOUTUBE_BOT_CHALLENGE',
    message: 'YouTube solicitou verificação anti-bot para este servidor/proxy.',
    retryAfterSeconds
  });
}

function internalServerErrorResponse(res, error) {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Erro no servidor durante a conversão.'
    });
  }

  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Erro no servidor durante a conversão.'
  });
}

function createApp(options = {}) {
  const ytdl = options.ytdl || require('@distube/ytdl-core');

  const disableAuth = Boolean(options.disableAuth);
  const trustProxy = options.trustProxy ?? 1;
  const authMiddleware = disableAuth ? null : options.authMiddleware || require('./middleware/auth');
  const supabaseAdmin = options.supabaseAdmin || require('./config/supabaseAdmin').supabaseAdmin;
  const runYtDlpToMp3Fn = options.runYtDlpToMp3 || runYtDlpToMp3;

  ffmpeg.setFfmpegPath(ffmpegPath);

  const state = {
    ytBotChallengeBlockedUntilMs: 0
  };

  const app = express();
  app.set('trust proxy', trustProxy);

  app.use(
    helmet({
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginEmbedderPolicy: { policy: 'require-corp' }
    })
  );

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Muitas requisições deste IP, tente novamente em 15 minutos.' }
  });
  app.use(limiter);

  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:4200',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );

  app.use(express.json());

  app.get('/health', (_, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (disableAuth) {
    app.use('/api', (req, _res, next) => {
      req.user = { id: 'test-user' };
      next();
    });
  } else {
    app.use('/api', authMiddleware);
  }

  app.post('/api/conversoes', async (req, res) => {
    try {
      const { nomeArquivo, storagePath } = req.body;
      const user_id = req.user.id;

      if (!nomeArquivo) {
        return res.status(400).json({ error: 'nomeArquivo é obrigatório.' });
      }

      const { error } = await supabaseAdmin.from('conversoes').insert({
        nome_arquivo: nomeArquivo,
        storage_path: storagePath ?? null,
        user_id
      });

      if (error) {
        return internalServerErrorResponse(res, new Error(error.message));
      }

      return res.status(201).json({ ok: true });
    } catch (error) {
      return internalServerErrorResponse(res, error);
    }
  });

  app.get('/api/conversoes', async (req, res) => {
    try {
      const user_id = req.user.id;
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? '5'), 10) || 5));
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      const { data, error, count } = await supabaseAdmin
        .from('conversoes')
        .select('id, nome_arquivo, criado_em, storage_path', { count: 'exact' })
        .eq('user_id', user_id)
        .order('criado_em', { ascending: false })
        .range(from, to);

      if (error) throw error;

      return res.status(200).json({
        data: data ?? [],
        total: count ?? 0,
        page,
        totalPages: Math.max(1, Math.ceil((count ?? 0) / limit))
      });
    } catch (error) {
      return internalServerErrorResponse(res, error);
    }
  });

  app.post('/api/youtube/convert', async (req, res) => {
    let tempFilePath = '';
    try {
      const { youtubeUrl } = req.body;
      const user_id = req.user.id;

      if (!ytdl.validateURL(youtubeUrl)) {
        return res.status(400).json({ error: 'URL do YouTube inválida.' });
      }

      safeLog('log', `[YouTube] Iniciando conversão para o usuário ${user_id}: ${youtubeUrl}`);

      const cookieHeader = normalizeYoutubeCookie(readYoutubeCookieEnvInput());
      const proxyUrl = readYoutubeProxyUrl();
      const cookiesArray = cookieHeader ? cookieHeaderToCookieArray(cookieHeader) : [];

      safeLog.info('[YouTube] Cookie normalizado', {
        cookieCount: countCookiePairs(cookieHeader),
        hasCookie: Boolean(cookieHeader),
        headerLength: cookieHeader?.length || 0
      });

      // Mantém a mesma sessão/proxy durante a tentativa completa
      const agent = proxyUrl ? ytdl.createProxyAgent({ uri: proxyUrl }, cookiesArray) : ytdl.createAgent(cookiesArray);

      const timestamp = Date.now();
      let titleForFile = `youtube-${timestamp}`;
      tempFilePath = path.join(os.tmpdir(), `convert-${timestamp}.mp3`);

      safeLog('log', '[YouTube] Tentando conversão com ytdl-core...');
      try {
        const info = await getYouTubeInfoWithFallback({ ytdl, youtubeUrl, agent, cookieHeader, state });
        titleForFile = info?.videoDetails?.title || titleForFile;
        await convertWithYtdlCore({ ytdl, youtubeUrl, info, agent, cookieHeader, tempFilePath });
        safeLog('log', '[YouTube] ytdl-core concluído.');
      } catch (error) {
        if (isInvalidCookieHeaderError(error)) {
          return res.status(500).json({
            error: 'YOUTUBE_COOKIE_INVALID',
            message: 'O cookie do YouTube está em formato inválido no servidor.'
          });
        }

        if (isYoutubeBotChallenge(error)) {
          if (!isYtDlpFallbackEnabled()) {
            const retryAfterSeconds = Math.max(
              1,
              Number.parseInt(String(error?.retryAfterSeconds ?? ''), 10) || YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS
            );
            return botChallengeResponse(res, retryAfterSeconds);
          }

          safeLog.warn('[YouTube] ytdl-core bloqueado por anti-bot. Tentando fallback yt-dlp.');

          try {
            await runYtDlpToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath, cookieHeader, proxyUrl });
            safeLog('log', '[YouTube] yt-dlp fallback concluído.');
          } catch (fallbackError) {
            safeLog.warn('[YouTube] fallback yt-dlp também falhou.', {
              code: fallbackError?.code,
              message: fallbackError?.message
            });

            if (fallbackError?.code === 'YTDLP_NOT_AVAILABLE') {
              return res.status(500).json({
                error: 'YTDLP_NOT_AVAILABLE',
                message: 'yt-dlp/ffmpeg não está disponível no ambiente do servidor.'
              });
            }

            if (isYoutubeBotChallenge(fallbackError)) {
              return botChallengeResponse(res, YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS);
            }

            throw fallbackError;
          }
        }

        if (!isYoutubeBotChallenge(error)) throw error;
      }

      const fileName = `${safeFileName(titleForFile)}.mp3`;
      const storagePath = `${user_id}/yt-${timestamp}-${fileName}`;

      const fileBuffer = await fs.promises.readFile(tempFilePath);
      const { error: uploadError } = await supabaseAdmin.storage
        .from('converted-audio')
        .upload(storagePath, fileBuffer, {
          contentType: 'audio/mpeg',
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabaseAdmin.from('conversoes').insert({
        nome_arquivo: fileName,
        storage_path: storagePath,
        user_id
      });

      if (dbError) throw dbError;

      const {
        data: { publicUrl }
      } = supabaseAdmin.storage.from('converted-audio').getPublicUrl(storagePath);

      return res.status(200).json({
        ok: true,
        downloadUrl: publicUrl,
        fileName
      });
    } catch (error) {
      safeLog('error', '[YouTube] Erro Interno:', error);

      if (isInvalidCookieHeaderError(error)) {
        return res.status(500).json({
          error: 'YOUTUBE_COOKIE_INVALID',
          message: 'O cookie do YouTube está em formato inválido no servidor.'
        });
      }

      const ytdlpOutput = `${error?.stderr || ''} ${error?.stdout || ''}`.toLowerCase();
      const ytdlpBlocked =
        ytdlpOutput.includes("sign in to confirm") ||
        ytdlpOutput.includes('faca login para confirmar') ||
        ytdlpOutput.includes('too many requests') ||
        ytdlpOutput.includes('429');

      if (ytdlpBlocked || isYoutubeBotChallenge(error)) {
        const retryAfterSeconds = Math.max(
          1,
          Number.parseInt(String(error?.retryAfterSeconds ?? ''), 10) || YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS
        );
        return botChallengeResponse(res, retryAfterSeconds);
      }

      if (error?.code === 'YTDLP_NOT_AVAILABLE') {
        return res.status(500).json({
          error: 'YTDLP_NOT_AVAILABLE',
          message: 'yt-dlp/ffmpeg não está disponível no ambiente do servidor.'
        });
      }

      return internalServerErrorResponse(res, error);
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          await fs.promises.unlink(tempFilePath);
        } catch (cleanupError) {
          safeLog('error', '[YouTube] Erro ao limpar arquivo temporário:', cleanupError);
        }
      }
    }
  });

  return app;
}

module.exports = { createApp };
