const { configureEmail, sendEmail } = require('@xeplr/utils');
const Queue = require('@xeplr/utils/lib/queue');
// The PLAIN Node HTTP server (no Express, no auth gate) — base-apis 2.x
// exports it as createHttpServer; 1.x called it `http`.
const { createHttpServer: httpFactory } = require('@xeplr/base-apis');
const emailHandler = require('./lib/emailHandler');
const controlling = require('./lib/controlling');
// The TEMPLATE STORE — this service's own database. Required lazily inside
// initTemplates so an install that only sends mail never needs @xeplr/db or a
// database at all; everything below it is unchanged and still works with no
// templates configured.
let _templatesDb = null;
let _templates = null;

var _queue = null;
var _healthy = false;
var _testTo = null;
var _allowRules = null;

/**
 * Initialize xeplr-email (configure the email provider).
 *
 * @param {object} config
 * @param {string} config.provider - 'smtp' | 'aws' | 'azure' | 'brevo'
 * @param {boolean} [config.useQueue=false] - Queue emails instead of sending immediately
 * @param {number} [config.flushIntervalInSeconds=5] - Queue flush interval
 * @param {number} [config.maxEmptyTicks=3] - Auto-pause after N empty ticks
 * @param {string} [config.testTo] - Send a test email on startup to verify health
 * @param {object} [config.smtp] - { host, port, user, pass, from }
 * @param {object} [config.aws] - { region, accessKeyId, secretAccessKey, from }
 * @param {object} [config.azure] - { connectionString, from }
 * @param {object} [config.brevo] - { apiKey, fromEmail, fromName }
 * @param {object} [config.allow] - The body pattern POST /internal/send accepts
 *   (lib/controlling.js). Falls back to EMAIL_ALLOW; unset, every send is accepted.
 */
function init(config = {}) {
  // First, so a malformed rule stops the boot before anything is configured.
  _allowRules = config.allow ? controlling.compileRules(config.allow) : controlling.fromEnv();

  if (config.provider) {
    configureEmail(config);
  }

  if (config.useQueue) {
    _queue = new Queue({
      action: async function(item) {
        await sendEmail(item.to, item.subject, item.html, item.cc, item.attachments);
      },
      autoIntervalInSeconds: config.flushIntervalInSeconds || 5,
      maxEmptyTicks: config.maxEmptyTicks || 3
    });
  }

  _testTo = config.testTo || process.env.EMAIL_TEST_TO || null;

  if (_testTo) {
    _sendTestEmail();
  }
}

async function _sendTestEmail() {
  try {
    var timestamp = new Date().toISOString();
    await sendEmail(
      [_testTo],
      'xeplr-email health check - ' + timestamp,
      '<p>Email service started and healthy at <strong>' + timestamp + '</strong></p>'
    );
    _healthy = true;
  } catch (err) {
    _healthy = false;
    console.error('[email] health check FAILED — could not send test mail to ' +
      _testTo + ': ' + (err && err.message ? err.message : err));
  }
}

/**
 * Check if the email service is healthy (test email was sent successfully).
 */
function isHealthy() {
  return _healthy;
}

/** The compiled body rules /internal/send checks against, or null when off. */
function getAllowRules() {
  return _allowRules;
}

/**
 * Send an email. If useQueue is enabled, queues the email for later delivery.
 *
 * @param {string[]} to - Recipient emails
 * @param {string} subject - Email subject
 * @param {string} html - HTML body
 * @param {string[]} [cc] - CC recipients
 * @param {string[]} [attachments] - File paths to attach
 */
function send(to, subject, html, cc, attachments) {
  if (_queue) {
    _queue.addToQueue({ to, subject, html, cc, attachments });
  } else {
    return sendEmail(to, subject, html, cc, attachments);
  }
}

