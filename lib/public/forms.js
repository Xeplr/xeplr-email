// PUBLIC FORMS — what a website may send, defined on the SERVER.
//
// The public service never takes a recipient, a subject or HTML from a
// request. It takes a form's KEY and the values of that form's fields; who the
// mail goes to, what it says and which fields exist are all here, in config.
// So nobody can redirect a mail, write their own HTML into it, or attach a
// file — none of that is in the request at all.
//
//   {
//     "forms": {
//       "demo": {
//         "to": "demo@xeplr.com",
//         "subject": "Demo request from {{name}}",
//         "origins": ["https://xeplr.com"],
//         "fields": [
//           { "key": "name",    "label": "Your name",  "type": "text",  "required": true },
//           { "key": "email",   "label": "Work email", "type": "email", "required": true },
//           { "key": "sources", "label": "Data lives in", "type": "select",
//             "options": ["Postgres", "MySQL / MariaDB", "SQL Server"] },
//           { "key": "message", "label": "Message", "type": "multiline" }
//         ],
//         "limits": { "perIpPerHour": 5, "perDay": 200 },
//         "redirect": "https://xeplr.com/thanks"
//       }
//     }
//   }
//
// Everything is checked when the config loads, so a mistake stops the
// service at boot rather than surfacing as a form that silently never sends.

var FIELD_TYPES = ['text', 'email', 'tel', 'multiline', 'select'];

// Room for what people actually type, well inside the 10 KB request limit.
var DEFAULT_MAX_LENGTH = { text: 200, email: 254, tel: 40, multiline: 5000, select: 200 };

var DEFAULT_LIMITS = { perIpPerHour: 5, perDay: 200 };

// Not fields of any form: the honeypot, the form token (formToken.js), and
// Cloudflare Turnstile's token (whose name Turnstile fixes, dash and all —
// which is why field keys may not contain one).
var HONEYPOT = '_hp';
var FORM_TOKEN = '_token';
var CAPTCHA_TOKEN = 'cf-turnstile-response';
var RESERVED = [HONEYPOT, FORM_TOKEN, CAPTCHA_TOKEN];

var KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// Loose on purpose: one @, a dot after it, no spaces (so no line breaks — an
// address can end up in a header). The mail server is the real judge; a
// stricter pattern only refuses real addresses people then cannot get past.
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(where, message) {
  throw new Error('email public forms: ' + where + ' ' + message);
}

