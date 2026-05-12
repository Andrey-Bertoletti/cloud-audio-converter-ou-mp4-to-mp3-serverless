const test = require('node:test');
const assert = require('node:assert/strict');

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

async function startServer(app) {
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

test('POST /api/youtube/convert: fallback yt-dlp falha (não-bot) e não derruba o servidor', async () => {
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

  let fallbackCalls = 0;
  const runYtDlpToMp3Stub = async () => {
    fallbackCalls += 1;
    const err = new Error('yt-dlp failed');
    err.code = 'YTDLP_FAILED';
    err.stderr = 'ERROR: some generic failure';
    throw err;
  };

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

    assert.equal(response.status, 500);
    const json = await response.json();
    assert.deepEqual(json, {
      error: 'YTDLP_FALLBACK_FAILED',
      message: 'O fallback yt-dlp falhou durante a conversão.'
    });

    assert.equal(fallbackCalls, 1);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');
  } finally {
    await stopServer(server);
  }
});

test('POST /api/youtube/convert: retorna YTDLP_MISSING_URL quando o fallback detecta URL ausente', async () => {
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

  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: async () => {
      const err = new Error('Falha interna: URL não foi enviada corretamente ao yt-dlp.');
      err.code = 'YTDLP_MISSING_URL';
      throw err;
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
      error: 'YTDLP_MISSING_URL',
      message: 'Falha interna: URL não foi enviada corretamente ao yt-dlp.'
    });
  } finally {
    await stopServer(server);
  }
});

test('POST /api/youtube/convert: retorna 429 YOUTUBE_SESSION_REJECTED quando cookies são rejeitados', async () => {
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

  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: async () => {
      const err = new Error('YouTube recusou os cookies de sessão neste servidor/proxy.');
      err.code = 'YOUTUBE_SESSION_REJECTED';
      err.retryAfterSeconds = 300;
      err.stderr = "ERROR: [youtube] 123abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication...";
      throw err;
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

    assert.equal(response.status, 429);
    const json = await response.json();
    assert.equal(json.error, 'YOUTUBE_SESSION_REJECTED');
    assert.ok(json.message.includes('YouTube recusou'));
    assert.equal(json.retryAfterSeconds, 300);
  } finally {
    await stopServer(server);
  }
});

