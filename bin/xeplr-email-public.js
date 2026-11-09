#!/usr/bin/env node

// THE PUBLIC EMAIL SERVICE — `npx xeplr-email-public --config forms.json`.
//
//   --config <file>   the forms (required): { "forms": { "<key>": { to, subject, fields, … } } }
//   --port <n>        default EMAIL_PUBLIC_PORT, then 19008
//   --host <addr>     default EMAIL_PUBLIC_HOST, then 127.0.0.1 (nginx on this machine only)
//   --trust-proxy     behind nginx: read the visitor's address from X-Real-IP
//   --dry-run         log each mail instead of sending it (local testing)
//
// The provider comes from the environment, as for the internal service:
// EMAIL_PROVIDER and its settings (SMTP_* / BREVO_* …). This bin loads no
// .env file of its own — the launcher provides it, e.g.
//   dotenv -e public.env -- xeplr-email-public --config forms.json

var fs = require('fs');
var path = require('path');

var args = process.argv.slice(2);
function flag(name) { return args.indexOf(name) !== -1; }
function value(name) { var i = args.indexOf(name); return i === -1 ? null : args[i + 1]; }

if (flag('-h') || flag('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map(function(l) { return l.replace(/^\/\/ ?/, ''); }).join('\n'));
  process.exit(0);
}

var file = value('--config');
if (!file) {
  console.error('\n[email-public] --config <forms.json> is required — it is what this service may send.\n');
  process.exit(2);
}

var config;
try {
  config = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
} catch (err) {
  console.error('\n[email-public] could not read ' + file + ': ' + err.message + '\n');
  process.exit(1);
}

try {
  require('../index').startPublic(Object.assign({}, config, {
    port: value('--port') || config.port,
    host: value('--host') || config.host,
    trustProxy: flag('--trust-proxy') || config.trustProxy,
    dryRun: flag('--dry-run')
  }));
} catch (err) {
  console.error('\n[email-public] ' + err.message + '\n');
  process.exit(1);
}
