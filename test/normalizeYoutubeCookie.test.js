const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeYoutubeCookie } = require('../server/utils/normalizeYoutubeCookie');

function assertNoForbiddenHeaderChars(cookieHeader) {
  assert.ok(!/[\[\]{}"\r\n]/.test(cookieHeader), `should not contain raw JSON chars/newlines: ${cookieHeader}`);
}

test('normalizeYoutubeCookie: JSON array export', () => {
  const input = JSON.stringify([
    { name: 'SID', value: 'abc' },
    { name: 'HSID', value: 'def' }
  ]);
  const out = normalizeYoutubeCookie(input);
  assert.equal(out, 'SID=abc; HSID=def');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: JSON array export ignores extra fields', () => {
  const input = JSON.stringify([
    { name: 'SID', value: 'abc', domain: '.youtube.com', path: '/', secure: true, sameSite: 'None', expirationDate: 123 },
    { name: 'HSID', value: 'def', httpOnly: true, hostOnly: true, id: 999 }
  ]);
  const out = normalizeYoutubeCookie(input);
  assert.equal(out, 'SID=abc; HSID=def');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: cookie header', () => {
  const input = 'SID=abc; HSID=def;  ; INVALID; X=';
  const out = normalizeYoutubeCookie(input);
  assert.equal(out, 'SID=abc; HSID=def');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: cookie header with newlines', () => {
  const input = 'SID=abc;\nHSID=def;\r\nSSID=ghi';
  const out = normalizeYoutubeCookie(input);
  assert.equal(out, 'SID=abc; HSID=def; SSID=ghi');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: base64 of JSON array', () => {
  const raw = JSON.stringify([{ name: 'SID', value: 'abc' }]);
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  const out = normalizeYoutubeCookie(b64);
  assert.equal(out, 'SID=abc');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: base64 of cookie header', () => {
  const raw = 'SID=abc; HSID=def';
  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  const out = normalizeYoutubeCookie(b64);
  assert.equal(out, 'SID=abc; HSID=def');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: invalid string', () => {
  assert.equal(normalizeYoutubeCookie('not a cookie'), '');
});

test('normalizeYoutubeCookie: raw JSON object is rejected (not cookie header)', () => {
  assert.equal(normalizeYoutubeCookie('{"name":"SID","value":"abc"}'), '');
});

test('normalizeYoutubeCookie: JSON without name/value', () => {
  const input = JSON.stringify([{ name: 'SID' }, { value: 'abc' }, { name: '', value: 'x' }]);
  assert.equal(normalizeYoutubeCookie(input), '');
});

test('normalizeYoutubeCookie: invalid cookie name is rejected', () => {
  const input = JSON.stringify([
    { name: 'SID', value: 'abc' },
    { name: 'bad name', value: 'x' },
    { name: '[]', value: 'y' }
  ]);
  const out = normalizeYoutubeCookie(input);
  assert.equal(out, 'SID=abc');
  assertNoForbiddenHeaderChars(out);
});

test('normalizeYoutubeCookie: dangerous cookie value is encoded/sanitized', () => {
  const input = JSON.stringify([
    { name: 'SID', value: 'a;b' },
    { name: 'HSID', value: 'x\ny' }
  ]);
  const out = normalizeYoutubeCookie(input);
  assert.match(out, /^SID=/);
  assert.ok(out.includes('SID=a%3Bb'), out);
  assertNoForbiddenHeaderChars(out);
  assert.ok(!out.includes('; HSID=x\ny'));
});
