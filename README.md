# @xeplr/email

**Send email through SMTP, AWS SES, Azure or Brevo — in-process, over a small HTTP endpoint, or from stored templates.** A wrapper around `@xeplr/utils`' email providers that adds an optional send queue, a startup health check, env-driven configuration, and a template store with its own database.

```js
var email = require('@xeplr/email')

email.configureFromEnv()                                   // EMAIL_PROVIDER + that provider's vars
await email.send(['ada@example.com'], 'Hello', '<p>Hi Ada</p>')
```

## How the pieces fit

| what | where |
|---|---|
| Choosing and configuring the provider | `init(config)` or `configureFromEnv()` |
| Sending | `send(to, subject, html, cc, attachments)` — the actual delivery is `@xeplr/utils`' `sendEmail` |
| A standalone service other processes post to | `start(config)` → `POST /internal/send` |
| Named, reusable messages with `{{variables}}` | the template store: `initTemplates()`, `renderTemplate()`, `sendTemplate()`, `templatesRouter()` |
| Template rows | `email_templates`, in the database named by `EMAIL_DB_NAME` |

Sending needs no database. Only an app that calls `initTemplates()` needs one.

## Install

```sh
npm i @xeplr/email
```

Depends on `@xeplr/utils`, `@xeplr/base-apis` and `@xeplr/db`. The provider SDK is loaded only when that provider sends, so install the one you use:

| provider | install |
|---|---|
| `smtp` | `nodemailer` |
| `aws` | `@aws-sdk/client-sesv2` (or `@aws-sdk/client-ses`) and `nodemailer` |
| `azure` | `@azure/communication-email` |
| `brevo` | nothing — uses `fetch` |

`templatesRouter()` requires `express`.

## Exports

