const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const ffmpegPath = require('ffmpeg-static');
const { safeLog } = require('../utils/safeLog');

const execFileAsync = promisify(execFile);

let cachedDepsStatus = null;

const COOKIE_JSON_RE = /^\s*\[/;
const COOKIE_HEADER_RE = /[=;]/;
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;

async function getFirstLine(cmd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: 8000,
      windowsHide: true,
      ...options
    });
    const out = String(stdout || stderr || '').trim();
    return out.split(/\r?\n/)[0] || '';
  } catch (_) {
    return '';
  }
}

function normalizeExecutablePath(input) {
  return String(input ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function resolveYtDlpPath() {
  const candidates = [process.env.YTDLP_PATH, path.join(process.cwd(), '.bin', 'yt-dlp'), 'yt-dlp'].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizeExecutablePath(candidate);
    if (normalized === 'yt-dlp') return normalized;

    try {
      fs.accessSync(normalized, fs.constants.X_OK);
      return normalized;
    } catch {
      // continua
    }
  }

  return normalizeExecutablePath(process.env.YTDLP_PATH) || 'yt-dlp';
}

function maskPath(input) {
  const normalized = normalizeExecutablePath(input);
  if (!normalized) return normalized;
  if (normalized === 'yt-dlp') return normalized;

  try {
    const relative = path.relative(process.cwd(), normalized);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative;
    }
  } catch {
    // continua
  }

  return path.basename(normalized);
}

function assertValidYoutubeUrl(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') {
    const err = new Error('URL do YouTube ausente no fallback yt-dlp.');
    err.code = 'YTDLP_MISSING_URL';
    throw err;
  }

  const trimmed = videoUrl.trim();
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) {
    const err = new Error('URL do YouTube inválida no fallback yt-dlp.');
    err.code = 'YTDLP_INVALID_URL';
    throw err;
  }

  return trimmed;
}

function isMissingYoutubeUrlErrorText(text) {
  return /you must provide at least one url/i.test(String(text || ''));
}

function buildYtDlpArgs({ safeVideoUrl, outputMp3Path, cookieFilePath, proxyUrl }) {
  const base = outputMp3Path.endsWith('.mp3') ? outputMp3Path.slice(0, -4) : outputMp3Path;
  const outTemplate = `${base}.%(ext)s`;

  const args = [
    safeVideoUrl,
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--format',
    'bestaudio/best',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '--ffmpeg-location',
    ffmpegPath,
    '--output',
    outTemplate,
    '--cookies',
    cookieFilePath
  ];

  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }

  return args;
}

function logYtDlpFallbackStart({ safeVideoUrl, cookieFilePath, proxyUrl }) {
  let urlHost = '';
  try {
    urlHost = new URL(safeVideoUrl).host;
  } catch {
    urlHost = '';
  }

  safeLog.info('[YouTube] Iniciando yt-dlp fallback', {
    hasUrl: Boolean(safeVideoUrl),
    urlHost,
    argCount: buildYtDlpArgs({
      safeVideoUrl,
      outputMp3Path: '[temp].mp3',
      cookieFilePath,
      proxyUrl
    }).length,
    hasCookiesFile: Boolean(cookieFilePath),
    hasProxy: Boolean(proxyUrl),
    hasFfmpeg: Boolean(ffmpegPath),
    outputDir: '[temp]'
  });
}

