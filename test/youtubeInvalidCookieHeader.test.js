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

test('POST /api/youtube/convert: UND_ERR_INVALID_ARG (invalid cookie header) falha sem retry/fallback', async () => {
  const supabaseStub = createSupabaseStub();

  let getInfoCalls = 0;
  const ytdlStub = {
    validateURL: () => true,
    createProxyAgent: () => ({}),
    createAgent: () => ({}),
    getInfo: async () => {
      getInfoCalls += 1;
      const err = new Error('invalid cookie header');
      err.name = 'InvalidArgumentError';
      err.code = 'UND_ERR_INVALID_ARG';
      throw err;
    },
    downloadFromInfo: () => {
      throw new Error('downloadFromInfo should not be called');
    }
  };

  let ytDlpCalls = 0;
  const runYtDlpToMp3Stub = async () => {
    ytDlpCalls += 1;
    throw new Error('yt-dlp should not be called for invalid cookie header');
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
      error: 'YOUTUBE_COOKIE_INVALID',
      message: 'O cookie do YouTube est\u00e1 em formato inv\u00e1lido no servidor.'
    });

    assert.equal(getInfoCalls, 1);
    assert.equal(ytDlpCalls, 0);
  } finally {
    await stopServer(server);
  }
});

