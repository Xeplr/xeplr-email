// The PUBLIC email service — forms from config, never a recipient or HTML from
// a request. Everything here runs without a provider: send() is a stub.
// Run:  node --test test/public.test.js

var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');
var fs = require('node:fs');
var path = require('node:path');
var forms = require('../lib/public/forms');
var { createThrottle, HOUR } = require('../lib/public/throttle');
var { createPublicHandler, clientIp } = require('../lib/public/handler');
var { createFormTokens } = require('../lib/public/formToken');

var CONFIG = {
  forms: {
    demo: {
      to: 'demo@xeplr.com',
      subject: 'Demo request from {{name}}',
      origins: ['https://xeplr.com'],
      redirect: 'https://xeplr.com/thanks',
      fields: [
        { key: 'name', label: 'Your name', type: 'text', required: true },
        { key: 'email', label: 'Work email', type: 'email', required: true },
        { key: 'sources', label: 'Data lives in', type: 'select', options: ['Postgres', 'SQL Server'] },
        { key: 'message', label: 'Message', type: 'multiline' }
      ],
      limits: { perIpPerHour: 2, perDay: 3 }
    }
  }
};
var GOOD = { name: 'Ada', email: 'ada@example.com', sources: 'Postgres', message: 'Hi\nthere' };

// ── config ───────────────────────────────────────────────────────────────

test('a broken form config stops the boot, naming the problem', function() {
  var bad = function(form) { return function() { forms.loadForms({ forms: { f: Object.assign({ to: 'a@b.co', fields: [{ key: 'x' }] }, form) } }); }; };
  assert.throws(function() { forms.loadForms({}); }, /defines no forms/);
  assert.throws(bad({ to: null }), /has no "to"/);
  assert.throws(bad({ to: 'not-an-address' }), /not an email address/);
  assert.throws(bad({ fields: [] }), /has no fields/);
  assert.throws(bad({ fields: [{ key: 'my-field' }] }), /must start with a letter/);
  assert.throws(bad({ fields: [{ key: 'a' }, { key: 'a' }] }), /two fields called "a"/);
  assert.throws(bad({ fields: [{ key: 'a', type: 'file' }] }), /type "file"/);
  assert.throws(bad({ fields: [{ key: 'a', type: 'select' }] }), /no options/);
  assert.throws(bad({ origins: ['xeplr.com'] }), /https:\/\/host/);
  assert.throws(bad({ redirect: 'javascript:alert(1)' }), /https:\/\/ URL/);
  assert.throws(bad({ captcha: { turnstile: { siteKey: 'k', secretEnv: 'NOPE_NOT_SET' } } }), /secretEnv/);
});

test('what a browser sees of a form has no recipient, limits or secret', function() {
  var f = forms.loadForms(CONFIG).demo;
  var shown = forms.publicDefinition(f);
  var text = JSON.stringify(shown);
  assert.ok(!/demo@xeplr\.com/.test(text));
  assert.strictEqual(shown.limits, undefined);
  assert.strictEqual(shown.fields.length, 4);
});

// ── submissions ──────────────────────────────────────────────────────────

test('a submission is checked against the form — unknown keys are named, not dropped', function() {
  var f = forms.loadForms(CONFIG).demo;
  assert.deepStrictEqual(forms.checkSubmission(f, GOOD).errors, {});
  var e = forms.checkSubmission(f, Object.assign({}, GOOD, { to: 'evil@x.com', html: '<b>x</b>' })).errors;
  assert.match(e.to, /not a field of this form/);
  assert.match(e.html, /not a field of this form/);
  assert.strictEqual(forms.checkSubmission(f, { email: 'ada@example.com' }).errors.name, 'This is required');
  assert.strictEqual(forms.checkSubmission(f, Object.assign({}, GOOD, { email: 'nope' })).errors.email, 'That is not an email address');
  assert.strictEqual(forms.checkSubmission(f, Object.assign({}, GOOD, { sources: 'Oracle' })).errors.sources, 'Choose one of the options');
  assert.strictEqual(forms.checkSubmission(f, Object.assign({}, GOOD, { name: { $ne: 1 } })).errors.name, 'Must be text');
  assert.strictEqual(forms.checkSubmission(f, Object.assign({}, GOOD, { name: 'x'.repeat(201) })).errors.name, 'At most 200 characters');
  assert.deepStrictEqual(forms.checkSubmission(f, Object.assign({ _hp: '', 'cf-turnstile-response': 't' }, GOOD)).errors, {});
});

