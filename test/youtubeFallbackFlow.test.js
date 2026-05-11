const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createApp } = require('../server/app');

function createSupabaseStub() {
  return {
    from: () => ({
      insert: async () => ({ error: null }),
      select: () => ({
        eq: () => ({
          order: () => ({
            range: async () => ({ data: [], error: null, count: 0 })
          })
        })
      }),
      delete: () => ({
        in: async () => ({ error: null })
      })
    }),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'http://example.com/file.mp3' } }),
        remove: async () => ({ error: null })
      })
    }
  };
}

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

async function startServer(app) {
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

test('POST /api/youtube/convert usa yt-dlp quando ytdl-core falha no metadata (bot)', async () => {
  const supabaseStub = createSupabaseStub();
  const ytdlStub = {
    validateURL: () => true,
    createProxyAgent: () => ({}),
    createAgent: () => ({}),
    getInfo: async () => {
      throw new Error("Sign in to confirm you're not a bot");
    },
    downloadFromInfo: () => {
      throw new Error('downloadFromInfo should not be called');
    }
  };

  let ytDlpCalls = 0;
  const runYtDlpToMp3Stub = async ({ outputMp3Path }) => {
    ytDlpCalls += 1;
    await fs.promises.writeFile(outputMp3Path, Buffer.from('FAKE_MP3'));
  };

  const consoleCapture = captureConsole();
  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: runYtDlpToMp3Stub
  });

  const server = await startServer(app);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/youtube/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'https://youtu.be/KlKKYMQOXr4' })
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.downloadUrl, 'http://example.com/file.mp3');
    assert.match(json.fileName, /\.mp3$/);
    assert.equal(ytDlpCalls, 1);
  } finally {
    consoleCapture.restore();
    await stopServer(server);
  }
});

test('POST /api/youtube/convert usa yt-dlp quando ytdl-core falha no stream (bot)', async () => {
  const supabaseStub = createSupabaseStub();
  const ytdlStub = {
    validateURL: () => true,
    createProxyAgent: () => ({}),
    createAgent: () => ({}),
    getInfo: async () => ({ videoDetails: { title: 'Example title' } }),
    downloadFromInfo: () => {
      throw new Error("Sign in to confirm you're not a bot");
    }
  };

  let ytDlpCalls = 0;
  const runYtDlpToMp3Stub = async ({ outputMp3Path }) => {
    ytDlpCalls += 1;
    await fs.promises.writeFile(outputMp3Path, Buffer.from('FAKE_MP3'));
  };

  const consoleCapture = captureConsole();
  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: runYtDlpToMp3Stub
  });

  const server = await startServer(app);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/youtube/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'https://youtu.be/KlKKYMQOXr4' })
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.downloadUrl, 'http://example.com/file.mp3');
    assert.match(json.fileName, /\.mp3$/);
    assert.equal(ytDlpCalls, 1);
  } finally {
    consoleCapture.restore();
    await stopServer(server);
  }
});

test('NODE_ENV=production: não vaza stack/cookies/proxy em logs nem no response', async () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    YOUTUBE_COOKIE: process.env.YOUTUBE_COOKIE,
    YOUTUBE_PROXY_URL: process.env.YOUTUBE_PROXY_URL
  };

  process.env.NODE_ENV = 'production';
  process.env.YOUTUBE_COOKIE = 'SID=super-secret-cookie';
  process.env.YOUTUBE_PROXY_URL = 'http://user:pass@proxy.example.com:8080';

  const supabaseStub = createSupabaseStub();
  const ytdlStub = {
    validateURL: () => true,
    createProxyAgent: () => ({}),
    createAgent: () => ({}),
    getInfo: async () => {
      const err = new Error(
        'Falha com cookie SID=super-secret-cookie e proxy http://user:pass@proxy.example.com:8080'
      );
      err.stack = `UnrecoverableError: boom\n    at exports.playError (/opt/render/project/src/node_modules/@distube/ytdl-core/lib/utils.js:168:12)`;
      throw err;
    },
    downloadFromInfo: () => {
      throw new Error('downloadFromInfo should not be called');
    }
  };

  const consoleCapture = captureConsole();
  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: async () => {
      throw new Error('should not run fallback');
    }
  });

  const server = await startServer(app);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/youtube/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'https://youtu.be/KlKKYMQOXr4' })
    });

    assert.equal(response.status, 500);
    const json = await response.json();
    assert.deepEqual(json, {
      error: 'INTERNAL_ERROR',
      message: 'Erro no servidor durante a conversão.'
    });

    const output = JSON.stringify(consoleCapture.calls);
    assert.ok(!output.includes('super-secret-cookie'));
    assert.ok(!output.includes('http://user:pass@proxy.example.com:8080'));
    assert.ok(!output.includes('exports.playError'));
    assert.ok(!output.includes('node_modules/@distube/ytdl-core'));
  } finally {
    consoleCapture.restore();
    await stopServer(server);
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.YOUTUBE_COOKIE = originalEnv.YOUTUBE_COOKIE;
    process.env.YOUTUBE_PROXY_URL = originalEnv.YOUTUBE_PROXY_URL;
  }
});