function isHttpsUrl(value) {
  try {
    var u = new URL(value);
    // http only for localhost, so a local test works and nothing else is sent
    // to a page in the clear.
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch (e) {
    return false;
  }
}

function checkField(f, where) {
  if (!f || typeof f !== 'object') fail(where, 'is not an object');
  if (!KEY_PATTERN.test(String(f.key || ''))) {
    fail(where, 'key "' + f.key + '" must start with a letter and hold only letters, digits and _ (up to 40)');
  }
  var type = f.type || 'text';
  if (FIELD_TYPES.indexOf(type) === -1) fail(where, 'type "' + type + '" is not one of ' + FIELD_TYPES.join(', '));
  if (type === 'select') {
    if (!Array.isArray(f.options) || !f.options.length) fail(where, 'is a select with no options');
    f.options.forEach(function(o) { if (typeof o !== 'string') fail(where, 'has an option that is not text'); });
  }
  var maxLength = f.maxLength == null ? DEFAULT_MAX_LENGTH[type] : Number(f.maxLength);
  if (!(maxLength > 0)) fail(where, 'maxLength must be a positive number');
  return {
    key: f.key,
    label: String(f.label || f.key),
    type: type,
    required: Boolean(f.required),
    maxLength: maxLength,
    options: type === 'select' ? f.options.slice() : undefined,
    placeholder: f.placeholder == null ? undefined : String(f.placeholder),
    help: f.help == null ? undefined : String(f.help),
    rows: f.rows == null ? undefined : Number(f.rows)
  };
}

function checkForm(key, form) {
  var where = 'form "' + key + '"';
  if (!KEY_PATTERN.test(key)) fail(where, 'key must start with a letter and hold only letters, digits and _');
  if (!form || typeof form !== 'object') fail(where, 'is not an object');

  var to = [].concat(form.to || []).map(function(a) { return String(a).trim(); }).filter(Boolean);
  if (!to.length) fail(where, 'has no "to" — who its mail goes to');
  to.forEach(function(a) { if (!EMAIL_PATTERN.test(a)) fail(where, 'has "' + a + '" in "to", which is not an email address'); });

  if (!Array.isArray(form.fields) || !form.fields.length) fail(where, 'has no fields');
  var seen = {};
  var fields = form.fields.map(function(f, i) {
    var field = checkField(f, where + ' field ' + (i + 1));
    if (seen[field.key]) fail(where, 'has two fields called "' + field.key + '"');
    seen[field.key] = true;
    return field;
  });

  var origins = [].concat(form.origins || []).map(function(o) {
    var s = String(o).replace(/\/+$/, '');
    if (s !== '*' && !isHttpsUrl(s)) fail(where, 'has origin "' + o + '" — an origin is https://host, or * for any');
    return s;
  });

  ['redirect', 'redirectError'].forEach(function(name) {
    if (form[name] != null && !isHttpsUrl(form[name])) fail(where, name + ' must be an https:// URL');
  });

  var limits = Object.assign({}, DEFAULT_LIMITS, form.limits || {});
  ['perIpPerHour', 'perDay'].forEach(function(name) {
    if (!(Number(limits[name]) > 0)) fail(where, 'limits.' + name + ' must be a positive number');
    limits[name] = Number(limits[name]);
  });

  var captcha = null;
  if (form.captcha) {
    var t = form.captcha.turnstile;
    if (!t || !t.siteKey) fail(where, 'captcha needs turnstile.siteKey');
    var secret = t.secret || (t.secretEnv ? process.env[t.secretEnv] : null);
    if (!secret) fail(where, 'captcha needs turnstile.secretEnv naming an env var that is set (or turnstile.secret)');
    captcha = { siteKey: String(t.siteKey), secret: String(secret) };
  }

  return {
    key: key,
    title: form.title == null ? undefined : String(form.title),
    to: to,
    subject: String(form.subject || 'New submission: ' + key),
    fields: fields,
    origins: origins,
    limits: limits,
    redirect: form.redirect || null,
    redirectError: form.redirectError || null,
    submitLabel: String(form.submitLabel || 'Send'),
    sentMessage: String(form.sentMessage || 'Thank you — your message has been sent.'),
    // On unless the config says false: a form posted with no JavaScript at
    // all cannot fetch a token, so it has to opt out (formToken.js).
    token: form.token !== false,
    captcha: captcha
  };
}

/** Raw config → { forms: { key: form } }, every form checked. Throws naming the problem. */
function loadForms(config) {
  var raw = (config && config.forms) || {};
  var keys = Object.keys(raw);
  if (!keys.length) fail('config', 'defines no forms');
  var forms = {};
  keys.forEach(function(key) { forms[key] = checkForm(key, raw[key]); });
  return forms;
}

/**
 * What a browser may see of a form — enough to draw it. Never `to`, the
 * limits or the captcha secret.
 */
function publicDefinition(form) {
  return {
    key: form.key,
    title: form.title,
    fields: form.fields,
    submitLabel: form.submitLabel,
    sentMessage: form.sentMessage,
    token: form.token,
    captcha: form.captcha ? { turnstile: { siteKey: form.captcha.siteKey } } : null
  };
}

/** Whether a request from `origin` may use this form. No Origin header: not a browser — allowed, see handler.js. */
function originAllowed(form, origin) {
  if (!origin || !form.origins.length) return true;
  var o = String(origin).replace(/\/+$/, '');
  return form.origins.indexOf('*') !== -1 || form.origins.indexOf(o) !== -1;
}

/**
 * Check a submission against its form. Returns { values, errors } — errors is
 * {} when it is fine. A key the form does not define is an error too, named,
 * so an HTML form and its config that disagree show up on the first test
 * rather than as a field that quietly never arrives.
 */
function checkSubmission(form, body) {
  var errors = {};
  var values = {};
  body = body || {};

  Object.keys(body).forEach(function(key) {
    if (RESERVED.indexOf(key) !== -1) return;
    var known = form.fields.some(function(f) { return f.key === key; });
    if (!known) errors[key] = '"' + key + '" is not a field of this form';
  });

  form.fields.forEach(function(f) {
    var raw = body[f.key];
    if (raw != null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      errors[f.key] = 'Must be text';
      return;
    }
    var v = raw == null ? '' : String(raw).trim();
    if (f.required && !v) { errors[f.key] = 'This is required'; return; }
    if (!v) return;
    if (v.length > f.maxLength) { errors[f.key] = 'At most ' + f.maxLength + ' characters'; return; }
    if (f.type === 'email' && !EMAIL_PATTERN.test(v)) { errors[f.key] = 'That is not an email address'; return; }
    if (f.type === 'select' && f.options.indexOf(v) === -1) { errors[f.key] = 'Choose one of the options'; return; }
    values[f.key] = v;
  });

  return { values: values, errors: errors };
}

/** Text into HTML text. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The mail for a checked submission: { to, subject, html }. Every value is
 * escaped into the body; the subject is one line, its {{key}} tokens filled
 * from the values, with any line break removed — a subject is a header, and a
 * newline in a header is how extra headers get written.
 */
function composeMail(form, values, meta) {
  meta = meta || {};
  var subject = form.subject.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function(_, key) {
    return values[key] == null ? '' : String(values[key]);
  }).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || ('New submission: ' + form.key);

  var rows = form.fields.map(function(f) {
    var v = values[f.key];
    var shown = v == null || v === '' ? '<em style="color:#888">—</em>'
      : f.type === 'multiline' ? escapeHtml(v).replace(/\r?\n/g, '<br>')
      : escapeHtml(v);
    return '<tr><th align="left" valign="top" style="padding:6px 16px 6px 0;white-space:nowrap">' + escapeHtml(f.label) +
      '</th><td style="padding:6px 0">' + shown + '</td></tr>';
  }).join('');

  var footer = 'Sent from the "' + escapeHtml(form.key) + '" form' +
    (meta.origin ? ' on ' + escapeHtml(meta.origin) : '') +
    (meta.at ? ' at ' + escapeHtml(meta.at) : '') + '.';

  var html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222">' +
    (form.title ? '<h2 style="font-size:16px;margin:0 0 12px">' + escapeHtml(form.title) + '</h2>' : '') +
    '<table style="border-collapse:collapse">' + rows + '</table>' +
    '<p style="margin-top:16px;color:#888;font-size:12px">' + footer + '</p></div>';

  return { to: form.to.slice(), subject: subject, html: html };
}

module.exports = {
  FIELD_TYPES: FIELD_TYPES,
  HONEYPOT: HONEYPOT,
  FORM_TOKEN: FORM_TOKEN,
  CAPTCHA_TOKEN: CAPTCHA_TOKEN,
  loadForms: loadForms,
  publicDefinition: publicDefinition,
  originAllowed: originAllowed,
  checkSubmission: checkSubmission,
  composeMail: composeMail,
  escapeHtml: escapeHtml
};