test('the mail is built on the server: values escaped, subject one line', function() {
  var f = forms.loadForms(CONFIG).demo;
  var mail = forms.composeMail(f, { name: '<script>x</script>\r\nBcc: evil@x.com', email: 'a@b.co', message: 'l1\nl<2>' }, { origin: 'https://xeplr.com' });
  assert.deepStrictEqual(mail.to, ['demo@xeplr.com']);
  assert.ok(!/[\r\n]/.test(mail.subject), 'no line break can reach the subject header');
  assert.match(mail.subject, /^Demo request from <script>x<\/script> Bcc: evil@x.com$/);
  assert.ok(mail.html.includes('&lt;script&gt;') && !mail.html.includes('<script>'));
  assert.ok(mail.html.includes('l1<br>l&lt;2&gt;'));
  assert.ok(mail.html.includes('https://xeplr.com'));
});

// ── throttle and addresses ───────────────────────────────────────────────

test('throttling is a sliding window, and says when to come back', function() {
  var t = createThrottle();
  var now = 1000000;
  t.record('k', now); t.record('k', now + 1000);
  assert.strictEqual(t.check('k', 2, HOUR, now + 2000).ok, false);
  assert.strictEqual(t.check('k', 2, HOUR, now + 2000).retryAfterSeconds, 3598);
  assert.strictEqual(t.check('k', 2, HOUR, now + HOUR + 1).ok, true, 'the oldest hit has left the window');
});

test('the visitor address: headers only behind a trusted proxy, and the LAST forwarded entry', function() {
  var req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.strictEqual(clientIp(req, false), '127.0.0.1', 'without trustProxy anyone could pick their own address');
  assert.strictEqual(clientIp(req, true), '1.2.3.4', 'the first entry is whatever the client claimed');
  assert.strictEqual(clientIp({ headers: { 'x-real-ip': '9.9.9.9' }, socket: {} }, true), '9.9.9.9');
});

// ── through HTTP ─────────────────────────────────────────────────────────

async function serve(options) {
  var sent = [];
  var logs = [];
  var handler = createPublicHandler(Object.assign({
    forms: forms.loadForms(CONFIG),
    send: function(to, subject, html) { sent.push({ to: to, subject: subject, html: html }); return Promise.resolve(); },
    log: function(line) { logs.push(line); },
    // No minimum wait unless a test asks for one: these tests are about
    // everything else, and send the moment they have a token.
    tokens: { minSeconds: 0 }
  }, options || {}));
  var server = http.createServer(handler);
  await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  async function token(key) {
    var res = await fetch(base + '/public/v1/token/' + (key || 'demo'), { headers: { origin: 'https://xeplr.com' } });
    return (await res.json()).token;
  }
  return {
    sent: sent, logs: logs, base: base, token: token,
    // A JSON body gets a fresh token unless it brings its own (_token, even
    // null): the way embed.js sends.
    post: async function(body, headers, raw) {
      if (raw == null && body && !Object.prototype.hasOwnProperty.call(body, '_token')) {
        body = Object.assign({ _token: await token() }, body);
      }
      return fetch(base + '/public/v1/send/demo', {
        method: 'POST', redirect: 'manual',
        headers: Object.assign({ 'content-type': 'application/json', origin: 'https://xeplr.com' }, headers || {}),
        body: raw != null ? raw : JSON.stringify(body)
      });
    },
    close: function() { return new Promise(function(r) { server.close(r); }); }
  };
}

