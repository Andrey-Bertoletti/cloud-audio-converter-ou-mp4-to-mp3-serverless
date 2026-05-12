const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _private } = require('../server/youtube/ytDlpFallback');

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

test('ytDlpFallback: runYtDlp não vaza proxy nem args no erro', async () => {
  const proxyUrl = 'http://user:pass@proxy.example.com:8080';

  try {
    await _private.runYtDlp(['--proxy', proxyUrl, '--version'], {
      ytdlpPath: '__definitely_not_a_real_yt_dlp_binary__',
      timeoutMs: 2000
    });
    assert.fail('expected runYtDlp to throw');
  } catch (err) {
    const combined = [
      String(err),
      err?.stack || '',
      JSON.stringify(err),
      JSON.stringify(err?.cause || {})
    ].join(' ');

    assert.ok(!combined.includes(proxyUrl));
    assert.ok(!combined.includes('user:pass'));
    assert.ok(!combined.includes('--proxy'));
    assert.ok(!combined.includes('spawnargs'));
    assert.ok(!combined.includes('cmd'));
  }
});

test('ytDlpFallback: monta args planos com URL, cookies e proxy', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-args-'));
  const cookieFilePath = path.join(tempDir, 'cookies.txt');
  const outputPath = path.join(tempDir, 'out.mp3');
  const proxyUrl = 'http://127.0.0.1:8080';

  try {
    const args = _private.buildYtDlpArgs({
      safeVideoUrl: 'https://youtu.be/KlKKYMQOXr4',
      outputMp3Path: outputPath,
      cookieFilePath,
      proxyUrl
    });

    assert.ok(Array.isArray(args));
    assert.ok(args.every((arg) => typeof arg === 'string'));
    assert.equal(args[0], 'https://youtu.be/KlKKYMQOXr4');
    assert.ok(args.includes('--cookies'));
    assert.ok(args.includes('--proxy'));
    assert.equal(args[args.indexOf('--cookies') + 1], cookieFilePath);
    assert.equal(args[args.indexOf('--proxy') + 1], proxyUrl);
    assert.ok(!args.some(Array.isArray));

    const consoleCapture = captureConsole();
    try {
      _private.logYtDlpFallbackStart({
        safeVideoUrl: 'https://youtu.be/KlKKYMQOXr4',
        cookieFilePath,
        proxyUrl
      });

      const output = JSON.stringify(consoleCapture.calls);
      assert.ok(output.includes('[YouTube] Iniciando yt-dlp fallback'));
      assert.ok(output.includes('hasUrl'));
      assert.ok(output.includes('urlHost'));
      assert.ok(!output.includes(proxyUrl));
      assert.ok(!output.includes('SID=abc'));
      assert.ok(!output.includes('https://youtu.be/KlKKYMQOXr4'));
    } finally {
      consoleCapture.restore();
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('ytDlpFallback: rejeita args inválidos antes de chamar spawn', async () => {
  assert.throws(() => _private.runYtDlp([], { ytdlpPath: '__definitely_not_a_real_yt_dlp_binary__' }), {
    code: 'YTDLP_INVALID_ARGS'
  });

  assert.throws(() => _private.runYtDlp(['ok', ['nested']], { ytdlpPath: '__definitely_not_a_real_yt_dlp_binary__' }), {
    code: 'YTDLP_INVALID_ARGS'
  });
});

test('ytDlpFallback: rejeita URL ausente antes de chamar spawn', async () => {
  assert.throws(() => _private.assertValidYoutubeUrl(''), { code: 'YTDLP_MISSING_URL' });

  assert.throws(() => _private.assertValidYoutubeUrl('https://example.com/video'), { code: 'YTDLP_INVALID_URL' });
});

test('ytDlpFallback: writeYoutubeCookiesNetscape gera linhas válidas e preserva #HttpOnly_', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-cookies-'));
  const outputPath = path.join(tempDir, 'cookies.txt');

  try {
    const cookies = [
      {
        domain: '.youtube.com',
        path: '/',
        secure: false,
        httpOnly: true,
        expirationDate: 1793926880,
        name: '__Secure-1PSID',
        value: 'AAA'
      },
      { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: 1793926880, name: 'SID', value: 'BBB' },
      { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: 1793926880, name: 'HSID', value: 'CCC' },
      { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: 1793926880, name: 'SSID', value: 'DDD' },
      { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: 1793926880, name: 'SAPISID', value: 'EEE' }
    ];

    await _private.writeYoutubeCookiesNetscape({
      rawCookieInput: JSON.stringify(cookies),
      cookieHeader: '',
      outputPath
    });

    const content = await fs.promises.readFile(outputPath, 'utf-8');
    assert.ok(content.startsWith('# Netscape HTTP Cookie File'));

    const cookieLines = content
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')));

    assert.ok(cookieLines.length >= 5);
    for (const line of cookieLines) {
      const parts = line.split('\t');
      assert.equal(parts.length, 7, `expected 7 tab-separated columns, got ${parts.length}: ${line}`);
    }

    const httpOnlyLine = content
      .split(/\r?\n/)
      .find((l) => l.startsWith('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1793926880\t__Secure-1PSID\tAAA'));
    assert.ok(httpOnlyLine, 'expected httpOnly cookie to use #HttpOnly_ prefix and secure=TRUE for __Secure-*');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('ytDlpFallback: valida diagnóstico de cookies com essenciais e expirados', async () => {
  const { validateCookiesNetscapeStructure } = _private;

  const now = Math.floor(Date.now() / 1000);
  const futureExpiry = now + 86400 * 30; // 30 dias no futuro
  const pastExpiry = now - 86400; // 1 dia no passado

  const cookies = [
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: pastExpiry, name: 'OLD_COOKIE', value: 'expired' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'LOGIN_INFO', value: 'abc123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'SID', value: 'sid123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'HSID', value: 'hsid123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'SSID', value: 'ssid123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'SAPISID', value: 'sapis123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: true, expirationDate: futureExpiry, name: '__Secure-1PSID', value: 'psid1' },
    { domain: '.google.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'NID', value: 'nid123' }
  ];

  const diag = await validateCookiesNetscapeStructure(cookies);

  assert.equal(diag.cookieCount, 8);
  assert.equal(diag.youtubeCookieCount, 7);
  assert.equal(diag.googleCookieCount, 1);
  assert.equal(diag.expiredCookieCount, 1);
  assert.ok(diag.hasLoginInfo);
  assert.ok(diag.hasSid);
  assert.ok(diag.hasHsid);
  assert.ok(diag.hasSsid);
  assert.ok(diag.hasSapisid);
  assert.ok(diag.hasSecure1PSid);
  assert.ok(diag.allSecureCookiesMarkedSecure);
  assert.ok(diag.hasHttpOnlyPrefix);
});

test('ytDlpFallback: detecta essenciais ausentes no diagnóstico', async () => {
  const { validateCookiesNetscapeStructure } = _private;

  const futureExpiry = Math.floor(Date.now() / 1000) + 86400 * 30;

  const cookies = [
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'SID', value: 'sid123' },
    { domain: '.youtube.com', path: '/', secure: true, httpOnly: false, expirationDate: futureExpiry, name: 'HSID', value: 'hsid123' }
  ];

  const diag = await validateCookiesNetscapeStructure(cookies);

  assert.equal(diag.cookieCount, 2);
  assert.ok(!diag.hasLoginInfo);
  assert.ok(!diag.hasSapisid);
  assert.ok(!diag.hasSecure1PSid);
});