async function checkYtDlpAndFfmpegAvailability() {
  if (cachedDepsStatus) return cachedDepsStatus;

  const status = {
    ok: false,
    ytDlpVersion: '',
    ytDlpPath: resolveYtDlpPath(),
    ffmpegVersion: '',
    ffmpegPath: ''
  };

  try {
    const ytDlpCandidates = [status.ytDlpPath, 'yt-dlp'].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

    for (const candidate of ytDlpCandidates) {
      const versionLine = await getFirstLine(candidate, ['--version']);
      if (versionLine) {
        status.ytDlpVersion = versionLine;
        status.ytDlpPath = candidate;
        break;
      }
    }

    const ffmpegCandidates = [];
    if (ffmpegPath && fs.existsSync(ffmpegPath)) ffmpegCandidates.push(ffmpegPath);
    ffmpegCandidates.push('ffmpeg');

    for (const candidate of ffmpegCandidates) {
      const versionLine = await getFirstLine(candidate, ['-version']);
      if (versionLine) {
        status.ffmpegVersion = versionLine;
        status.ffmpegPath = candidate;
        break;
      }
    }

    status.ok = Boolean(status.ytDlpVersion) && Boolean(status.ffmpegVersion);
  } catch (err) {
    safeLog('warn', '[YouTube][yt-dlp] Falha ao checar dependências (sem detalhes sensíveis).', {
      name: err?.name,
      code: err?.code,
      message: err?.message
    });
  }

  cachedDepsStatus = status;
  return status;
}

async function ensureYtDlpAndFfmpegAvailable() {
  const status = await checkYtDlpAndFfmpegAvailability();
  if (!status.ok) {
    const err = new Error('yt-dlp/ffmpeg não está disponível no ambiente do servidor.');
    err.code = 'YTDLP_NOT_AVAILABLE';
    throw err;
  }
  return status;
}

async function getExternalToolDiagnostics() {
  const status = await checkYtDlpAndFfmpegAvailability();

  return {
    ytDlpPath: maskPath(status.ytDlpPath || resolveYtDlpPath()),
    ytDlpAvailable: Boolean(status.ytDlpVersion),
    ytDlpVersion: status.ytDlpVersion || null,
    ffmpegAvailable: Boolean(status.ffmpegVersion),
    ffmpegVersion: status.ffmpegVersion || null
  };
}

