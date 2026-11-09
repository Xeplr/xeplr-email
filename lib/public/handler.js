// THE PUBLIC EMAIL SERVICE — the one a website's forms reach.
//
// A separate process from the internal one (startPublic in index.js), because
// the internal service takes `to` and `html` from whoever calls it and must
// never be reachable from outside. This one takes a form's key and its field
// values only; everything else comes from the server's own form config
// (forms.js).
//
//   GET     /public/v1/forms/:key    what the form looks like (fields, labels) — no recipient
//   GET     /public/v1/token/:key    a single-use token a send must carry (formToken.js)
//   POST    /public/v1/send/:key     JSON (embed.js, fetch) or a plain HTML form post
//   OPTIONS /public/v1/…             CORS preflight, per the form's `origins`
//   GET     /embed.js, /embed.min.js the browser script (also on jsDelivr)
//   GET     /health
//
// What stands between the internet and the provider, in order:
//   10 KB request limit · origin check · per-IP request ceiling · honeypot ·
//   form token (single use, not too soon, not too late) · field check ·
//   captcha (when the form has one) · per-IP and per-form send limits.

var fs = require('fs');
var path = require('path');
var forms = require('./forms');
var throttleLib = require('./throttle');
var formToken = require('./formToken');

var PREFIX = '/public/v1';
var DEFAULT_MAX_BODY = 10 * 1024;
// Every POST, valid or not, counts here — a script hammering the endpoint with
// junk is slowed even though none of its posts would ever be sent.
var REQUESTS_PER_IP_PER_HOUR = 60;

var EMBED_DIR = path.join(__dirname, '..', '..', 'embed');

/** An error the handler turns into a response: status, message, and per-field problems. */
function HttpError(status, message, extra) {
  var err = new Error(message);
  err.status = status;
  Object.assign(err, extra || {});
  return err;
}

/**
 * The body, refused once it passes `max` bytes — by Content-Length before
 * reading anything, and by counting while reading for a sender that lied or
 * sent none. Nothing past the limit is ever held in memory.
 */
function readBody(req, max) {
  return new Promise(function(resolve, reject) {
    var declared = Number(req.headers['content-length']);
    if (declared > max) return reject(HttpError(413, 'The form is too large — at most ' + max + ' bytes'));
    var chunks = [];
    var size = 0;
    var done = false;
    req.on('data', function(chunk) {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.pause();
        return reject(HttpError(413, 'The form is too large — at most ' + max + ' bytes'));
      }
      chunks.push(chunk);
    });
    req.on('end', function() { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', function(err) { if (!done) { done = true; reject(err); } });
  });
}

/**
 * JSON or a plain HTML form post, into a flat { key: string }. Anything else —
 * nested objects, repeated keys — is refused rather than guessed at.
 */
function parseSubmission(text, contentType) {
  var type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    var params = new URLSearchParams(text);
    var flat = {};
    var repeated = null;
    params.forEach(function(value, key) {
      if (Object.prototype.hasOwnProperty.call(flat, key)) repeated = key;
      flat[key] = value;
    });
    if (repeated) throw HttpError(400, '"' + repeated + '" was sent more than once', { fields: { [repeated]: 'Sent more than once' } });
    return { body: flat, html: true };
  }
  var parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (e) {
    throw HttpError(400, 'The body must be JSON or a form post');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw HttpError(400, 'The body must be an object of field values');
  return { body: parsed, html: false };
}

/**
 * Who is calling. Behind nginx every socket is nginx's own address, so with
 * trustProxy the address nginx saw is read from X-Real-IP, or the LAST entry
 * of X-Forwarded-For (the one nginx appended — the first is whatever the
 * client claimed). Without trustProxy, headers are ignored: anyone could set
 * them, and spread their sends over a thousand made-up addresses.
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    var real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
    var xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Cloudflare Turnstile: the token the widget put in the form, checked with the secret. */
async function verifyTurnstile(secret, token, ip, fetchImpl) {
  if (!token) return false;
  var res = await (fetchImpl || fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: secret, response: String(token), remoteip: ip }).toString()
  });
  var data = await res.json().catch(function() { return {}; });
  return data.success === true;
}

function corsHeaders(form, origin) {
  if (!origin || !form || !forms.originAllowed(form, origin)) return {};
  return {
    'Access-Control-Allow-Origin': form.origins.indexOf('*') !== -1 && !form.origins.some(function(o) { return o !== '*'; }) ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, data, headers) {
  send(res, status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}), JSON.stringify(data));
}

/** The no-JavaScript answer: a small page, or a redirect the form's config chose. */
function page(res, status, title, lines, headers) {
  var body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + forms.escapeHtml(title) + '</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#222">' +
    '<h1 style="font-size:20px">' + forms.escapeHtml(title) + '</h1>' +
    lines.map(function(l) { return '<p>' + forms.escapeHtml(l) + '</p>'; }).join('') +
    '<p><a href="javascript:history.back()">Go back</a></p></body>';
  send(res, status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}), body);
}

