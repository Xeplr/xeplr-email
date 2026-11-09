// CONTROLLING WHAT MAY BE SENT.
//
// An `allow` pattern every POST /internal/send body must match — e.g.
// { to: ['admin@xeplr.com'] }, and a send to anyone else is refused. Off until
// configured: with no rules, the endpoint behaves as it always has.
//
// Rules, not identity. The service has no authentication by design (internal
// services call it unconditionally), so these apply to every caller alike.
//
// A send that does not match is REFUSED, naming the field, rather than
// trimmed: dropping one recipient and sending to the rest would deliver a mail
// nobody asked for in that shape.
//
// ── config ───────────────────────────────────────────────────────────────
//
//   init({ ..., allow: { to: ['admin@xeplr.com'], cc: false, attachments: false } })
//
// or from the environment: EMAIL_ALLOW, the same object as JSON —
//
//   EMAIL_ALLOW={"to":["admin@xeplr.com","*@xeplr.com"],"attachments":false}
//
// ── rules ────────────────────────────────────────────────────────────────
//
// `allow` maps a body field — to, cc, subject, html, attachments — to what it
// may hold. A field the rules do not name is not checked; a body field that is
// not one of those five is refused once rules are on, so nothing rides along
// unchecked.
//
//   'admin@xeplr.com'      exactly this (emails compare case-insensitively)
//   '*@xeplr.com'          `*` matches any run of characters
//   '/^report-\\d+$/i'     a regular expression, written as a string (for JSON)
//   /^report-\d+$/i        a RegExp, from code
//   function (value) {…}   from code: return true to allow
//   [a, b, …]              any one of them
//   false  or  []          must be absent or empty
//
// For a list field (to, cc, attachments) EVERY entry must match. A named
// field that is absent passes, unless it is `to`, which a send always has.

var FIELDS = ['to', 'cc', 'subject', 'html', 'attachments'];
var LIST_FIELDS = { to: true, cc: true, attachments: true };
var EMAIL_FIELDS = { to: true, cc: true };

/** A refusal, with the HTTP status the handler answers with and the field. */
function RuleError(message, field) {
  var err = new Error(message);
  err.status = 403;
  err.field = field;
  return err;
}

/** '/body/flags' → RegExp; anything else → null. */
function regexFromString(str) {
  var m = /^\/(.+)\/([gimsuy]*)$/.exec(str);
  if (!m) return null;
  // g and y make .test() stateful (lastIndex), so the same rule would pass
  // and then fail for the same value. Never wanted here.
  return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
}

function globToRegex(glob, caseInsensitive) {
  var escaped = glob.split('*').map(function(part) {
    return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('.*');
  return new RegExp('^' + escaped + '$', caseInsensitive ? 'i' : '');
}

/**
 * One matcher → a function(value) → boolean. Strings are compiled once, at
 * config time, so a malformed rule fails the boot rather than every send.
 */
function compileMatcher(rule, field) {
  if (Array.isArray(rule)) {
    var each = rule.map(function(r) { return compileMatcher(r, field); });
    return function(value) { return each.some(function(fn) { return fn(value); }); };
  }
  if (rule instanceof RegExp) {
    var re = new RegExp(rule.source, rule.flags.replace(/[gy]/g, ''));
    return function(value) { return re.test(String(value)); };
  }
  if (typeof rule === 'function') return function(value) { return rule(value) === true; };
  if (typeof rule === 'string') {
    var asRegex = regexFromString(rule);
    if (asRegex) return function(value) { return asRegex.test(String(value)); };
    var glob = globToRegex(rule, Boolean(EMAIL_FIELDS[field]));
    return function(value) { return glob.test(String(value).trim()); };
  }
  throw new Error('email controlling: the rule for "' + field + '" must be a string, RegExp, function, array or false — got ' + JSON.stringify(rule));
}

/**
 * An `allow` object → compiled rules ({ field: { forbid, match } }), checked
 * now: a rule naming a field that does not exist would otherwise never fire,
 * and the send it was meant to stop would go out.
 */
function compileRules(allow) {
  if (allow == null) return null;
  if (typeof allow !== 'object' || Array.isArray(allow)) {
    throw new Error('email controlling: allow must be an object of field rules');
  }
  var compiled = {};
  Object.keys(allow).forEach(function(field) {
    if (FIELDS.indexOf(field) === -1) {
      throw new Error('email controlling: there is a rule for "' + field + '", which is not a send field (' + FIELDS.join(', ') + ')');
    }
    var rule = allow[field];
    var forbid = rule === false || (Array.isArray(rule) && rule.length === 0);
    compiled[field] = { forbid: forbid, match: forbid ? null : compileMatcher(rule, field) };
  });
  return compiled;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * Check a send body against compiled rules. Throws a 403 naming the first
 * field, and value, that does not fit; returns nothing when it all fits.
 */
function check(body, rules) {
  if (!rules) return;
  body = body || {};
  Object.keys(body).forEach(function(key) {
    if (FIELDS.indexOf(key) === -1) throw RuleError('"' + key + '" is not accepted in a send', key);
  });
  Object.keys(rules).forEach(function(field) {
    var rule = rules[field];
    var value = body[field];
    if (rule.forbid) {
      if (!isEmpty(value)) throw RuleError(field + ' is not allowed', field);
      return;
    }
    if (isEmpty(value)) {
      if (field === 'to') throw RuleError('to is required', field);
      return;
    }
    var values = LIST_FIELDS[field] ? [].concat(value) : [value];
    values.forEach(function(v) {
      if (!rule.match(v)) {
        // Never echo a whole html body back into an error.
        throw RuleError(field + ' ' + (field === 'html' ? 'does not match the allowed pattern' : '"' + v + '" is not allowed'), field);
      }
    });
  });
}

/**
 * Compiled rules from EMAIL_ALLOW, or null when it is unset (controlling off).
 * Invalid JSON fails the boot: ignoring it would leave sending OPEN — the
 * opposite of what somebody setting this variable asked for.
 */
function fromEnv() {
  var raw = process.env.EMAIL_ALLOW;
  if (!raw || !raw.trim()) return null;
  var allow;
  try {
    allow = JSON.parse(raw);
  } catch (err) {
    throw new Error('email controlling: EMAIL_ALLOW is not valid JSON: ' + err.message);
  }
  return compileRules(allow);
}

module.exports = {
  compileRules: compileRules,
  check: check,
  fromEnv: fromEnv,
  FIELDS: FIELDS
};