/**
 * Start xeplr-email as a standalone plain HTTP server.
 *
 * @param {object} config
 * @param {number|string} config.port - Port to listen on (default: EMAIL_PORT env or 19007)
 * @param {string} [config.provider] - Email provider
 * @param {boolean} [config.useQueue=false] - Queue emails
 * @param {string} [config.testTo] - Send test email on startup
 * @param {object} [config.smtp] - SMTP options
 * @param {object} [config.aws] - AWS SES options
 * @param {object} [config.azure] - Azure Communication options
 * @param {object} [config.brevo] - Brevo options
 * @returns {http.Server}
 */
function start(config = {}) {
  init(config);

  var port = config.port || process.env.EMAIL_PORT || 19007;
  return httpFactory.init(port, 'xeplr-email', emailHandler);
}

/**
 * Start the PUBLIC email service — what a website's forms reach. A separate
 * process from start(): this one never takes a recipient, a subject or HTML
 * from a request, only a form's key and its field values; the forms
 * themselves are config (lib/public/forms.js). Never point a website at
 * start()'s /internal/send.
 *
 * @param {object} config
 * @param {object} config.forms - { key: { to, subject, fields, origins, limits, … } }
 * @param {number|string} [config.port] - default EMAIL_PUBLIC_PORT or 19008
 * @param {string} [config.host] - default EMAIL_PUBLIC_HOST or 127.0.0.1: only nginx on the same
 *   machine reaches it. Anything wider lets a caller skip nginx and claim any X-Real-IP
 * @param {number} [config.maxBodyBytes=10240] - a larger request is refused (413)
 * @param {boolean} [config.trustProxy=false] - behind nginx: read the visitor's address from X-Real-IP
 * @param {boolean} [config.dryRun=false] - log each mail instead of sending it
 * @param {object} [config.tokens] - form tokens: { ttlSeconds=3600, minSeconds=3, perIpPerHour=30 }.
 *   The signing secret comes from EMAIL_PUBLIC_TOKEN_SECRET; unset, a new one each start (lib/public/formToken.js)
 * @param {string} [config.provider] - and its settings, as for init(); omitted, the provider comes from the environment
 * @returns {http.Server}
 */
function startPublic(config = {}) {
  var { loadForms } = require('./lib/public/forms');
  var { createPublicHandler } = require('./lib/public/handler');
  var forms = loadForms(config);   // a bad form stops the boot, naming it

  if (config.provider) {
    init(config);
  } else if (!configureFromEnv() && !config.dryRun) {
    throw new Error('email public: no provider — set EMAIL_PROVIDER and its settings, or pass config.provider. Nothing would ever be sent.');
  }

  var port = config.port || process.env.EMAIL_PUBLIC_PORT || 19008;
  var handler = createPublicHandler({
    forms: forms,
    // Read through module.exports so a test (or an app) can replace send().
    send: function(to, subject, html) { return module.exports.send(to, subject, html); },
    maxBodyBytes: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    dryRun: config.dryRun,
    log: config.log,
    // The secret never goes in forms.json, which sits beside a website's code.
    tokens: Object.assign({}, config.tokens, { secret: process.env.EMAIL_PUBLIC_TOKEN_SECRET || undefined })
  });
  var host = config.host || process.env.EMAIL_PUBLIC_HOST || '127.0.0.1';
  console.log('[email-public] forms: ' + Object.keys(forms).join(', ') + (config.dryRun ? ' (DRY RUN — nothing is sent)' : ''));
  // Its own plain server rather than base-apis', which listens on every
  // address and takes no host. This one must not: see config.host.
  var server = require('http').createServer(handler);
  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') { console.error('[email-public] ' + host + ':' + port + ' is already in use'); process.exit(1); }
    throw err;
  });
  server.listen(Number(port), host, function() {
    console.log('[email-public] listening on ' + host + ':' + server.address().port);
  });
  return server;
}

