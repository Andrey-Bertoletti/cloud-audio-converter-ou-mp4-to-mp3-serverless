function isLikelyBase64(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  if (raw.length < 16) return false;
  if (raw.includes(';')) return false; // cookie header separator (not base64)
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return false;
  return raw.length % 4 === 0;
}

function tryDecodeBase64(input) {
  if (!isLikelyBase64(input)) return null;
  try {
    const decoded = Buffer.from(String(input), 'base64').toString('utf-8').trim();
    return decoded || null;
  } catch (_) {
    return null;
  }
}

function normalizeCookieHeader(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // Accept accidental prefix "Cookie:"
  const stripped = raw.replace(/^\s*cookie\s*:\s*/i, '').trim();
  if (!stripped) return '';

  const pairs = [];
  for (const part of stripped.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const name = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (!name || !value) continue;
    pairs.push([name, value]);
  }

  if (pairs.length === 0) return '';

  // Dedup by name (keep last)
  const map = new Map();
  for (const [name, value] of pairs) map.set(name, value);

  return Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function normalizeCookieJsonArray(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return '';
  }

  if (!Array.isArray(parsed)) return '';

  const map = new Map();
  for (const item of parsed) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const value = typeof item?.value === 'string' ? item.value.trim() : '';
    if (!name || !value) continue;
    map.set(name, value);
  }

  if (map.size === 0) return '';

  return Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
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
  const raw = String(input || '').trim();
  if (!raw) return '';

  // 1) Cookie header pronto
  const asHeader = normalizeCookieHeader(raw);
  if (asHeader) return asHeader;

  // 2) JSON array
  const asJson = normalizeCookieJsonArray(raw);
  if (asJson) return asJson;

  // 3) Base64 -> tenta novamente
  const decoded = tryDecodeBase64(raw);
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
  // exported for tests
  _private: {
    normalizeCookieHeader,
    normalizeCookieJsonArray,
    tryDecodeBase64
  }
};

