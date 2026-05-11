const SENSITIVE_HEADER_KEYS = ['authorization', 'cookie', 'set-cookie'];
const SENSITIVE_ENV_KEYS = [
  'YOUTUBE_COOKIE',
  'YOUTUBE_COOKIES',
  'YOUTUBE_COOKIE_BASE64',
  'YOUTUBE_COOKIES_BASE64',
  'YOUTUBE_COOKIE_HEADER',
  'YOUTUBE_COOKIE_HEADER_BASE64',
  'YOUTUBE_PROXY_URL',
  'YOUTUBE_PROXY_URI',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY'
];

function asString(value) {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function buildSecretsList() {
  const secrets = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      secrets.push(val.trim());
    }
  }
  return secrets;
}

function redactString(input) {
  let output = String(input ?? '');

  // Redact env values by exact match occurrences.
  for (const secret of buildSecretsList()) {
    if (secret.length < 8) continue;
    output = output.split(secret).join('[REDACTED]');
  }

  // Redact common header patterns
  output = output.replace(/(authorization\s*[:=]\s*)(bearer\s+)?([^\s"']+)/gi, '$1[REDACTED]');
  output = output.replace(/(\bcookie\s*[:=]\s*)([^;\n\r]+)/gi, '$1[REDACTED]');
  output = output.replace(/(\bset-cookie\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]');

  // Redact proxy credentials in URLs: scheme://user:pass@host
  output = output.replace(/([a-z]+:\/\/)([^:@\s]+):([^@\s]+)@/gi, '$1[REDACTED]:[REDACTED]@');

  return output;
}

function sanitizeForLog(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      code: value.code,
      statusCode: value.statusCode
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const out = {};
    for (const [rawKey, rawVal] of Object.entries(value)) {
      const key = String(rawKey);
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_HEADER_KEYS.includes(lowerKey) || SENSITIVE_ENV_KEYS.includes(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeForLog(rawVal, seen);
    }
    return out;
  }

  return redactString(asString(value));
}

function safeLog(level, message, meta) {
  const prefix = typeof message === 'string' ? message : asString(message);
  if (meta === undefined) {
    // eslint-disable-next-line no-console
    console[level](`[${level.toUpperCase()}] ${redactString(prefix)}`);
    return;
  }

  const sanitizedMeta = sanitizeForLog(meta);
  // eslint-disable-next-line no-console
  console[level](`[${level.toUpperCase()}] ${redactString(prefix)}`, sanitizedMeta);
}

module.exports = {
  redactString,
  sanitizeForLog,
  safeLog
};

