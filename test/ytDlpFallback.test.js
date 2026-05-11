const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _private } = require('../server/youtube/ytDlpFallback');

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