function redirect(res, location) {
  send(res, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
}

/**
 * Build the request handler.
 *
 * @param {object} options
 * @param {object} options.forms - checked forms (forms.loadForms)
 * @param {function} options.send - (to, subject, html) → Promise; the provider
 * @param {number} [options.maxBodyBytes=10240]
 * @param {boolean} [options.trustProxy=false] - read the client address from X-Real-IP / X-Forwarded-For
 * @param {boolean} [options.dryRun=false] - log the mail instead of sending it
 * @param {function} [options.log=console.log]
 * @param {function} [options.fetch] - for the captcha check; tests replace it
 * @param {object} [options.tokens] - { secret, ttlSeconds, minSeconds, perIpPerHour, now } (formToken.js)
 */
function createPublicHandler(options) {
  var formsByKey = options.forms;
  var max = options.maxBodyBytes || DEFAULT_MAX_BODY;
  var throttle = options.throttle || throttleLib.createThrottle();
  var log = options.log || console.log;
  var tokens = formToken.createFormTokens(options.tokens);

  /** GET /public/v1/token/:key — one token, for this form and this visitor. */
  function issueToken(req, res, form) {
    var origin = req.headers.origin;
    if (!forms.originAllowed(form, origin)) return json(res, 403, { error: 'This form is not available to ' + origin });
    if (!form.token) return json(res, 200, { token: null, required: false }, corsHeaders(form, origin));
    var ip = clientIp(req, options.trustProxy);
    // Counted per address across every form, so a script cannot stockpile
    // tokens by asking for each form in turn.
    var limit = throttle.check('tok:' + ip, tokens.settings.perIpPerHour, throttleLib.HOUR);
    if (!limit.ok) {
      return json(res, 429, { error: 'Too many requests — try again later' },
        Object.assign({ 'Retry-After': String(limit.retryAfterSeconds) }, corsHeaders(form, origin)));
    }
    throttle.record('tok:' + ip);
    var issued = tokens.issue(form.key, ip);
    return json(res, 200, { token: issued.token, required: true, expiresIn: issued.expiresIn, minWait: issued.minWait }, corsHeaders(form, origin));
  }

  async function sendForm(req, res, form) {
    var origin = req.headers.origin;
    var ip = clientIp(req, options.trustProxy);
    var htmlPost = false;

    try {
      // Another site's page cannot post here from a visitor's browser. Not a
      // defence against a script — it sends whatever Origin it likes — which
      // is what everything below is for.
      if (!forms.originAllowed(form, origin)) throw HttpError(403, 'This form does not accept submissions from ' + origin);

      var ceiling = throttle.check('req:' + ip, REQUESTS_PER_IP_PER_HOUR, throttleLib.HOUR);
      throttle.record('req:' + ip);
      if (!ceiling.ok) throw HttpError(429, 'Too many requests — try again later', { retryAfter: ceiling.retryAfterSeconds });

      var parsed = parseSubmission(await readBody(req, max), req.headers['content-type']);
      htmlPost = parsed.html;
      var body = parsed.body;

      // A bot filled the field people never see. Answered as a success, so it
      // learns nothing to adapt to — and nothing is sent.
      if (body[forms.HONEYPOT]) {
        log('[email-public] ' + form.key + ': honeypot filled, dropped (' + ip + ')');
        return succeed(res, form, htmlPost, origin);
      }

      // Used up here, before anything else is checked: a send with a field
      // to correct still spends its token, and the embed script fetches the
      // next one. Otherwise one token could be tried any number of times.
      if (form.token) {
        var redeemed = tokens.redeem(body[forms.FORM_TOKEN], form.key, ip);
        if (!redeemed.ok) {
          log('[email-public] ' + form.key + ': token refused (' + redeemed.reason + ', ' + ip + ')');
          throw HttpError(403, redeemed.message, { token: redeemed.reason });
        }
      }

      var checked = forms.checkSubmission(form, body);
      if (Object.keys(checked.errors).length) {
        throw HttpError(400, 'Some fields need attention', { fields: checked.errors });
      }

      if (form.captcha) {
        var human = await verifyTurnstile(form.captcha.secret, body[forms.CAPTCHA_TOKEN], ip, options.fetch);
        if (!human) throw HttpError(400, 'The anti-spam check did not pass — please try again', { captcha: true });
      }

      var perIp = throttle.check('ip:' + form.key + ':' + ip, form.limits.perIpPerHour, throttleLib.HOUR);
      if (!perIp.ok) throw HttpError(429, 'You have sent this form several times already — please try again later', { retryAfter: perIp.retryAfterSeconds });
      var perDay = throttle.check('day:' + form.key, form.limits.perDay, throttleLib.DAY);
      if (!perDay.ok) throw HttpError(429, 'This form is not taking more messages today — please email us directly', { retryAfter: perDay.retryAfterSeconds });

      var mail = forms.composeMail(form, checked.values, { origin: origin, at: new Date().toISOString() });
      if (options.dryRun) {
        log('[email-public] DRY RUN — not sent:\n  to: ' + mail.to.join(', ') + '\n  subject: ' + mail.subject + '\n  values: ' + JSON.stringify(checked.values));
      } else {
        try {
          await options.send(mail.to, mail.subject, mail.html);
        } catch (err) {
          // The provider's own words stay in the log: they can name the
          // account, the host or the recipient.
          log('[email-public] ' + form.key + ': provider refused the send: ' + (err && err.message));
          throw HttpError(502, 'The message could not be sent right now — please try again later');
        }
      }
      // Counted only once it has gone, so a provider outage does not use up
      // a visitor's sends.
      throttle.record('ip:' + form.key + ':' + ip);
      throttle.record('day:' + form.key);
      log('[email-public] ' + form.key + ': sent (' + ip + ')');
      return succeed(res, form, htmlPost, origin);
    } catch (err) {
      return failed(res, form, err, htmlPost, origin);
    }
  }

  function succeed(res, form, htmlPost, origin) {
    if (htmlPost) {
      if (form.redirect) return redirect(res, form.redirect);
      return page(res, 200, 'Thank you', [form.sentMessage]);
    }
    return json(res, 200, { success: true, message: form.sentMessage }, corsHeaders(form, origin));
  }

  function failed(res, form, err, htmlPost, origin) {
    var status = err.status || 500;
    if (status === 500) log('[email-public] ' + (form ? form.key : '?') + ': ' + (err.stack || err.message));
    var message = status === 500 ? 'Something went wrong — please try again later' : err.message;
    var headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
    // The request may still be streaming in (413). Close the connection
    // rather than read the rest of something already refused.
    if (status === 413) headers.Connection = 'close';
    if (htmlPost) {
      if (form && form.redirectError) {
        return redirect(res, form.redirectError + (form.redirectError.indexOf('?') === -1 ? '?' : '&') + 'error=' + encodeURIComponent(message));
      }
      var lines = [message];
      if (err.fields) Object.keys(err.fields).forEach(function(k) {
        var f = form && form.fields.filter(function(x) { return x.key === k; })[0];
        lines.push((f ? f.label : k) + ': ' + err.fields[k]);
      });
      return page(res, status, 'Not sent', lines, headers);
    }
    var body = { success: false, error: message };
    if (err.fields) body.fields = err.fields;
    if (err.captcha) body.captcha = true;
    if (err.token) body.token = err.token;
    return json(res, status, body, Object.assign(headers, corsHeaders(form, origin)));
  }

  function serveEmbed(res, name) {
    fs.readFile(path.join(EMBED_DIR, name), function(err, data) {
      if (err) return json(res, 404, { error: 'Not found' });
      send(res, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        // Loaded by <script> from any site — that is the point of it.
        'Access-Control-Allow-Origin': '*'
      }, data);
    });
  }

  return async function handler(req, res) {
    var url = new URL(req.url, 'http://local');
    var p = url.pathname.replace(/\/+$/, '') || '/';
    var method = req.method;

    try {
      if (method === 'GET' && (p === '/' || p === '/health')) return json(res, 200, { service: 'email-public', status: 'ok' });
      if (method === 'GET' && (p === '/embed.js' || p === '/embed.min.js')) return serveEmbed(res, p.slice(1));

      var m = /^\/public\/v1\/(forms|send|token)\/([A-Za-z0-9_]+)$/.exec(p);
      if (!m) return json(res, 404, { error: 'Not found' });
      var form = Object.prototype.hasOwnProperty.call(formsByKey, m[2]) ? formsByKey[m[2]] : null;
      var origin = req.headers.origin;

      if (method === 'OPTIONS') {
        if (!form || !forms.originAllowed(form, origin)) return send(res, 403, {}, '');
        return send(res, 204, corsHeaders(form, origin), '');
      }
      if (!form) return json(res, 404, { error: 'There is no form "' + m[2] + '"' });

      if (m[1] === 'forms' && method === 'GET') {
        if (!forms.originAllowed(form, origin)) return json(res, 403, { error: 'This form is not available to ' + origin });
        return json(res, 200, forms.publicDefinition(form), Object.assign({ 'Cache-Control': 'public, max-age=60' }, corsHeaders(form, origin)));
      }
      if (m[1] === 'token' && method === 'GET') return issueToken(req, res, form);
      if (m[1] === 'send' && method === 'POST') return sendForm(req, res, form);
      return json(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      log('[email-public] ' + (err.stack || err.message));
      return json(res, 500, { error: 'Something went wrong — please try again later' });
    }
  };
}

module.exports = { createPublicHandler: createPublicHandler, clientIp: clientIp, parseSubmission: parseSubmission, PREFIX: PREFIX };
