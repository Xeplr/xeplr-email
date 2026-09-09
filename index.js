const { configureEmail, sendEmail } = require('@xeplr/utils');
const Queue = require('@xeplr/utils/lib/queue');
const { http: httpFactory } = require('@xeplr/base-apis');
const emailHandler = require('./lib/emailHandler');
// The TEMPLATE STORE — this service's own database. Required lazily inside
// initTemplates so an install that only sends mail never needs @xeplr/db or a
// database at all; everything below it is unchanged and still works with no
// templates configured.
let _templatesDb = null;
let _templates = null;

var _queue = null;
var _healthy = false;
var _testTo = null;

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
 */
function init(config = {}) {
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
  send,
  isHealthy
};

// A getter, so `...require('@xeplr/email').requiredEnv` reflects the provider
// the consumer configured rather than whatever was set when this file loaded.
Object.defineProperty(module.exports, 'requiredEnv', {
  enumerable: true,
  get: function () { return requiredEnvFor(process.env.EMAIL_PROVIDER); }
});