// Env vars this library needs (Brevo provider). Apps that send email spread
// this into their env.required.js — names owned here, not re-listed per app.
// WHICH vars are mandatory depends on the PROVIDER. A fixed BREVO_* list
// refused to boot an install running on SMTP, over credentials it never uses
// — and the reverse would wave through a real misconfiguration. Only the
// providers emailConfigFromEnv actually builds a config for are listed;
// anything else needs EMAIL_PROVIDER alone.
//
// Read at ACCESS time (see the getter on module.exports, not a constant): a
// consumer loads its .env and only then requires env.required.js, so the
// provider is not known when this module is first evaluated.
var providerRequiredEnv = {
  brevo: ['BREVO_API_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME'],
  // SMTP_PORT is deliberately absent — it defaults to 587 (STARTTLS), which
  // is a protocol default, not a guess at where data lives.
  smtp: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
};

function requiredEnvFor(provider) {
  var extra = providerRequiredEnv[String(provider || '').toLowerCase()] || [];
  return ['EMAIL_PROVIDER'].concat(extra);
}

// SENDING mail and STORING templates are two different capabilities, so they
// are two different lists. Most apps only send — they need a provider and no
// database at all (see the note at the top of this file). Only an app that
// calls initTemplates() needs a store, and only that app spreads this:
//
//   ...require('@xeplr/email').templatesRequiredEnv,   // EMAIL_DB_NAME
//
// Required with no default because TEMPLATES ARE APP-SPECIFIC — a
// registration mail is written for one product's wording and branding. One
// shared store would mean two apps overwriting each other's template of the
// same name, so each app owns its own (see lib/db.js).
var templatesRequiredEnv = ['EMAIL_DB_NAME'];

/**
 * Configure the email provider from the environment — reads process.env (NOT a
 * .env file; the consumer app loads that). So no app/lib hand-wires email:
 * call this once at boot and everything that uses @xeplr/utils sendEmail (auth,
 * jobs, …) is ready. No-op + returns false if EMAIL_PROVIDER isn't set.
 */
function configureFromEnv() {
  // Single source for env→email config lives in @xeplr/utils. Here we reuse it,
  // then run it through init() so the wrapper's queue/health extras apply too.
  var config = require('@xeplr/utils').emailConfigFromEnv();
  if (!config) return false;
  init(config);
  return true;
}

/**
 * Bring up the template store: connect, create `xeplr_email` if absent, run
 * migrations. Call once at boot IF you want templates — sending works without
 * it, so an install that does not use templates configures nothing.
 *
 * Connection comes from the shared XEPLR_DB_CONNECTION (override with
 * EMAIL_DB_CONNECTION_INFO_ENCRYPTED). Database name is fixed at xeplr_email.
 */
async function initTemplates(config) {
  _templatesDb = require('./lib/db');
  _templates = require('./lib/templates');
  await _templatesDb.ready(config);
  return _templates;
}

/** Express router for template CRUD + preview. Mount after initTemplates(). */
function templatesRouter(config) {
  return require('./lib/templatesRouter')(config);
}

/**
 * Render a stored template into { subject, html, text }.
 * Throws EMAIL_TEMPLATE_NOT_FOUND / EMAIL_TEMPLATE_MISSING_VARS.
 */
async function renderTemplate(name, variables, opts) {
  if (!_templates) throw new Error('email: call initTemplates() before renderTemplate().');
  return _templates.render(name, variables, opts);
}

/** Send a stored template — render, then hand to the configured provider. */
async function sendTemplate(name, to, variables, opts) {
  const rendered = await renderTemplate(name, variables, opts);
  return send(to, rendered.subject, rendered.html, (opts || {}).cc, (opts || {}).attachments);
}

function templatesReady() {
  return Boolean(_templatesDb && _templatesDb.isInitialised());
}

module.exports = {
  templatesRequiredEnv,
  initTemplates,
  templatesRouter,
  renderTemplate,
  sendTemplate,
  templatesReady,
  init,
  configureFromEnv,
  start,
  startPublic,
  send,
  isHealthy,
  getAllowRules,
  controlling
};

// A getter, so `...require('@xeplr/email').requiredEnv` reflects the provider
// the consumer configured rather than whatever was set when this file loaded.
Object.defineProperty(module.exports, 'requiredEnv', {
  enumerable: true,
  get: function () { return requiredEnvFor(process.env.EMAIL_PROVIDER); }
});