function stripWrappingQuotes(input) {
  const raw = String(input ?? '');
  if (raw.length < 2) return raw;

  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

function stripInvisibleChars(input) {
  return String(input ?? '').replace(
    /[\u0000-\u001F\u007F\u00A0\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g,
    ''
  );
}

function normalizeRawInput(input) {
  let raw = stripInvisibleChars(String(input ?? ''));
  raw = raw.trim();
  raw = stripWrappingQuotes(raw).trim();
  raw = stripInvisibleChars(raw);
  return raw.trim();
}

function isLikelyBase64(input) {
  const raw = String(input ?? '').replace(/\s+/g, '').trim();
  if (!raw) return false;
  if (raw.length < 16) return false;
  if (!BASE64_RE.test(raw)) return false;
  if (raw.includes(';')) return false;
  if (COOKIE_JSON_RE.test(raw)) return false;
  return true;
}

function tryDecodeBase64(input) {
  const raw = String(input ?? '').replace(/\s+/g, '').trim();
  if (!isLikelyBase64(raw)) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const cleaned = normalizeRawInput(decoded);
    return cleaned || null;
  } catch (_) {
    return null;
  }
}

function sanitizeSpawnCause(error) {
  if (!error) return null;
  return {
    name: error?.name,
    message: String(error?.message || ''),
    code: error?.code,
    errno: error?.errno
  };
}

function tryParseCookieJsonArray(input) {
  const raw = normalizeRawInput(input);
  if (!raw || !COOKIE_JSON_RE.test(raw)) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function sanitizeNetscapeField(value) {
  return stripInvisibleChars(String(value ?? ''))
    .replace(/[\r\n\t]/g, '')
    .trim();
}

function normalizeCookieDomain(domain) {
  const raw = sanitizeNetscapeField(domain);
  if (!raw) return '.youtube.com';
  if (!/^[.#A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw)) return '.youtube.com';
  return raw;
}

function cookieArrayToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by backend (do not commit).', ''];

  for (const cookie of cookies || []) {
    const name = sanitizeNetscapeField(cookie?.name);
    const value = sanitizeNetscapeField(cookie?.value);
    if (!name || !value) continue;

    const domain = normalizeCookieDomain(cookie?.domain);
    const pathValue = sanitizeNetscapeField(cookie?.path) || '/';

    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const isSecureByName = name.startsWith('__Secure-') || name.startsWith('__Host-');
    const secure = cookie?.secure === true || isSecureByName ? 'TRUE' : 'FALSE';

    let expiry = 0;
    const expRaw = cookie?.expirationDate ?? cookie?.expiry ?? cookie?.expires;
    if (typeof expRaw === 'number' && Number.isFinite(expRaw) && expRaw > 0) {
      expiry = Math.floor(expRaw);
    } else if (typeof expRaw === 'string' && expRaw.trim()) {
      const n = Number.parseFloat(expRaw);
      if (Number.isFinite(n) && n > 0) expiry = Math.floor(n);
    }

    const httpOnly = cookie?.httpOnly === true;
    const domainField = httpOnly ? `#HttpOnly_${domain}` : domain;

    lines.push([domainField, includeSubdomains, pathValue, secure, String(expiry), name, value].join('\t'));
  }

  lines.push('');
  return lines.join('\n');
}

function cookieHeaderToCookieArray(cookieHeader) {
  const header = normalizeRawInput(cookieHeader);
  if (!header || COOKIE_JSON_RE.test(header)) return [];
  if (!COOKIE_HEADER_RE.test(header)) return [];

  const out = [];
  for (const part of header.split(';')) {
    const piece = sanitizeNetscapeField(part);
    if (!piece) continue;
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const name = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (!name || !value) continue;

    out.push({
      domain: '.youtube.com',
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: 2147483647,
      name,
      value
    });
  }

  return out;
}

function detectCookieNames(cookies) {
  const set = new Set();
  for (const cookie of cookies || []) {
    if (cookie?.name) set.add(String(cookie.name));
  }
  return set;
}

async function validateCookiesNetscapeStructure(cookies) {
  const diagnostics = {
    cookieCount: 0,
    youtubeCookieCount: 0,
    googleCookieCount: 0,
    expiredCookieCount: 0,
    hasLoginInfo: false,
    hasSid: false,
    hasHsid: false,
    hasSsid: false,
    hasSapisid: false,
    hasSecure1PSid: false,
    hasSecure3PSid: false,
    allSecureCookiesMarkedSecure: true,
    hasHttpOnlyPrefix: false
  };

  if (!cookies || !Array.isArray(cookies)) return diagnostics;

  const now = Math.floor(Date.now() / 1000);
  const names = detectCookieNames(cookies);
  const secureCookieNames = new Set();

  for (const cookie of cookies) {
    if (!cookie?.name || !cookie?.value) continue;

    diagnostics.cookieCount += 1;

    const domain = String(cookie?.domain || '').toLowerCase();
    if (domain.includes('youtube.com')) diagnostics.youtubeCookieCount += 1;
    if (domain.includes('google.com')) diagnostics.googleCookieCount += 1;

    const expiry = cookie?.expirationDate ?? cookie?.expiry ?? cookie?.expires;
    if (typeof expiry === 'number' && expiry > 0 && expiry < now) {
      diagnostics.expiredCookieCount += 1;
    }

    const cookieName = String(cookie?.name);
    if (cookieName.startsWith('__Secure-') || cookieName.startsWith('__Host-')) {
      secureCookieNames.add(cookieName);
      if (cookie?.secure !== true) {
        diagnostics.allSecureCookiesMarkedSecure = false;
      }
    }

    if (cookie?.httpOnly === true) {
      diagnostics.hasHttpOnlyPrefix = true;
    }
  }

  diagnostics.hasLoginInfo = names.has('LOGIN_INFO');
  diagnostics.hasSid = names.has('SID');
  diagnostics.hasHsid = names.has('HSID');
  diagnostics.hasSsid = names.has('SSID');
  diagnostics.hasSapisid = names.has('SAPISID');
  diagnostics.hasSecure1PSid = names.has('__Secure-1PSID');
  diagnostics.hasSecure3PSid = names.has('__Secure-3PSID');

  return diagnostics;
}

async function writeYoutubeCookiesNetscape({ rawCookieInput, cookieHeader, outputPath }) {
  const raw = normalizeRawInput(rawCookieInput);
  let cookieArray = tryParseCookieJsonArray(raw);

  if (!cookieArray) {
    const decoded = tryDecodeBase64(raw);
    if (decoded) cookieArray = tryParseCookieJsonArray(decoded);
  }

  let cookies;
  if (cookieArray && cookieArray.length > 0) {
    cookies = cookieArray;
  } else {
    cookies = cookieHeaderToCookieArray(cookieHeader);
  }

  const content = cookieArrayToNetscape(cookies);
  await fs.promises.writeFile(outputPath, content, { encoding: 'utf-8', mode: 0o600 });

  if (!fs.existsSync(outputPath)) {
    const err = new Error('Falha ao criar arquivo cookies Netscape para yt-dlp.');
    err.code = 'YTDLP_COOKIEFILE_WRITE_FAILED';
    throw err;
  }

  const diagnostics = await validateCookiesNetscapeStructure(cookies);

  safeLog.info('[YouTube] Diagnóstico cookies Netscape', diagnostics);

  if (diagnostics.cookieCount < 5) {
    const err = new Error('Arquivo cookies Netscape parece incompleto (poucos cookies).');
    err.code = 'YTDLP_COOKIEFILE_TOO_SMALL';
    throw err;
  }

  if (!diagnostics.hasLoginInfo) {
    safeLog.warn('[YouTube] Cookie essencial LOGIN_INFO não encontrado', {
      presentCookies: diagnostics.cookieCount,
      hasSecure1PSid: diagnostics.hasSecure1PSid,
      hasSecure3PSid: diagnostics.hasSecure3PSid
    });
  }
}

function collectOutput(stream, maxBytes = 64 * 1024) {
  let data = '';
  let total = 0;
  return new Promise((resolve) => {
    if (!stream) return resolve('');
    stream.on('data', (chunk) => {
      if (total >= maxBytes) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const slice = buf.slice(0, Math.max(0, maxBytes - total));
      total += slice.length;
      data += slice.toString('utf-8');
    });
    stream.on('close', () => resolve(data));
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}

function maskProxyUrl(value) {
  if (!value) return value;

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch (_) {
    return String(value).replace(/\/\/([^:@\s]+):([^@\s]+)@/g, '//***:***@');
  }
}

function runYtDlp(args, { timeoutMs = 120000, ytdlpPath } = {}) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === 'string')) {
    const err = new Error('Invalid yt-dlp args');
    err.code = 'YTDLP_INVALID_ARGS';
    throw err;
  }

  const cmd = normalizeExecutablePath(ytdlpPath || resolveYtDlpPath());

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        // ignore
      }

      const err = new Error('yt-dlp timeout');
      err.code = 'YTDLP_TIMEOUT';
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      const err = new Error('yt-dlp spawn failed');
      err.code = 'YTDLP_SPAWN_FAILED';
      // Never attach raw spawn error: it may contain spawnargs/cmd (can leak proxy credentials).
      err.cause = sanitizeSpawnCause(error);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const err = new Error('yt-dlp failed');
      err.code = 'YTDLP_FAILED';
      err.exitCode = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function runYtDlpMetadataProbe({ videoUrl, cookiesPath, proxyUrl, timeoutMs }) {
  const safeVideoUrl = assertValidYoutubeUrl(videoUrl);
  const ytdlpPath = resolveYtDlpPath();

  const args = [
    safeVideoUrl,
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--dump-json',
    '--skip-download'
  ];

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }

  try {
    const { stdout, stderr } = await runYtDlp(args, {
      timeoutMs: timeoutMs || 30000,
      ytdlpPath
    });

    let metadata = null;
    try {
      metadata = JSON.parse(stdout);
    } catch (_) {
      // Ignore JSON parse errors; metadata may be null
    }

    return {
      success: true,
      metadata,
      stderr
    };
  } catch (err) {
    const combinedText = `${err?.stderr || ''} ${err?.stdout || ''}`.toLowerCase();

    if (
      combinedText.includes('sign in to confirm') ||
      (combinedText.includes('use') && combinedText.includes('--cookies'))
    ) {
      return {
        success: false,
        error: 'YOUTUBE_SESSION_REJECTED',
        message: 'YouTube recusou os cookies de sessão neste servidor/proxy.',
        stderr: err?.stderr
      };
    }

    return {
      success: false,
      error: err?.code || 'YTDLP_METADATA_PROBE_FAILED',
      message: err?.message,
      stderr: err?.stderr
    };
  }
}

async function runYtDlpToMp3({ youtubeUrl, outputMp3Path, rawCookieInput, cookieHeader, proxyUrl, timeoutMs }) {
  const status = await ensureYtDlpAndFfmpegAvailable();
  const ytdlpPath = status.ytDlpPath || resolveYtDlpPath();
  const safeVideoUrl = assertValidYoutubeUrl(youtubeUrl);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-'));
  const cookieFilePath = path.join(tempDir, 'cookies.txt');

  try {
    // 1) Cookies em arquivo Netscape (evita vazar cookie em argv)
    await writeYoutubeCookiesNetscape({ rawCookieInput, cookieHeader, outputPath: cookieFilePath });

    // 2) Saída: yt-dlp usa template. Geramos base e esperamos ".mp3"
    const base = outputMp3Path.endsWith('.mp3') ? outputMp3Path.slice(0, -4) : outputMp3Path;
    const args = buildYtDlpArgs({
      safeVideoUrl,
      outputMp3Path,
      cookieFilePath,
      proxyUrl
    });

    logYtDlpFallbackStart({ safeVideoUrl, cookieFilePath, proxyUrl });

    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await runYtDlp(args, { timeoutMs: timeoutMs || 120000, ytdlpPath }));
    } catch (err) {
      const combinedText = `${err?.stderr || ''} ${err?.stdout || ''} ${err?.message || ''}`;
      if (isMissingYoutubeUrlErrorText(combinedText)) {
        const urlErr = new Error('Falha interna: URL não foi enviada corretamente ao yt-dlp.');
        urlErr.code = 'YTDLP_MISSING_URL';
        urlErr.exitCode = err?.exitCode;
        urlErr.stdout = err?.stdout;
        urlErr.stderr = err?.stderr;
        throw urlErr;
      }

      if (
        (err?.stderr || '').includes('Sign in to confirm') &&
        ((err?.stderr || '').includes('--cookies-from-browser') || (err?.stderr || '').includes('--cookies'))
      ) {
        const sessionErr = new Error('YouTube recusou os cookies de sessão neste servidor/proxy.');
        sessionErr.code = 'YOUTUBE_SESSION_REJECTED';
        sessionErr.retryAfterSeconds = 300;
        sessionErr.exitCode = err?.exitCode;
        sessionErr.stdout = err?.stdout;
        sessionErr.stderr = err?.stderr;
        throw sessionErr;
      }

      throw err;
    }

    const expected = `${base}.mp3`;
    if (!fs.existsSync(expected)) {
      const error = new Error('yt-dlp finalizou sem gerar o mp3 esperado.');
      error.code = 'YTDLP_NO_OUTPUT';
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }

    // Normaliza para o caminho de saída pedido
    if (expected !== outputMp3Path) {
      await fs.promises.rename(expected, outputMp3Path);
    }
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      safeLog('error', '[YouTube][yt-dlp] Falha ao limpar arquivos temporários:', cleanupErr);
    }
  }
}

module.exports = {
  checkYtDlpAndFfmpegAvailability,
  buildYtDlpArgs,
  logYtDlpFallbackStart,
  getExternalToolDiagnostics,
  assertValidYoutubeUrl,
  maskPath,
  resolveYtDlpPath,
  runYtDlpToMp3,
  runYtDlpMetadataProbe,
  _private: {
    cookieArrayToNetscape,
    writeYoutubeCookiesNetscape,
    validateCookiesNetscapeStructure,
    maskProxyUrl,
    buildYtDlpArgs,
    logYtDlpFallbackStart,
    runYtDlp,
    assertValidYoutubeUrl,
    isMissingYoutubeUrlErrorText,
    resolveYtDlpPath,
    maskPath
  }
};