test('GET the form: its fields, never its recipient; CORS for its own origin only', async function() {
  var s = await serve();
  try {
    var res = await fetch(s.base + '/public/v1/forms/demo', { headers: { origin: 'https://xeplr.com' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://xeplr.com');
    assert.ok(!/demo@xeplr\.com/.test(await res.text()));
    assert.strictEqual((await fetch(s.base + '/public/v1/forms/demo', { headers: { origin: 'https://evil.com' } })).status, 403);
    assert.strictEqual((await fetch(s.base + '/public/v1/forms/nope')).status, 404);
    var pre = await fetch(s.base + '/public/v1/send/demo', { method: 'OPTIONS', headers: { origin: 'https://xeplr.com' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers.get('access-control-allow-headers'), 'content-type');
  } finally { await s.close(); }
});

test('POST: a good submission is sent to the CONFIGURED recipient', async function() {
  var s = await serve();
  try {
    var res = await s.post(GOOD);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).success, true);
    assert.strictEqual(s.sent.length, 1);
    assert.deepStrictEqual(s.sent[0].to, ['demo@xeplr.com']);
    assert.strictEqual(s.sent[0].subject, 'Demo request from Ada');
  } finally { await s.close(); }
});

test('POST: to / html in the body are refused, naming them — and nothing is sent', async function() {
  var s = await serve();
  try {
    var res = await s.post(Object.assign({ to: 'evil@x.com', html: '<a href=x>phish</a>' }, GOOD));
    var data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.ok(data.fields.to && data.fields.html);
    assert.strictEqual(s.sent.length, 0);
  } finally { await s.close(); }
});

test('POST: over 10 KB is refused (413) before it is read', async function() {
  var s = await serve();
  try {
    var res = await s.post(Object.assign({}, GOOD, { message: 'x'.repeat(11 * 1024) }));
    assert.strictEqual(res.status, 413);
    assert.strictEqual(s.sent.length, 0);
  } finally { await s.close(); }
});

test('POST: a sender that streams past 10 KB without saying so is cut off too', async function() {
  var s = await serve();
  try {
    var status = await new Promise(function(resolve, reject) {
      var u = new URL(s.base + '/public/v1/send/demo');
      var req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, function(res) { resolve(res.statusCode); res.resume(); });
      req.on('error', function() { resolve('closed'); });
      var chunk = Buffer.alloc(4096, 'x');
      for (var i = 0; i < 4; i++) req.write(chunk);   // 16 KB, no Content-Length
      req.end();
    });
    assert.ok(status === 413 || status === 'closed', 'got ' + status);
    assert.strictEqual(s.sent.length, 0);
  } finally { await s.close(); }
});

test('POST: another site\'s origin is refused', async function() {
  var s = await serve();
  try {
    assert.strictEqual((await s.post(GOOD, { origin: 'https://evil.com' })).status, 403);
    assert.strictEqual(s.sent.length, 0);
  } finally { await s.close(); }
});

test('POST: a filled honeypot looks like success to the bot, and sends nothing', async function() {
  var s = await serve();
  try {
    var res = await s.post(Object.assign({ _hp: 'http://spam' }, GOOD));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(s.sent.length, 0);
    assert.ok(s.logs.some(function(l) { return /honeypot/.test(l); }));
  } finally { await s.close(); }
});

test('POST: per-IP and per-day limits answer 429 with Retry-After', async function() {
  var s = await serve();
  try {
    assert.strictEqual((await s.post(GOOD)).status, 200);
    assert.strictEqual((await s.post(GOOD)).status, 200);
    var third = await s.post(GOOD);
    assert.strictEqual(third.status, 429, 'perIpPerHour is 2');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.strictEqual(s.sent.length, 2);
  } finally { await s.close(); }
});

test('POST: a provider failure is a 502 without its details, and does not use up a send', async function() {
  var s = await serve({ send: function() { return Promise.reject(new Error('535 auth failed for user smtp-secret@x')); } });
  try {
    var res = await s.post(GOOD);
    var data = await res.json();
    assert.strictEqual(res.status, 502);
    assert.ok(!/smtp-secret/.test(data.error), 'the provider\'s words stay in the log');
    assert.ok(s.logs.some(function(l) { return /smtp-secret/.test(l); }));
  } finally { await s.close(); }
});

test('POST without JavaScript: a plain form post redirects to the configured page', async function() {
  // A page with no script cannot fetch a token, so its form opts out.
  var noScript = JSON.parse(JSON.stringify(CONFIG));
  noScript.forms.demo.token = false;
  var s = await serve({ forms: forms.loadForms(noScript) });
  try {
    var ok = await s.post(null, { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(GOOD).toString());
    assert.strictEqual(ok.status, 303);
    assert.strictEqual(ok.headers.get('location'), 'https://xeplr.com/thanks');
    var bad = await s.post(null, { 'content-type': 'application/x-www-form-urlencoded' }, 'name=&email=x');
    assert.strictEqual(bad.status, 400);
    var page = await bad.text();
    assert.match(page, /Your name: This is required/);
    var twice = await s.post(null, { 'content-type': 'application/x-www-form-urlencoded' }, 'name=a&name=b&email=a@b.co');
    assert.strictEqual(twice.status, 400);
  } finally { await s.close(); }
});

test('captcha: checked with Cloudflare before anything is sent', async function() {
  process.env.TEST_TURNSTILE_SECRET = 's3cret';
  var withCaptcha = JSON.parse(JSON.stringify(CONFIG));
  withCaptcha.forms.demo.captcha = { turnstile: { siteKey: 'site', secretEnv: 'TEST_TURNSTILE_SECRET' } };
  var asked = [];
  var s = await serve({
    forms: forms.loadForms(withCaptcha),
    fetch: function(url, opts) { asked.push(String(opts.body)); return Promise.resolve({ json: function() { return Promise.resolve({ success: /response=good/.test(opts.body) }); } }); }
  });
  try {
    var no = await s.post(Object.assign({ 'cf-turnstile-response': 'bad' }, GOOD));
    assert.strictEqual(no.status, 400);
    assert.strictEqual((await no.json()).captcha, true);
    assert.strictEqual((await s.post(Object.assign({ 'cf-turnstile-response': 'good' }, GOOD))).status, 200);
    assert.match(asked[0], /secret=s3cret/);
    assert.strictEqual(s.sent.length, 1);
  } finally { await s.close(); delete process.env.TEST_TURNSTILE_SECRET; }
});

// ── form tokens ──────────────────────────────────────────────────────────

test('tokens: a good one passes once; tampered, other form, other address, too soon, too late do not', function() {
  var now = 1000000;
  var t = createFormTokens({ secret: 'k', minSeconds: 3, ttlSeconds: 60, now: function() { return now; } });
  var a = t.issue('demo', '1.2.3.4').token;
  now += 1000;
  assert.strictEqual(t.redeem(a, 'demo', '1.2.3.4').reason, 'early', 'one second is faster than a person');
  now += 3000;
  assert.strictEqual(t.redeem(a, 'other', '1.2.3.4').reason, 'form');
  assert.strictEqual(t.redeem(a, 'demo', '6.6.6.6').reason, 'address');
  var parts = a.split('.');
  var forged = Buffer.from(JSON.stringify({ f: 'demo', a: 'x', t: 0, n: 'n' })).toString('base64url') + '.' + parts[1];
  assert.strictEqual(t.redeem(forged, 'demo', '1.2.3.4').reason, 'invalid');
  assert.strictEqual(t.redeem('', 'demo', '1.2.3.4').reason, 'missing');
  assert.strictEqual(t.redeem(a, 'demo', '1.2.3.4').ok, true);
  assert.strictEqual(t.redeem(a, 'demo', '1.2.3.4').reason, 'used', 'single use: a replay is refused');
  var b = t.issue('demo', '1.2.3.4').token;
  now += 61000;
  assert.strictEqual(t.redeem(b, 'demo', '1.2.3.4').reason, 'expired');
  t.sweep();
  assert.strictEqual(t.usedCount(), 0, 'a used token is forgotten once it would have expired anyway');
  var other = createFormTokens({ secret: 'different' });
  assert.strictEqual(other.redeem(t.issue('demo', '1.2.3.4').token, 'demo', '1.2.3.4').reason, 'invalid', 'another secret signed it');
  assert.throws(function() { createFormTokens({ minSeconds: 60, ttlSeconds: 60 }); }, /less than/);
});

test('POST: no token, or a used one, is refused (403) and nothing is sent', async function() {
  var s = await serve();
  try {
    var none = await s.post(Object.assign({ _token: null }, GOOD));
    assert.strictEqual(none.status, 403);
    assert.strictEqual((await none.json()).token, 'missing');
    var tok = await s.token();
    assert.strictEqual((await s.post(Object.assign({ _token: tok }, GOOD))).status, 200);
    var again = await s.post(Object.assign({ _token: tok }, GOOD));
    assert.strictEqual(again.status, 403);
    assert.strictEqual((await again.json()).token, 'used');
    assert.strictEqual(s.sent.length, 1);
  } finally { await s.close(); }
});

test('POST: a send faster than a person could type is refused', async function() {
  var now = 5000000;
  var s = await serve({ tokens: { minSeconds: 3, now: function() { return now; } } });
  try {
    var tok = await s.token();
    var quick = await s.post(Object.assign({ _token: tok }, GOOD));
    assert.strictEqual(quick.status, 403);
    assert.strictEqual((await quick.json()).token, 'early');
    var tok2 = await s.token();
    now += 4000;
    assert.strictEqual((await s.post(Object.assign({ _token: tok2 }, GOOD))).status, 200);
  } finally { await s.close(); }
});

test('GET token: its own origin only, limited per address, and none needed when a form opts out', async function() {
  var s = await serve({ tokens: { minSeconds: 0, perIpPerHour: 2 } });
  try {
    assert.strictEqual((await fetch(s.base + '/public/v1/token/demo', { headers: { origin: 'https://evil.com' } })).status, 403);
    var first = await fetch(s.base + '/public/v1/token/demo', { headers: { origin: 'https://xeplr.com' } });
    var body = await first.json();
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers.get('cache-control'), 'no-store');
    assert.ok(body.token && body.required === true && body.expiresIn > 0);
    await s.token();
    var third = await fetch(s.base + '/public/v1/token/demo', { headers: { origin: 'https://xeplr.com' } });
    assert.strictEqual(third.status, 429, 'two an hour here');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
  } finally { await s.close(); }
  var optOut = JSON.parse(JSON.stringify(CONFIG));
  optOut.forms.demo.token = false;
  var s2 = await serve({ forms: forms.loadForms(optOut) });
  try {
    assert.deepStrictEqual(await (await fetch(s2.base + '/public/v1/token/demo')).json(), { token: null, required: false });
    assert.strictEqual((await s2.post(Object.assign({ _token: null }, GOOD))).status, 200);
  } finally { await s2.close(); }
});

test('a plain HTML post to a form that needs a token gets a page saying so', async function() {
  var s = await serve();
  try {
    var res = await s.post(null, { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(GOOD).toString());
    assert.strictEqual(res.status, 403);
    assert.match(await res.text(), /refresh the page/);
    assert.strictEqual(s.sent.length, 0);
  } finally { await s.close(); }
});

test('the embed script is served, cacheable, by any site', async function() {
  var s = await serve();
  try {
    var res = await fetch(s.base + '/embed.min.js');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  } finally { await s.close(); }
});

test('embed.min.js is built from the current embed.js', function() {
  // A stale minified file would ship old behaviour from the CDN while the
  // source says otherwise. This fails the release until `npm run build:embed`.
  var esbuild = require('esbuild');
  var fresh = esbuild.transformSync(fs.readFileSync(path.join(__dirname, '..', 'embed', 'embed.js'), 'utf8'),
    { minify: true, target: 'es2017', legalComments: 'inline', loader: 'js' }).code;
  var shipped = fs.readFileSync(path.join(__dirname, '..', 'embed', 'embed.min.js'), 'utf8');
  assert.strictEqual(shipped.trim(), fresh.trim(), 'embed.min.js is stale — run npm run build:embed');
});

test('startPublic boots (dry run: no provider needed)', async function() {
  var email = require('../index');
  var server = email.startPublic(Object.assign({ port: 0, dryRun: true, log: function() {} }, CONFIG));
  try {
    if (!server.listening) await new Promise(function(r) { server.once('listening', r); });
    var res = await fetch('http://127.0.0.1:' + server.address().port + '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(server.address().address, '127.0.0.1', 'only this machine can reach it unless told otherwise');
  } finally { await new Promise(function(r) { server.close(r); }); }
});
