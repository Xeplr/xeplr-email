// FORM TOKENS — what a send on a public form has to carry.
//
// A public form has no user to sign in, so a token cannot prove WHO is
// sending: anything a visitor's browser can fetch, a script can fetch too.
// What it can do is make every send cost a round trip and a wait, and stop
// one send being repeated:
//
//   · Issued by GET /public/v1/token/:key, for ONE form and ONE visitor address.
//   · Signed with the service's secret, so it cannot be made up or edited.
//   · Single use: a token that has been used is refused, so nothing replays.
//   · Not before MIN seconds: a send that arrives faster than a person could
//     fill the form in is refused. Scripts are fast; people are not.
//   · Expires after TTL.
//   · How many an address may be issued is limited (handler.js), so tokens
//     cannot be stockpiled.
//
// Used tokens are remembered in memory, per process, until they expire: the
// same trade as throttle.js, with no Redis.
//
// A restart forgets which tokens were used. Without a configured secret
// (EMAIL_PUBLIC_TOKEN_SECRET) that does not matter: each start makes a new
// secret, every older token stops being valid, and the embed script fetches a
// fresh one. With a configured secret, a token used just before a restart
// could be used once more after it, within its expiry. Configure one only when
// tokens must survive a restart, such as during a deploy.

var crypto = require('crypto');

var DEFAULTS = {
  ttlSeconds: 60 * 60,     // a visitor can take their time over a long message
  minSeconds: 3,           // nobody types a form in under three seconds
  perIpPerHour: 30         // tokens issued to one address, in any hour
};

var MESSAGES = {
  missing: 'This form needs reloading before it can be sent — please refresh the page',
  invalid: 'This form needs reloading before it can be sent — please refresh the page',
  form: 'This form needs reloading before it can be sent — please refresh the page',
  address: 'Your connection changed while you were filling in the form — please try again',
  expired: 'This form has been open too long — please try again',
  early: 'That was quick — please wait a moment and send again',
  used: 'This form was already sent — please try again'
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** The visitor's address as the token carries it: a short hash, never the address itself. */
function addressHash(secret, ip) {
  return b64url(crypto.createHmac('sha256', secret).update('ip:' + String(ip)).digest()).slice(0, 16);
}

/**
 * @param {object} [options]
 * @param {string} [options.secret] - signs the tokens; without one, a random secret per process
 * @param {number} [options.ttlSeconds=3600]
 * @param {number} [options.minSeconds=3]
 * @param {number} [options.perIpPerHour=30] - read by the handler, kept here so all the settings live together
 * @param {function} [options.now] - () → ms; tests move the clock
 */
function createFormTokens(options) {
  options = options || {};
  var settings = {
    ttlSeconds: options.ttlSeconds == null ? DEFAULTS.ttlSeconds : Number(options.ttlSeconds),
    minSeconds: options.minSeconds == null ? DEFAULTS.minSeconds : Number(options.minSeconds),
    perIpPerHour: options.perIpPerHour == null ? DEFAULTS.perIpPerHour : Number(options.perIpPerHour)
  };
  if (!(settings.ttlSeconds > 0)) throw new Error('email public: tokens.ttlSeconds must be a positive number');
  if (!(settings.minSeconds >= 0)) throw new Error('email public: tokens.minSeconds must be 0 or more');
  if (settings.minSeconds >= settings.ttlSeconds) throw new Error('email public: tokens.minSeconds must be less than tokens.ttlSeconds');
  if (!(settings.perIpPerHour > 0)) throw new Error('email public: tokens.perIpPerHour must be a positive number');

  var secret = options.secret ? Buffer.from(String(options.secret)) : crypto.randomBytes(32);
  var now = options.now || Date.now;
  var ttlMs = settings.ttlSeconds * 1000;
  var minMs = settings.minSeconds * 1000;
  var used = new Map();   // nonce → when it would have expired anyway

  function sign(body) {
    return b64url(crypto.createHmac('sha256', secret).update(body).digest());
  }

  /** A token for this form and this visitor. { token, expiresIn, minWait } in seconds. */
  function issue(formKey, ip) {
    var payload = { f: formKey, a: addressHash(secret, ip), t: now(), n: b64url(crypto.randomBytes(12)) };
    var body = b64url(JSON.stringify(payload));
    return { token: body + '.' + sign(body), expiresIn: settings.ttlSeconds, minWait: settings.minSeconds };
  }

  /**
   * Check a token and, when it passes, use it up. { ok: true } or
   * { ok: false, reason, message }. The reason is for the log; the message is
   * what the visitor reads.
   */
  function redeem(token, formKey, ip) {
    var refuse = function(reason) { return { ok: false, reason: reason, message: MESSAGES[reason] }; };
    if (!token || typeof token !== 'string') return refuse('missing');
    var parts = token.split('.');
    if (parts.length !== 2 || token.length > 512) return refuse('invalid');

    var expected = Buffer.from(sign(parts[0]));
    var given = Buffer.from(parts[1]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return refuse('invalid');

    var payload;
    try { payload = JSON.parse(fromB64url(parts[0]).toString('utf8')); } catch (e) { return refuse('invalid'); }
    if (!payload || typeof payload.t !== 'number' || typeof payload.n !== 'string') return refuse('invalid');

    if (payload.f !== formKey) return refuse('form');
    if (payload.a !== addressHash(secret, ip)) return refuse('address');
    var age = now() - payload.t;
    if (age > ttlMs) return refuse('expired');
    if (age < minMs) return refuse('early');
    if (used.has(payload.n)) return refuse('used');

    used.set(payload.n, payload.t + ttlMs);
    return { ok: true };
  }

  // A used token only needs remembering until it would have expired anyway.
  function sweep() {
    var t = now();
    used.forEach(function(expiresAt, nonce) { if (expiresAt <= t) used.delete(nonce); });
  }
  var timer = setInterval(sweep, 10 * 60 * 1000);
  if (timer.unref) timer.unref();

  return { issue: issue, redeem: redeem, sweep: sweep, settings: settings, usedCount: function() { return used.size; } };
}

module.exports = { createFormTokens: createFormTokens, DEFAULTS: DEFAULTS, TOKEN_FIELD: '_token' };
