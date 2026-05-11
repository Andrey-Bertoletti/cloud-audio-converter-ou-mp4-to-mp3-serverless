const test = require('node:test');
const assert = require('node:assert/strict');

function captureConsole() {
  const calls = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  console.log = (...args) => calls.push(['log', ...args]);
  console.warn = (...args) => calls.push(['warn', ...args]);
  console.error = (...args) => calls.push(['error', ...args]);

  return {
    calls,
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
  };
}

test('logMediaToolingHealth: ytDlpVersion fica null quando yt-dlp n\u00e3o existe e n\u00e3o vaza cookie/proxy', async () => {
  const originalEnv = { ...process.env };

  process.env.DISABLE_CLEANUP_CRON = '1';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';

  process.env.ENABLE_YTDLP_FALLBACK = 'true';
  process.env.YTDLP_PATH = '__definitely_not_a_real_yt_dlp_binary__';

  process.env.YOUTUBE_COOKIE = 'SID=super-secret-cookie';
  process.env.YOUTUBE_PROXY_URL = 'http://user:pass@proxy.example.com:8080';

  process.env.PATH = '';

  const consoleCapture = captureConsole();
  try {
    const { logMediaToolingHealth } = require('../server/index');
    await logMediaToolingHealth();

    const warnsAndErrors = consoleCapture.calls.filter((c) => c[0] === 'warn' || c[0] === 'error');
    assert.ok(warnsAndErrors.length > 0, 'expected at least one warn/error log');

    const metaArg = warnsAndErrors
      .map((c) => c[2])
      .find((m) => m && typeof m === 'object' && ('ytDlpVersion' in m || 'ffmpegVersion' in m));

    assert.ok(metaArg, 'expected log meta with ytDlpVersion/ffmpegVersion');
    assert.equal(metaArg.ytDlpVersion, null);

    const output = JSON.stringify(consoleCapture.calls);
    assert.ok(!output.includes('super-secret-cookie'));
    assert.ok(!output.includes('http://user:pass@proxy.example.com:8080'));
  } finally {
    consoleCapture.restore();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
});
