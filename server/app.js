const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { safeLog, redactString } = require('./utils/safeLog');
const { normalizeYoutubeCookie, assertValidCookieHeader } = require('./utils/normalizeYoutubeCookie');
const { runYtDlpToMp3, runYtDlpToMp4 } = require('./youtube/ytDlpFallback');
const { runPipedToMp3, runPipedToMp4 } = require('./youtube/pipedFallback');
const { runCobaltToMp3, runCobaltToMp4 } = require('./youtube/cobaltFallback');
const { runYoutubeiToMp3, runYoutubeiToMp4 } = require('./youtube/youtubeiFallback');

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
  const rawText = [
    error?.message,
    error?.code,
    error?.stderr,
    error?.stdout,
    error?.stack,
    error?.cause?.message,
    error?.cause?.code,
    error?.cause?.stderr,
    error?.cause?.stdout,
    String(error)
  ]
    .filter(Boolean)
    .join(' ');
  const text = rawText
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  return /yt_bot_challenge|youtube_bot_challenge|sign in to confirm|confirm youre not a bot|faca login para confirmar|nao e um bot|too many requests|http error 429|\b429\b/i.test(
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

function sanitizeLogText(value, maxLen = 900) {
  if (!value) return '';
  const redacted = redactString(String(value));
  return redacted
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function summarizeYtDlpStderr(stderr) {
  if (!stderr) return '';
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const important = lines.filter((l) =>
    /error:|\[youtube\]|sign in to confirm|confirm you're not a bot|not a bot|too many requests|\b429\b/i.test(l)
  );

  const picked = (important.length ? important : lines).slice(-8).join(' | ');
  return sanitizeLogText(picked);
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
    message: 'YouTube recusou a sessão/cookie ou bloqueou o IP/proxy usado pelo servidor.',
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
  const runYtDlpToMp4Fn = options.runYtDlpToMp4 || runYtDlpToMp4;
  const runPipedToMp3Fn = options.runPipedToMp3 || runPipedToMp3;
  const runPipedToMp4Fn = options.runPipedToMp4 || runPipedToMp4;
  const runCobaltToMp3Fn = options.runCobaltToMp3 || runCobaltToMp3;
  const runCobaltToMp4Fn = options.runCobaltToMp4 || runCobaltToMp4;
  const runYoutubeiToMp3Fn = options.runYoutubeiToMp3 || runYoutubeiToMp3;
  const runYoutubeiToMp4Fn = options.runYoutubeiToMp4 || runYoutubeiToMp4;

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

  function normalizeOrigin(value) {
    if (!value) return '';
    return String(value).trim().replace(/\/+$/, '').toLowerCase();
  }

  const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:4200')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  const allowAll = allowedOrigins.includes('*');
  safeLog('log', '[Backend][cors] origens permitidas: ' + (allowAll ? '* (qualquer)' : allowedOrigins.join(' | ')));

  const loggedRejectedOrigins = new Set();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowAll) return callback(null, true);
        if (allowedOrigins.includes(normalizeOrigin(origin))) {
          return callback(null, true);
        }
        if (!loggedRejectedOrigins.has(origin)) {
          loggedRejectedOrigins.add(origin);
          safeLog('warn', '[Backend][cors] REJEITADA: "' + origin + '" — adicione em FRONTEND_URLS se for legítima.');
        }
        return callback(null, false);
      },
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

      if (!nomeArquivo || typeof nomeArquivo !== 'string') {
        return res.status(400).json({ error: 'nomeArquivo é obrigatório.' });
      }
      if (nomeArquivo.length > 255) {
        return res.status(400).json({ error: 'nomeArquivo muito longo.' });
      }

      let safeStoragePath = null;
      if (storagePath != null) {
        if (typeof storagePath !== 'string' || storagePath.length > 512) {
          return res.status(400).json({ error: 'storagePath inválido.' });
        }
        const expectedPrefix = `${user_id}/`;
        if (!storagePath.startsWith(expectedPrefix) || storagePath.includes('..')) {
          return res.status(403).json({ error: 'storagePath fora do escopo do usuário.' });
        }
        safeStoragePath = storagePath;
      }

      const { error } = await supabaseAdmin.from('conversoes').insert({
        nome_arquivo: nomeArquivo,
        storage_path: safeStoragePath,
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

  async function handleYoutubeConvert(req, res, format) {
    const isMp4 = format === 'mp4';
    const extension = isMp4 ? 'mp4' : 'mp3';
    const contentType = isMp4 ? 'video/mp4' : 'audio/mpeg';
    // Reusa o bucket existente para evitar mudanças de schema/RLS
    const bucketName = 'converted-audio';

    let tempFilePath = '';
    try {
      const { youtubeUrl } = req.body;
      const user_id = req.user.id;

      if (!ytdl.validateURL(youtubeUrl)) {
        return res.status(400).json({ error: 'URL do YouTube inválida.' });
      }

      safeLog('log', `[YouTube] Iniciando conversão ${extension} para o usuário ${user_id}: ${youtubeUrl}`);

      const rawCookieInput = readYoutubeCookieEnvInput();
      const cookieHeader = normalizeYoutubeCookie(rawCookieInput);
      const proxyUrl = readYoutubeProxyUrl();
      const cookiesArray = cookieHeader ? cookieHeaderToCookieArray(cookieHeader) : [];

      safeLog.info('[YouTube] Cookie normalizado', {
        cookieCount: countCookiePairs(cookieHeader),
        hasCookie: Boolean(cookieHeader),
        headerLength: cookieHeader?.length || 0,
        target: extension
      });

      const agent = proxyUrl ? ytdl.createProxyAgent({ uri: proxyUrl }, cookiesArray) : ytdl.createAgent(cookiesArray);

      const timestamp = Date.now();
      let titleForFile = `youtube-${timestamp}`;
      tempFilePath = path.join(os.tmpdir(), `convert-${timestamp}.${extension}`);

      // Em IPs datacenter sem proxy residencial/WARP, ytdl-core e yt-dlp falham
      // 100% das vezes com bot-challenge. Pula direto pros fallbacks externos
      // (Cobalt/Piped) que extraem pelo IP deles.
      const skipDirectExtraction = !proxyUrl && process.env.YOUTUBE_FORCE_DIRECT !== '1';

      if (!isMp4) {
        if (skipDirectExtraction) {
          safeLog('log', '[YouTube] Sem proxy: pulando ytdl-core/yt-dlp, indo direto pros fallbacks externos.');
          const fallbackResult = await runExternalOnlyMp3Chain({ youtubeUrl, tempFilePath });
          if (!fallbackResult.ok) {
            return respondWithFallbackError(res, fallbackResult.error);
          }
          if (fallbackResult.title) titleForFile = fallbackResult.title;
        } else {
          safeLog('log', '[YouTube] Tentando conversão MP3 com ytdl-core...');
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

            if (!isYoutubeBotChallenge(error)) throw error;

            if (!isYtDlpFallbackEnabled()) {
              const retryAfterSeconds = Math.max(
                1,
                Number.parseInt(String(error?.retryAfterSeconds ?? ''), 10) || YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS
              );
              return botChallengeResponse(res, retryAfterSeconds);
            }

            safeLog.warn('[YouTube] ytdl-core bloqueado por anti-bot. Tentando fallback yt-dlp.');

            const fallbackResult = await runMp3FallbackChain({
              youtubeUrl,
              tempFilePath,
              rawCookieInput,
              cookieHeader,
              proxyUrl
            });

            if (!fallbackResult.ok) {
              return respondWithFallbackError(res, fallbackResult.error);
            }

            if (fallbackResult.title) {
              titleForFile = fallbackResult.title;
            }
          }
        }
      } else if (skipDirectExtraction) {
        safeLog('log', '[YouTube] Sem proxy: pulando yt-dlp MP4, indo direto pros fallbacks externos.');
        const result = await runExternalOnlyMp4Chain({ youtubeUrl, tempFilePath, cookieHeader });
        if (!result.ok) {
          return respondWithFallbackError(res, result.error);
        }
        if (result.title) titleForFile = result.title;
      } else {
        safeLog('log', '[YouTube] Iniciando conversão MP4 (yt-dlp + Piped fallback)...');

        let ytDlpFatalError = null;
        try {
          await runYtDlpToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath, rawCookieInput, cookieHeader, proxyUrl });
          safeLog('log', '[YouTube] yt-dlp MP4 concluído.');
        } catch (fallbackError) {
          ytDlpFatalError = fallbackError;
          safeLog.warn('[YouTube] yt-dlp MP4 falhou. Tentando Cobalt MP4.', {
            code: fallbackError?.code,
            exitCode: fallbackError?.exitCode,
            message: sanitizeLogText(fallbackError?.message),
            stderr: summarizeYtDlpStderr(fallbackError?.stderr)
          });

          if (fallbackError?.code === 'YTDLP_MISSING_URL') {
            return res.status(500).json({
              error: 'YTDLP_MISSING_URL',
              message: 'Falha interna: URL não foi enviada corretamente ao yt-dlp.'
            });
          }

          try {
            const ytiResult = await runYoutubeiToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath, cookie: cookieHeader });
            if (ytiResult?.title) titleForFile = ytiResult.title;
            ytDlpFatalError = null;
            safeLog.info('[YouTube] youtubei.js MP4 fallback concluído.', { source: ytiResult?.source });
          } catch (ytiError) {
            safeLog.warn('[YouTube] youtubei.js MP4 falhou. Tentando Cobalt MP4.', {
              code: ytiError?.code,
              message: sanitizeLogText(ytiError?.message)
            });
          }

          if (ytDlpFatalError) {
            try {
              const cobaltResult = await runCobaltToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath });
              if (cobaltResult?.title) titleForFile = cobaltResult.title;
              ytDlpFatalError = null;
              safeLog.info('[YouTube] Cobalt MP4 fallback concluído.', { source: cobaltResult?.source });
            } catch (cobaltError) {
              safeLog.warn('[YouTube] Cobalt MP4 falhou. Tentando Piped/Invidious MP4.', {
                code: cobaltError?.code,
                message: sanitizeLogText(cobaltError?.message)
              });
            }
          }

          if (ytDlpFatalError) {
            try {
              const pipedResult = await runPipedToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath });
              if (pipedResult?.title) {
                titleForFile = pipedResult.title;
              }
              ytDlpFatalError = null;
              safeLog.info('[YouTube] Piped/Invidious MP4 fallback concluído.', { source: pipedResult?.source });
            } catch (pipedError) {
              safeLog.warn('[YouTube] Piped/Invidious MP4 também falhou.', {
                code: pipedError?.code,
                message: sanitizeLogText(pipedError?.message)
              });
            }
          }

          if (ytDlpFatalError) {
            return respondWithFallbackError(res, ytDlpFatalError);
          }
        }
      }

      const fileName = `${safeFileName(titleForFile)}.${extension}`;
      const storagePath = `${user_id}/yt-${timestamp}-${fileName}`;

      const fileBuffer = await fs.promises.readFile(tempFilePath);
      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucketName)
        .upload(storagePath, fileBuffer, {
          contentType,
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
      } = supabaseAdmin.storage.from(bucketName).getPublicUrl(storagePath);

      return res.status(200).json({
        ok: true,
        downloadUrl: publicUrl,
        fileName,
        format: extension
      });
    } catch (error) {
      safeLog('error', '[YouTube] Erro Interno:', error);

      if (isInvalidCookieHeaderError(error)) {
        return res.status(500).json({
          error: 'YOUTUBE_COOKIE_INVALID',
          message: 'O cookie do YouTube está em formato inválido no servidor.'
        });
      }

      if (error?.code === 'YOUTUBE_SESSION_REJECTED') {
        return res.status(429).json({
          error: 'YOUTUBE_SESSION_REJECTED',
          message: 'YouTube recusou a sessão/cookie ou bloqueou o IP/proxy usado pelo servidor.',
          retryAfterSeconds: error?.retryAfterSeconds || 300
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

      if (error?.code === 'YTDLP_MISSING_URL') {
        return res.status(500).json({
          error: 'YTDLP_MISSING_URL',
          message: 'Falha interna: URL não foi enviada corretamente ao yt-dlp.'
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
  }

  // Chain "external only": pula yt-dlp/ytdl-core (que falham em IP datacenter)
  // e usa só Cobalt + Piped + youtubei.js. Usado quando o servidor não tem proxy.
  async function runExternalOnlyMp3Chain({ youtubeUrl, tempFilePath, cookieHeader }) {
    let lastError;

    try {
      const cobaltResult = await runCobaltToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath });
      safeLog.info('[YouTube] Cobalt MP3 OK.', { source: cobaltResult?.source });
      return { ok: true, title: cobaltResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] Cobalt MP3 falhou. Tentando Piped.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    try {
      const pipedResult = await runPipedToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath });
      safeLog.info('[YouTube] Piped MP3 OK.', { source: pipedResult?.source });
      return { ok: true, title: pipedResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] Piped MP3 falhou. Tentando youtubei.js.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    try {
      const ytiResult = await runYoutubeiToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath, cookie: cookieHeader });
      safeLog.info('[YouTube] youtubei.js MP3 OK.', { source: ytiResult?.source });
      return { ok: true, title: ytiResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] youtubei.js MP3 falhou — todos os fallbacks externos esgotados.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    return { ok: false, error: lastError };
  }

  async function runExternalOnlyMp4Chain({ youtubeUrl, tempFilePath, cookieHeader }) {
    let lastError;

    try {
      const cobaltResult = await runCobaltToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath });
      safeLog.info('[YouTube] Cobalt MP4 OK.', { source: cobaltResult?.source });
      return { ok: true, title: cobaltResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] Cobalt MP4 falhou. Tentando Piped.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    try {
      const pipedResult = await runPipedToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath });
      safeLog.info('[YouTube] Piped MP4 OK.', { source: pipedResult?.source });
      return { ok: true, title: pipedResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] Piped MP4 falhou. Tentando youtubei.js.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    try {
      const ytiResult = await runYoutubeiToMp4Fn({ youtubeUrl, outputMp4Path: tempFilePath, cookie: cookieHeader });
      safeLog.info('[YouTube] youtubei.js MP4 OK.', { source: ytiResult?.source });
      return { ok: true, title: ytiResult?.title };
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube] youtubei.js MP4 falhou — todos os fallbacks externos esgotados.', {
        code: err?.code,
        message: sanitizeLogText(err?.message)
      });
    }

    return { ok: false, error: lastError };
  }

  async function runMp3FallbackChain({ youtubeUrl, tempFilePath, rawCookieInput, cookieHeader, proxyUrl }) {
    let ytDlpFatalError = null;

    try {
      await runYtDlpToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath, rawCookieInput, cookieHeader, proxyUrl });
      safeLog('log', '[YouTube] yt-dlp fallback concluído.');
      return { ok: true };
    } catch (fallbackError) {
      safeLog.warn('[YouTube] fallback yt-dlp falhou. Tentando youtubei.js.', {
        code: fallbackError?.code,
        exitCode: fallbackError?.exitCode,
        message: sanitizeLogText(fallbackError?.message),
        stderr: summarizeYtDlpStderr(fallbackError?.stderr)
      });

      ytDlpFatalError = fallbackError;
    }

    try {
      const ytiResult = await runYoutubeiToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath, cookie: cookieHeader });
      safeLog.info('[YouTube] youtubei.js fallback concluído.', { source: ytiResult?.source });
      return { ok: true, title: ytiResult?.title };
    } catch (ytiError) {
      safeLog.warn('[YouTube] youtubei.js falhou. Tentando Cobalt.', {
        code: ytiError?.code,
        message: sanitizeLogText(ytiError?.message)
      });
    }

    try {
      const cobaltResult = await runCobaltToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath });
      safeLog.info('[YouTube] Cobalt fallback concluído.', { source: cobaltResult?.source });
      return { ok: true, title: cobaltResult?.title };
    } catch (cobaltError) {
      safeLog.warn('[YouTube] Cobalt falhou. Tentando Piped/Invidious.', {
        code: cobaltError?.code,
        message: sanitizeLogText(cobaltError?.message)
      });
    }

    try {
      const pipedResult = await runPipedToMp3Fn({ youtubeUrl, outputMp3Path: tempFilePath });
      safeLog.info('[YouTube] Piped/Invidious fallback concluído.', { source: pipedResult?.source });
      return { ok: true, title: pipedResult?.title };
    } catch (pipedError) {
      safeLog.warn('[YouTube] Piped/Invidious também falhou.', {
        code: pipedError?.code,
        message: sanitizeLogText(pipedError?.message)
      });
    }

    return { ok: false, error: ytDlpFatalError };
  }

  function respondWithFallbackError(res, fatalError) {
    if (fatalError?.code === 'YTDLP_MISSING_URL') {
      return res.status(500).json({
        error: 'YTDLP_MISSING_URL',
        message: 'Falha interna: URL não foi enviada corretamente ao yt-dlp.'
      });
    }

    if (fatalError?.code === 'YOUTUBE_SESSION_REJECTED') {
      return res.status(429).json({
        error: 'YOUTUBE_SESSION_REJECTED',
        message:
          'YouTube recusou os cookies de sessão neste servidor/proxy e todas as instâncias públicas falharam. Tente novamente em alguns minutos.',
        retryAfterSeconds: fatalError?.retryAfterSeconds || 300
      });
    }

    if (fatalError?.code === 'YTDLP_NOT_AVAILABLE') {
      return res.status(500).json({
        error: 'YTDLP_NOT_AVAILABLE',
        message: 'yt-dlp/ffmpeg não está disponível no ambiente do servidor.'
      });
    }

    if (isYoutubeBotChallenge(fatalError)) {
      return botChallengeResponse(res, YT_BOT_CHALLENGE_RETRY_AFTER_SECONDS);
    }

    return res.status(500).json({
      error: 'YTDLP_FALLBACK_FAILED',
      message: 'Todos os fallbacks (yt-dlp e Piped) falharam durante a conversão.'
    });
  }

  app.post('/api/youtube/convert', async (req, res) => {
    const requestedFormat = String(req.body?.format || 'mp3').toLowerCase();
    const format = requestedFormat === 'mp4' ? 'mp4' : 'mp3';
    return handleYoutubeConvert(req, res, format);
  });

  app.post('/api/youtube/convert-mp4', async (req, res) => {
    return handleYoutubeConvert(req, res, 'mp4');
  });

  return app;
}

module.exports = { createApp };
