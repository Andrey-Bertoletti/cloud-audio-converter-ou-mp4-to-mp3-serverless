const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../server/app');

test('POST /api/youtube/convert returns 429 on bot challenge', async () => {
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

  const supabaseStub = {
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

  const runYtDlpToMp3Stub = async () => {
    const err = new Error("Sign in to confirm you're not a bot");
    err.stderr = "ERROR: [youtube] abc123: Sign in to confirm you're not a bot";
    throw err;
  };

  const app = createApp({
    ytdl: ytdlStub,
    supabaseAdmin: supabaseStub,
    disableAuth: true,
    runYtDlpToMp3: runYtDlpToMp3Stub
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/youtube/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'https://youtu.be/KlKKYMQOXr4' })
    });

    assert.equal(response.status, 429);
    const json = await response.json();

    assert.deepEqual(json, {
      error: 'YOUTUBE_BOT_CHALLENGE',
      message: 'YouTube solicitou verificação anti-bot para este servidor/proxy.',
      retryAfterSeconds: 300
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

