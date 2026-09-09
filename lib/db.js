// The TEMPLATE STORE's database — one per app, named by EMAIL_DB_NAME.
//
// This used to default to a fixed `xeplr_email`, on the reasoning that it
// would never be anything else on a normal install. That reasoning was wrong,
// and in the direction that costs most: TEMPLATES ARE APP-SPECIFIC. A "user
// registration" mail belongs to one product's wording, branding and flow —
// there is very little a template could say that is true of every app at
// once. So a single shared xeplr_email is not a convenience, it is two
// products overwriting each other's copy of a template by name.
//
// Hence: required, no default, one store per consumer (xeplr_bi_email,
// xeplr_workflow_email) — the same rule as DB_JOBS and DB_WORKFLOW. App
// -specific defaults belong in each app's own migrations, not in a store
// everyone shares.
//
// The CONNECTION comes from the shared XEPLR_DB_CONNECTION that every xeplr
// service reads, with EMAIL_DB_CONNECTION_INFO_ENCRYPTED as a per-service
// override — see @xeplr/db's resolve-connection.js. Same server, separate
// database.
//
// The database CREATES ITSELF (@xeplr/db's ensureDatabase) so standing this up
// is one env var and a restart, not a manual createdb the first person to
// deploy discovers the hard way. It needs a login with CREATEDB; without one,
// create `xeplr_email` by hand once and everything after works.

var { getConnection, bindModels, ensureDatabase, resolveDbConnection, sqlMigrator, migrationsFor } = require('@xeplr/db');
var { decrypt } = require('@xeplr/utils/isomorphic/crypto');
var path = require('path');
var EmailTemplate = require('../models/EmailTemplate');

var CONN_VAR = 'EMAIL_DB_CONNECTION_INFO_ENCRYPTED';

var _conn = null;
var _ready = null;

function dbName() {
  var name = process.env.EMAIL_DB_NAME;
  if (!name) {
    throw new Error(
      '@xeplr/email: EMAIL_DB_NAME is not set — the template store has no default. ' +
      'Templates are app-specific, so each app owns its own (e.g. xeplr_bi_email); ' +
      'a shared one would have two products overwriting each other\'s templates by name. ' +
      'Spread require("@xeplr/email").templatesRequiredEnv into your env.required.js to ' +
      'catch this at startup. Sending mail does NOT need this — only initTemplates() does.');
  }
  return name;
}

/**
 * Connect, create the database if absent, and run migrations. Memoized — every
 * caller awaits the same bootstrap rather than racing a second one.
 *
 * @param {object} [config]
 * @param {string} [config.connection] - encrypted blob; omit to resolve from env
 * @param {string} [config.name]       - database name; omit to read EMAIL_DB_NAME
 */
function ready(config) {
  if (_ready) return _ready;
  config = config || {};

  _ready = (async function() {
    var encrypted = config.connection || resolveDbConnection(CONN_VAR);
    var name = config.name || dbName();

    // ensureDatabase needs the decrypted login — it connects to the
    // maintenance database to issue CREATE DATABASE.
    var login = JSON.parse(await decrypt(encrypted, process.env.ENCRYPTION_KEY));
    var ensured = await ensureDatabase(login, name);
    if (ensured.created) console.log('[email] created database ' + name);

    // XEPLR_EMAIL_MIGRATIONS — an app seeds ITS OWN templates from its own
    // migrations directory, without that file ever living in this package.
    // The same convention every xeplr library uses (XEPLR_<APP>_MIGRATIONS,
    // see @xeplr/db's app-migrations.js), so configuring it here is the same
    // act as configuring it for auth.
    //
    // This is the natural home for app-specific templates: a registration
    // mail belongs to one product's wording and branding, so it belongs in
    // that product's migrations, not in a store this package ships.
    var migrated = await sqlMigrator.up({
      db: name,
      dir: path.join(__dirname, '..', 'migrations'),
      extDir: migrationsFor('email'),
      type: 'precede',
      connectionName: 'email',
      connection: encrypted
    });
    if (migrated.migrations.length) {
      console.log('[email] ran ' + migrated.migrations.length + ' migrations');
    }

    // bind:false — a SECONDARY connection. @xeplr/db's bindModels touches
    // Objection's base class, so binding globally would re-point the HOST
    // app's models at the email database. Same reasoning as
    // xeplr-workflow/backend/lib/db.js, and the same bug if ignored.
    _conn = await getConnection(name, encrypted, { bind: false, connectionName: 'email' });
    bindModels(_conn, [EmailTemplate]);
    return _conn;
  })();

  return _ready;
}

/** The bound model. Throws if ready() has not been awaited — a clearer failure
 *  than an unbound query erroring somewhere inside Objection. */
function model() {
  if (!_conn) throw new Error('email: templates are not initialised — await require("@xeplr/email").initTemplates() first.');
  return EmailTemplate;
}

function isInitialised() { return Boolean(_conn); }

module.exports = { ready: ready, model: model, isInitialised: isInitialised, dbName: dbName, CONN_VAR: CONN_VAR };
