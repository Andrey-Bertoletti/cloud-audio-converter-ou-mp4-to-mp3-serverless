const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeYoutubeCookie } = require('../server/utils/normalizeYoutubeCookie');

test('normalizeYoutubeCookie: JSON array export', () => {
  const input = JSON.stringify([
    { name: 'SID', value: 'abc' },
    { name: 'HSID', value: 'def' }
  ]);
  assert.equal(normalizeYoutubeCookie(input), 'SID=abc; HSID=def');
});

test('normalizeYoutubeCookie: cookie header', () => {
  const input = 'SID=abc; HSID=def;  ; INVALID; X=';
  assert.equal(normalizeYoutubeCookie(input), 'SID=abc; HSID=def');
});

test('normalizeYoutubeCookie: base64 of JSON array', () => {
  const raw = JSON.stringify([{ name: 'SID', value: 'abc' }]);
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  assert.equal(normalizeYoutubeCookie(b64), 'SID=abc');
});

test('normalizeYoutubeCookie: base64 of cookie header', () => {
  const raw = 'SID=abc; HSID=def';
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  assert.equal(normalizeYoutubeCookie(b64), 'SID=abc; HSID=def');
});

test('normalizeYoutubeCookie: invalid string', () => {
  assert.equal(normalizeYoutubeCookie('not a cookie'), '');
});

test('normalizeYoutubeCookie: JSON without name/value', () => {
  const input = JSON.stringify([{ name: 'SID' }, { value: 'abc' }, { name: '', value: 'x' }]);
  assert.equal(normalizeYoutubeCookie(input), '');
});