| export | does |
|---|---|
| `init(config)` | Configure the provider (when `config.provider` is set), the optional queue, and the health check |
| `configureFromEnv()` | Build the config from the environment and run it through `init`. Returns `false` (and does nothing) when `EMAIL_PROVIDER` is unset |
| `send(to, subject, html, cc?, attachments?)` | Send now (returns the provider's promise), or enqueue when `useQueue` (returns nothing) |
| `isHealthy()` | `true` once the startup test mail succeeded |
| `start(config)` | `init(config)`, then a plain Node HTTP server on `config.port` → `EMAIL_PORT` → `19007`. Returns the `http.Server` |
| `requiredEnv` | Getter: `['EMAIL_PROVIDER', …the provider's required vars]`, read when accessed |
| `templatesRequiredEnv` | `['EMAIL_DB_NAME']` |
| `initTemplates(config?)` | Create, migrate and connect the template store. Returns the templates module |
| `templatesRouter({ auth })` | Express router for template CRUD and preview |
| `renderTemplate(name, variables, opts?)` | `{ templateName, subject, html, text }` |
| `sendTemplate(name, to, variables, opts?)` | Render, then `send` — `opts.cc`, `opts.attachments`, `opts.strict` |
| `templatesReady()` | `true` once the store is connected |

## Sending

```js
email.init({
  provider: 'smtp',                 // 'smtp' | 'aws' | 'azure' | 'brevo'
  smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', from: 'app@example.com' },
  useQueue: true,                   // optional
  testTo: 'ops@example.com'         // optional: mail this address on startup
})

email.send(['ada@example.com'], 'Report', '<p>Attached.</p>', ['boss@example.com'], ['/tmp/report.pdf'])
```

| parameter | type | |
|---|---|---|
| `to` | `string[]` | recipients |
| `subject` | `string` | |
| `html` | `string` | body |
| `cc` | `string[]` | optional |
| `attachments` | `string[]` | optional — **file paths**, read from disk and attached under their base name |

### Providers

| `provider` | config key | fields |
|---|---|---|
| `smtp` | `smtp` | `host`, `user`, `pass`, `from`; `port` defaults to 587; plus the optional transport settings below |
| `aws` | `aws` | `region`, `accessKeyId`, `secretAccessKey`, `from` |
| `azure` | `azure` | `connectionString`, `from` |
| `brevo` | `brevo` | `apiKey`, `fromEmail`, `fromName` |

When `init` is called without a `provider`, `@xeplr/utils` reads the provider and its settings from the environment at send time (`EMAIL_PROVIDER`, default `smtp`; `SMTP_*`, `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SES_FROM`, `AZURE_COMMUNICATION_CONNECTION_STRING` / `AZURE_EMAIL_FROM`, `BREVO_*`).

### Queue

With `useQueue: true`, `send` adds the mail to an in-memory queue and returns immediately:

| option | default | |
|---|---|---|
| `flushIntervalInSeconds` | `5` | how often this package's queue flushes, one mail at a time, in order |
| `maxEmptyTicks` | `3` | pause after this many empty flushes; resumes when a mail is added |

The whole `config` is also passed to `@xeplr/utils`' `configureEmail`, which with `useQueue` keeps its own retry queue: a failed send is retried up to `maxRetries` (3) times every `retryIntervalInSeconds` (60), then moved to a dead-letter queue. `store` (`'memory'`), `redisKey` and `deadLetterKey` are passed through to it.

### Health check

When `testTo` (or `EMAIL_TEST_TO`) is set, `init` sends a test mail. `isHealthy()` becomes `true` when that send resolves; a failure prints

```
[email] health check FAILED — could not send test mail to ops@example.com: <reason>
```

`init` does not wait for it, so read `isHealthy()` on a later tick. With `useQueue`, the send resolves once the mail is queued.

## Configuring from the environment

```js
require('@xeplr/email').configureFromEnv()
```

It reads `EMAIL_PROVIDER` and builds a config for **`smtp`** or **`brevo`** from their variables; any other provider gets `{ provider }` only, and its settings are read from the environment at send time (see Providers).

Spread `requiredEnv` into the app's `env.required.js` so a missing value fails `checkEnv` at startup. **The list follows the provider** — an install on SMTP is never asked for a Brevo key:

| `EMAIL_PROVIDER` | also required |
|---|---|
| `smtp` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| `brevo` | `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` |
| anything else | nothing more |

It is a getter, read when accessed rather than when the module loads, so the app only has to load its `.env` first.

### SMTP

Unset optional values are left **out of the transport**, so nodemailer's own defaults apply.

| variable | |
|---|---|
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | required (`SMTP_FROM` is the `From` header) |
| `SMTP_PORT` | default 587. 465 = implicit TLS, 587 / 25 = STARTTLS |
| `SMTP_SECURE` | override the TLS mode otherwise derived from the port |
| `SMTP_REQUIRE_TLS` | refuse to send if STARTTLS is unavailable |
| `SMTP_IGNORE_TLS` | plaintext relay (internal only) |
| `SMTP_NAME` | EHLO/HELO hostname; some servers reject the default |
| `SMTP_AUTH_METHOD` | `LOGIN`, `PLAIN`, `CRAM-MD5`, … |
| `SMTP_CONNECTION_TIMEOUT`, `SMTP_GREETING_TIMEOUT`, `SMTP_SOCKET_TIMEOUT` | ms |
| `SMTP_POOL`, `SMTP_MAX_CONNECTIONS`, `SMTP_MAX_MESSAGES` | connection pooling |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `false` for a self-signed or internal CA |
| `SMTP_TLS_SERVERNAME` | SNI, when it differs from `SMTP_HOST` |
| `SMTP_DEBUG` | nodemailer protocol log |
| `SMTP_OPTIONS` | a JSON object of any other nodemailer transport options |

`secure` is derived from the port when not stated, because the wrong pairing fails as a hang rather than an error.

`SMTP_OPTIONS` is the way in for whatever one server needs that has no named variable:

```
SMTP_OPTIONS={"dkim":{"domainName":"example.com","keySelector":"mail","privateKey":"-----BEGIN..."}}
SMTP_OPTIONS={"proxy":"socks5://127.0.0.1:1080"}
```

- **Merged last, so it overrides the named variables.**
- **`tls` is merged one level deeper, not replaced** — dropping `SMTP_TLS_*` because a `tls` block was also given would be a silent downgrade.
- **Invalid JSON, or anything but an object, fails the boot** — ignoring it would drop the one option the server needed.
- Contents go to nodemailer unvalidated; a misspelt key is silently ignored by nodemailer. `SMTP_DEBUG=true` shows what happened on the wire.

## HTTP server

```js
require('@xeplr/email').start({ port: 19007, provider: 'smtp', smtp: { … } })
```

| route | does |
|---|---|
| `GET /` | `{ service: 'email', status: 'running' }` |
| `POST /internal/send` | JSON `{ to, subject, html, cc?, attachments? }` → `send(…)` → `{ success: true }`. 400 if `to`, `subject` or `html` is missing; 500 `{ error }` if the send throws |
| anything else | 404 |

There is **no authentication** on this server. It is meant for an internal network only.

**Currently broken:** `index.js` takes the server factory as `require('@xeplr/base-apis').http`, but `@xeplr/base-apis` 2.x exports it as `createHttpServer`, so `start()` throws `TypeError` (reading `init` of `undefined`). Until that is fixed, mount `lib/emailHandler.js` in your own server, or call `require('@xeplr/base-apis').createHttpServer.init(port, 'xeplr-email', require('@xeplr/email/lib/emailHandler'))` after `init(config)`.

## Templates

```js
await email.initTemplates()                                        // EMAIL_DB_NAME, XEPLR_DB_CONNECTION
app.use('/api', email.templatesRouter({ auth: requireAdmin }))

await email.sendTemplate('User Registration', ['ada@example.com'], { firstName: 'Ada', link })
```

### The store

`initTemplates({ connection?, name? })`, memoised:

1. connection: `config.connection` (encrypted), else `EMAIL_DB_CONNECTION_INFO_ENCRYPTED`, else `XEPLR_DB_CONNECTION`; decrypted with `ENCRYPTION_KEY`
2. database: `config.name`, else **`EMAIL_DB_NAME` — required, no default**
3. creates the database if missing (needs a login with `CREATEDB`)
4. runs this package's `migrations/` then `XEPLR_EMAIL_MIGRATIONS` through `@xeplr/db`'s `sqlMigrator` under the connection name `email` (see [Limitations](#limitations-in-the-current-code))
5. connects the `EmailTemplate` model

Why the database name has no default: **templates are app-specific.** A registration mail is one product's wording and branding; a shared `xeplr_email` would have two products overwriting each other's template of the same name. One store per app (`xeplr_bi_email`), and an app seeds its own templates from its own migrations via `XEPLR_EMAIL_MIGRATIONS`.

`email_templates`: `id`, `name` (unique among active rows — a soft-deleted template never blocks its replacement), `description`, `subject` (required), `html`, `text`, `variables` (`[{ name, description, required }]`), `isActive`, audit columns.

### Rendering

- **Variables are `{{name}}`** (whitespace inside the braces allowed). Single-brace `{token}` is left alone: the workflow engine resolves `{params.x}` in a step's inputs first, and single-brace bodies would have it resolving the template's own placeholders.
- A missing value renders as empty; an object renders as JSON.
- **`strict` defaults to `true`**: a required declared variable that is missing, `null` or `''` throws `EMAIL_TEMPLATE_MISSING_VARS` — half-rendered mail cannot be recalled. No active template of that name throws `EMAIL_TEMPLATE_NOT_FOUND`.
- Templates are looked up **by name**, not id — a name reads in a diff and is the same in every environment.

### Routes

`templatesRouter({ auth })` — `auth` is middleware run before every route. **Omitted, the routes are open**: fine locally, wrong for anything reachable, since whoever can edit a template changes what the install sends to customers.

| route | does |
|---|---|
| `GET /email-templates` | active templates, one per name, each with `variables` (declared ones, then `{{tokens}}` used but not declared, flagged `declared: false` so a typo shows) |
| `GET /email-templates/:name` | one template; 404 if none |
| `POST /email-templates/save` | `{ id?, name, subject, html?, text?, description?, variables? }` → `{ updatedIds }`; 400 without `name` and `subject` |
| `POST /email-templates/delete` | `{ ids }` → soft delete |
| `POST /email-templates/:name/preview` | `{ variables }` → the rendered `{ subject, html, text }`, **not sent**, with `strict: false` |

### Limitations in the current code

- **Call `resolveConfig('email', <encrypted login>)` from `@xeplr/db` before `initTemplates()`.** The migration step looks up a login resolved under the name `email`, and `initTemplates` does not resolve one itself, so without that call it throws `No resolved config for "EMAIL"`.
- The store connection is opened with `bind: false`, but `EmailTemplate` is then bound with `@xeplr/db`'s `bindModels`, which sets the knex of Objection's base `Model` — every model in the process, not only `EmailTemplate`. In an app with its own models, those models then point at the template database.
- `lib/templates.js` resolves the list, `get` and new rows by `mtId1` / `mtId2` (the tenant's own template, then the company's, then `'*'`), but this package's migration does not create those columns. Until an app migration adds them, the list, get and save routes fail; `renderTemplate` / `sendTemplate` look up by name only and work.
- `lib/htmlSafety.js` (`sanitize`, `inspect` for Outlook-unsafe markup) is present but not exported or called by the routes.

## Environment

| variable | needed for |
|---|---|
| `EMAIL_PROVIDER` | `configureFromEnv`, `requiredEnv` |
| provider variables | see Providers and SMTP |
| `EMAIL_TEST_TO` | startup health mail |
| `EMAIL_PORT` | `start()` port (default `19007`) |
| `EMAIL_DB_NAME` | templates — required |
| `XEPLR_DB_CONNECTION` or `EMAIL_DB_CONNECTION_INFO_ENCRYPTED` | templates — the encrypted login; the second wins |
| `ENCRYPTION_KEY` | templates — decrypting the login |
| `XEPLR_EMAIL_MIGRATIONS` | templates — an app's own migration directories, comma-separated |

## Tests

```sh
npm test
```

Template rendering without a database: `{{token}}` substitution, single braces left alone, missing values, token discovery, undeclared variables.

## License

MIT
