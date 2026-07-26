const { configureEmail, sendEmail } = require('@xeplr/utils');
const Queue = require('@xeplr/utils/lib/queue');
const { http: httpFactory } = require('@xeplr/base-apis');
const emailHandler = require('./lib/emailHandler');

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
var requiredEnv = ['EMAIL_PROVIDER', 'BREVO_API_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME'];

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

module.exports = {
  requiredEnv,
  init,
  configureFromEnv,
  start,
  send,
  isHealthy
};
