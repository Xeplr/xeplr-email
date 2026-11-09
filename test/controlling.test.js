// Controlling — the body pattern /internal/send accepts. No provider, no mail:
// the handler tests stub send().
// Run:  node --test test/controlling.test.js

var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');
var c = require('../lib/controlling');

function refused(fn, field) {
  assert.throws(fn, function(err) {
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.field, field);
    return true;
  });
}

var BODY = { to: ['admin@xeplr.com'], subject: 'Hi', html: '<p>x</p>' };

test('no rules: everything passes', function() {
  c.check({ to: ['anyone@anywhere.com'], subject: 's', html: 'h', extra: 1 }, null);
});

test('an exact address allows only that address, case-insensitively', function() {
  var rules = c.compileRules({ to: ['admin@xeplr.com'] });
  c.check(BODY, rules);
  c.check({ to: ['Admin@Xeplr.com'], subject: 'Hi', html: 'h' }, rules);
  refused(function() { c.check({ to: ['someone@xeplr.com'], subject: 'Hi', html: 'h' }, rules); }, 'to');
});

test('EVERY recipient must match — one stray address refuses the whole send', function() {
  // Trimming it and sending to the rest would deliver a mail nobody asked for.
  var rules = c.compileRules({ to: 'admin@xeplr.com' });
  refused(function() { c.check({ to: ['admin@xeplr.com', 'x@evil.com'], subject: 's', html: 'h' }, rules); }, 'to');
});

test('a * wildcard matches a domain, and not a look-alike', function() {
  var rules = c.compileRules({ to: '*@xeplr.com' });
  c.check({ to: ['ops@xeplr.com', 'admin@xeplr.com'], subject: 's', html: 'h' }, rules);
  refused(function() { c.check({ to: ['a@xeplr.com.evil.com'], subject: 's', html: 'h' }, rules); }, 'to');
  refused(function() { c.check({ to: ['a@notxeplr.com'], subject: 's', html: 'h' }, rules); }, 'to');
});

test('a "/regex/" string and a RegExp both work, and g does not make it stateful', function() {
  var rules = c.compileRules({ subject: '/^Report \\d+$/g' });
  c.check({ to: ['a@b.c'], subject: 'Report 1', html: 'h' }, rules);
  c.check({ to: ['a@b.c'], subject: 'Report 1', html: 'h' }, rules);   // same value twice
  refused(function() { c.check({ to: ['a@b.c'], subject: 'Hello', html: 'h' }, rules); }, 'subject');

  var fromCode = c.compileRules({ subject: /^Alert:/ });
  c.check({ to: ['a@b.c'], subject: 'Alert: disk', html: 'h' }, fromCode);
});

test('a function rule allows only on a strict true', function() {
  var rules = c.compileRules({ subject: function(v) { return v.length < 10; } });
  c.check({ to: ['a@b.c'], subject: 'short', html: 'h' }, rules);
  refused(function() { c.check({ to: ['a@b.c'], subject: 'much too long a subject', html: 'h' }, rules); }, 'subject');
});

test('false (or []) means the field must be absent or empty', function() {
  var rules = c.compileRules({ cc: false, attachments: [] });
  c.check(BODY, rules);
  c.check(Object.assign({ cc: [] }, BODY), rules);
  refused(function() { c.check(Object.assign({ cc: ['x@y.z'] }, BODY), rules); }, 'cc');
  refused(function() { c.check(Object.assign({ attachments: ['/etc/passwd'] }, BODY), rules); }, 'attachments');
});

test('a field no rule names is not checked; an unknown body field is refused', function() {
  var rules = c.compileRules({ to: 'admin@xeplr.com' });
  c.check(Object.assign({ cc: ['anyone@x.com'] }, BODY), rules);
  refused(function() { c.check(Object.assign({ bcc: ['hidden@x.com'] }, BODY), rules); }, 'bcc');
});

test('the html body is never echoed back in the refusal', function() {
  var rules = c.compileRules({ html: '/^<p>ok<\\/p>$/' });
  assert.throws(function() { c.check({ to: ['a@b.c'], subject: 's', html: '<p>secret</p>' }, rules); },
    function(err) { return !/secret/.test(err.message); });
});

test('a misconfiguration fails at compile time, not at the first send', function() {
  assert.throws(function() { c.compileRules({ too: ['a@b.c'] }); }, /not a send field/);
  assert.throws(function() { c.compileRules({ to: 42 }); }, /must be a string/);
  assert.throws(function() { c.compileRules(['to']); }, /object of field rules/);
});

test('EMAIL_ALLOW: unset is off, JSON compiles, invalid JSON fails loudly', function() {
  var saved = process.env.EMAIL_ALLOW;
  try {
    delete process.env.EMAIL_ALLOW;
    assert.strictEqual(c.fromEnv(), null);
    process.env.EMAIL_ALLOW = '{"to":["admin@xeplr.com"]}';
    refused(function() { c.check({ to: ['x@y.z'], subject: 's', html: 'h' }, c.fromEnv()); }, 'to');
    process.env.EMAIL_ALLOW = '{to:';
    assert.throws(function() { c.fromEnv(); }, /not valid JSON/);
  } finally {
    if (saved === undefined) delete process.env.EMAIL_ALLOW; else process.env.EMAIL_ALLOW = saved;
  }
});

// ── through the HTTP handler ─────────────────────────────────────────────

test('POST /internal/send: allowed is sent, refused is a 403 naming the field', async function() {
  var email = require('../index');
  var handler = require('../lib/emailHandler');
  var sent = [];
  var realSend = email.send;
  email.send = function(to, subject) { sent.push({ to: to, subject: subject }); return Promise.resolve(); };
  email.init({ allow: { to: ['admin@xeplr.com'] } });

  var server = http.createServer(handler);
  await new Promise(function(r) { server.listen(0, r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  function post(body) {
    return fetch(base + '/internal/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(res) { return res.json().then(function(json) { return { status: res.status, json: json }; }); });
  }

  try {
    var ok = await post(BODY);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(sent, [{ to: ['admin@xeplr.com'], subject: 'Hi' }]);

    var no = await post({ to: ['someone@else.com'], subject: 'Hi', html: 'h' });
    assert.strictEqual(no.status, 403);
    assert.strictEqual(no.json.field, 'to');
    assert.strictEqual(sent.length, 1, 'a refused send must not reach the provider');

    var bad = await fetch(base + '/internal/send', { method: 'POST', body: '{not json' });
    assert.strictEqual(bad.status, 400);
  } finally {
    server.close();
    email.send = realSend;
    email.init({});   // rules back off for any test after this one
  }
});

test('start() boots the plain HTTP server, with the rules applied', async function() {
  // start() used to throw at once: it read base-apis' `http`, which 2.x
  // renamed createHttpServer. Booting it here keeps that from coming back.
  var email = require('../index');
  var realSend = email.send;
  email.send = function() { return Promise.resolve(); };
  var server = email.start({ port: 0, allow: { to: '*@xeplr.com' } });
  try {
    if (!server.listening) await new Promise(function(r) { server.once('listening', r); });
    var base = 'http://127.0.0.1:' + server.address().port;

    var health = await fetch(base + '/');
    assert.strictEqual(health.status, 200);

    var res = await fetch(base + '/internal/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: ['x@other.com'], subject: 's', html: 'h' })
    });
    assert.strictEqual(res.status, 403);
  } finally {
    await new Promise(function(r) { server.close(r); });
    email.send = realSend;
    email.init({});
  }
});
