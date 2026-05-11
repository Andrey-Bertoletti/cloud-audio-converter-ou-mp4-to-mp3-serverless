const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const { resolveYtDlpPath } = require('../server/youtube/ytDlpFallback');

function snapshotEnv(keys) {
  const out = {};
  for (const key of keys) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test('resolveYtDlpPath: usa YTDLP_PATH quando o caminho existe', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-path-'));
  const binaryPath = path.join(tempDir, 'yt-dlp');
  const originalEnv = snapshotEnv(['YTDLP_PATH']);

  try {
    await fs.promises.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.YTDLP_PATH = binaryPath;

    assert.equal(resolveYtDlpPath(), binaryPath);
  } finally {
    restoreEnv(originalEnv);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveYtDlpPath: usa .bin/yt-dlp quando existe', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-bin-'));
  const originalCwd = process.cwd();
  const originalEnv = snapshotEnv(['YTDLP_PATH']);

  try {
    const binDir = path.join(tempDir, '.bin');
    await fs.promises.mkdir(binDir, { recursive: true });

    const binaryPath = path.join(binDir, 'yt-dlp');
    await fs.promises.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    delete process.env.YTDLP_PATH;
    process.chdir(tempDir);

    assert.equal(resolveYtDlpPath(), binaryPath);
  } finally {
    process.chdir(originalCwd);
    restoreEnv(originalEnv);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('logMediaToolingHealth: falha quando fallback é obrigatório e yt-dlp não existe', async () => {
  const originalEnv = snapshotEnv([
    'DISABLE_CLEANUP_CRON',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ENABLE_YTDLP_FALLBACK',
    'YTDLP_PATH',
    'YOUTUBE_COOKIE',
    'YOUTUBE_PROXY_URL',
    'PATH',
    'NODE_ENV'
  ]);

  process.env.DISABLE_CLEANUP_CRON = '1';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';
  process.env.ENABLE_YTDLP_FALLBACK = 'true';
  process.env.YTDLP_PATH = '__definitely_not_a_real_yt_dlp_binary__';
  process.env.YOUTUBE_COOKIE = 'SID=super-secret-cookie';
  process.env.YOUTUBE_PROXY_URL = 'http://user:pass@proxy.example.com:8080';
  process.env.PATH = '';

  const originalCwd = process.cwd();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-health-'));
  const consoleCapture = captureConsole();
  const originalExit = process.exit;

  try {
    process.chdir(tempDir);
    process.exit = (code) => {
      const err = new Error('process.exit called');
      err.exitCode = code;
      throw err;
    };

    const { logMediaToolingHealth } = require('../server/index');
    await assert.rejects(() => logMediaToolingHealth(), (err) => err?.exitCode === 1);

    const output = JSON.stringify(consoleCapture.calls);
    assert.ok(output.includes('[Backend] Ferramentas externas'));
    assert.ok(output.includes('ytDlpPath'));
    assert.ok(output.includes('ytDlpAvailable'));
    assert.ok(output.includes('ffmpegAvailable'));
    assert.ok(!output.includes('super-secret-cookie'));
    assert.ok(!output.includes('http://user:pass@proxy.example.com:8080'));
  } finally {
    process.exit = originalExit;
    consoleCapture.restore();
    process.chdir(originalCwd);
    restoreEnv(originalEnv);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('logMediaToolingHealth: não falha quando ENABLE_YTDLP_FALLBACK=false e yt-dlp não existe', async () => {
  const originalEnv = snapshotEnv([
    'DISABLE_CLEANUP_CRON',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ENABLE_YTDLP_FALLBACK',
    'YTDLP_PATH',
    'PATH',
    'NODE_ENV'
  ]);

  process.env.DISABLE_CLEANUP_CRON = '1';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';
  process.env.ENABLE_YTDLP_FALLBACK = 'false';
  process.env.YTDLP_PATH = '__definitely_not_a_real_yt_dlp_binary__';
  process.env.PATH = '';

  const originalCwd = process.cwd();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-health-off-'));
  const consoleCapture = captureConsole();

  try {
    process.chdir(tempDir);
    const { logMediaToolingHealth } = require('../server/index');
    await logMediaToolingHealth();

    const output = JSON.stringify(consoleCapture.calls);
    assert.ok(output.includes('[Backend] Ferramentas externas'));
    assert.ok(output.includes('ytDlpAvailable'));
  } finally {
    consoleCapture.restore();
    process.chdir(originalCwd);
    restoreEnv(originalEnv);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
