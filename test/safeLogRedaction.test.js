const test = require('node:test');
const assert = require('node:assert/strict');

const { safeLog } = require('../server/utils/safeLog');

test('safeLog redacts sensitive values', () => {
  const originalEnv = {
    YOUTUBE_COOKIE: process.env.YOUTUBE_COOKIE,
    YOUTUBE_PROXY_URL: process.env.YOUTUBE_PROXY_URL
  };

  process.env.YOUTUBE_COOKIE = 'SID=super-secret-cookie';
  process.env.YOUTUBE_PROXY_URL = 'http://user:pass@proxy.example.com:8080';

  const captured = [];
  const origError = console.error;
  try {
    console.error = (...args) => captured.push(args);

    safeLog('error', 'test', {
      Authorization: 'Bearer super-secret-token',
      Cookie: 'SID=super-secret-cookie; HSID=another-secret',
      'Set-Cookie': 'SID=super-secret-cookie; Path=/; HttpOnly',
      YOUTUBE_PROXY_URL: 'http://user:pass@proxy.example.com:8080'
    });
  } finally {
    console.error = origError;
    process.env.YOUTUBE_COOKIE = originalEnv.YOUTUBE_COOKIE;
    process.env.YOUTUBE_PROXY_URL = originalEnv.YOUTUBE_PROXY_URL;
  }

  assert.ok(captured.length >= 1);
  const lastCall = captured[captured.length - 1];

  const meta = lastCall[1];
  assert.deepEqual(meta, {
    Authorization: '[REDACTED]',
    Cookie: '[REDACTED]',
    'Set-Cookie': '[REDACTED]',
    YOUTUBE_PROXY_URL: '[REDACTED]'
  });

  const output = JSON.stringify(lastCall);
  assert.ok(!output.includes('super-secret-cookie'));
  assert.ok(!output.includes('super-secret-token'));
  assert.ok(!output.includes('http://user:pass@proxy.example.com:8080'));
});
