const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_SAFE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

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

function compactWhitespace(input) {
  return String(input ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isLikelyBase64(input) {
  const raw = String(input ?? '')
    .replace(/\s+/g, '')
    .trim();
  if (!raw) return false;
  if (raw.length < 16) return false;
  if (raw.includes(';')) return false; // cookie header separator (not base64)
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return false;
  return raw.length % 4 === 0;
}

function tryDecodeBase64(input) {
  const raw = String(input ?? '')
    .replace(/\s+/g, '')
    .trim();
  if (!isLikelyBase64(raw)) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const cleaned = normalizeRawInput(decoded);
    return cleaned || null;
  } catch (_) {
    return null;
  }
}

function normalizeCookieName(name) {
  const raw = compactWhitespace(stripInvisibleChars(name)).trim();
  const stripped = stripWrappingQuotes(raw).trim();
  if (!stripped) return '';
  if (!COOKIE_NAME_RE.test(stripped)) return '';
  return stripped;
}

function normalizeCookieValue(value) {
  let raw = compactWhitespace(stripInvisibleChars(value));
  raw = stripWrappingQuotes(raw).trim();
  if (!raw) return '';

  // Cookie header value can't contain ";" nor newlines. If it contains anything outside cookie-octet,
  // encode to prevent undici/ytdl-core from rejecting the whole header.
  const encoded = COOKIE_VALUE_SAFE_RE.test(raw) ? raw : encodeURIComponent(raw);
  return encoded.trim();
}

function pairsToHeader(pairs) {
  if (!pairs || pairs.length === 0) return '';

  const map = new Map();
  for (const [rawName, rawValue] of pairs) {
    const name = normalizeCookieName(rawName);
    if (!name) continue;
    const value = normalizeCookieValue(rawValue);
    if (!value) continue;
    map.set(name, value);
  }

  if (map.size === 0) return '';

  const cookieHeader = Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

  assertValidCookieHeader(cookieHeader);
  return cookieHeader;
}

function normalizeCookieHeader(input) {
  const raw0 = normalizeRawInput(input);
  if (!raw0) return '';

  // If it looks like JSON, do not attempt cookie-header parsing.
  if (/^\s*[[{]/.test(raw0)) return '';

  // Accept accidental prefix "Cookie:" or "YOUTUBE_COOKIE:"
  const stripped = compactWhitespace(raw0.replace(/^\s*(cookie|youtube_cookie)\s*:\s*/i, ''));
  if (!stripped) return '';

  const pairs = [];
  for (const part of stripped.split(';')) {
    const piece = compactWhitespace(part);
    if (!piece) continue;
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const name = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (!name || !value) continue;
    pairs.push([name, value]);
  }

  return pairsToHeader(pairs);
}

function normalizeCookieJsonArray(input) {
  const raw0 = normalizeRawInput(input);
  if (!raw0) return '';

  let parsed;
  try {
    parsed = JSON.parse(raw0);
  } catch (_) {
    return '';
  }

  if (!Array.isArray(parsed)) return '';

  const pairs = [];
  for (const item of parsed) {
    const name = typeof item?.name === 'string' ? item.name : '';
    const value = typeof item?.value === 'string' ? item.value : '';
    if (!name || !value) continue;
    pairs.push([name, value]);
  }

  return pairsToHeader(pairs);
}

function assertValidCookieHeader(cookieHeader) {
  if (!cookieHeader) return;

  if (/[\r\n]/.test(cookieHeader)) {
    throw new Error('Invalid normalized YouTube cookie: contains newline');
  }

  if (/[\[\]{}"]/.test(cookieHeader)) {
    throw new Error('Invalid normalized YouTube cookie: appears to contain raw JSON');
  }

  const parts = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new Error('Invalid normalized YouTube cookie: malformed cookie pair');
    }

    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (!COOKIE_NAME_RE.test(name)) {
      throw new Error('Invalid normalized YouTube cookie: invalid cookie name');
    }

    if (/[\r\n;]/.test(value)) {
      throw new Error('Invalid normalized YouTube cookie: invalid cookie value');
    }
  }
}

/**
 * normalizeYoutubeCookie(input: string): string
 *
 * Aceita:
 *  - JSON array exportado por extensão (obj com {name,value})
 *  - Cookie header: "NAME=value; NAME2=value2"
 *  - Base64 que decodifica para JSON array ou cookie header
 *
 * Retorna sempre um Cookie header válido ou string vazia.
 */
function normalizeYoutubeCookie(input) {
  const raw0 = normalizeRawInput(input);
  if (!raw0) return '';

  // 1) Cookie header pronto
  const asHeader = normalizeCookieHeader(raw0);
  if (asHeader) return asHeader;

  // 2) JSON array
  const asJson = normalizeCookieJsonArray(raw0);
  if (asJson) return asJson;

  // 3) Base64 -> tenta novamente
  const decoded = tryDecodeBase64(raw0);
  if (decoded) {
    const fromDecodedHeader = normalizeCookieHeader(decoded);
    if (fromDecodedHeader) return fromDecodedHeader;
    const fromDecodedJson = normalizeCookieJsonArray(decoded);
    if (fromDecodedJson) return fromDecodedJson;
  }

  return '';
}

module.exports = {
  normalizeYoutubeCookie,
  assertValidCookieHeader,
  // exported for tests
  _private: {
    normalizeCookieHeader,
    normalizeCookieJsonArray,
    tryDecodeBase64,
    normalizeCookieName,
    normalizeCookieValue,
    assertValidCookieHeader
  }
};
