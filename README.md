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
| `getAllowRules()` | the compiled body rules `/internal/send` checks, or `null` when off |
| `controlling` | `compileRules(allow)`, `check(body, rules)`, `fromEnv()` — the same checks, for use in-process |
| `startPublic(config)` | The public forms service: forms from config, never a recipient or HTML from a request (see Public forms). Returns the `http.Server` |
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
| `POST /internal/send` | JSON `{ to, subject, html, cc?, attachments? }` → `send(…)` → `{ success: true }`. 400 if `to`, `subject` or `html` is missing, or the body is not JSON; 403 `{ error, field }` if it does not match the allowed pattern (below); 500 `{ error }` if the send throws |
| anything else | 404 |

There is **no authentication** on this server, by design: internal services call it unconditionally. It is meant for an internal network only.

### Allowed body pattern

What the server will send can be pinned down instead (`lib/controlling.js`). Give `init` / `start` an `allow` object, or set `EMAIL_ALLOW` to the same thing as JSON:

```js
email.start({ port: 19007, provider: 'smtp', smtp: { … }, allow: { to: ['admin@xeplr.com'], cc: false, attachments: false } })
```

```
EMAIL_ALLOW={"to":["admin@xeplr.com"],"cc":false,"attachments":false}
```

Now a send to anyone but `admin@xeplr.com`, or with a cc or an attachment, is answered `403 { error, field: 'to' }` and never reaches the provider. Unset, every send is accepted as before.

| rule | allows |
|---|---|
| `'admin@xeplr.com'` | exactly that (addresses compare case-insensitively) |
| `'*@xeplr.com'` | `*` is any run of characters |
| `'/^Report \\d+$/i'` | a regular expression, as a string (for JSON) |
| `/^Report \d+$/i`, `function (v) { … }` | from code; a function allows on `true` |
| `[a, b]` | any one of them |
| `false` or `[]` | the field must be absent or empty |

- Fields: `to`, `cc`, `subject`, `html`, `attachments`. A field with no rule is not checked.
- For `to`, `cc` and `attachments`, **every** entry must match. One stray recipient refuses the whole send rather than being dropped.
- Once any rule is set, a body field that is not one of those five (a `bcc`, say) is refused, so nothing rides along unchecked.
- A rule naming an unknown field, a malformed rule, or invalid `EMAIL_ALLOW` JSON fails at `init`, not at the first send.
- The rules apply to the HTTP endpoint only. In-process `send()` is not checked; call `controlling.check(body, rules)` yourself if you want the same rules there.

## Public forms (for websites)

**A second service, for forms on web pages.** The HTTP server above takes `to` and `html` from whoever calls it, so it must never be reachable from outside. Websites use this one instead. It never takes a recipient, a subject or HTML from a request: only a form's **key** and its **field values**. Who the mail goes to, its subject and which fields exist are config on the server.

```sh
npx xeplr-email-public --config forms.json --trust-proxy      # EMAIL_PROVIDER + its settings from the environment
npx xeplr-email-public --config forms.json --dry-run          # local: log each mail instead of sending it
```

Or from code: `require('@xeplr/email').startPublic({ forms, port, trustProxy })`. Port: `--port`, then `EMAIL_PUBLIC_PORT`, then `19008`. Run it as its own process, ideally with its own sending account, so abuse of a public form cannot hurt the reputation your password resets go out under.

### forms.json

```json
{
  "forms": {
    "demo": {
      "to": "demo@xeplr.com",
      "subject": "Demo request from {{name}}",
      "origins": ["https://xeplr.com"],
      "fields": [
        { "key": "name",    "label": "Your name",  "type": "text",  "required": true },
        { "key": "email",   "label": "Work email", "type": "email", "required": true },
        { "key": "sources", "label": "Data lives in", "type": "select", "options": ["Postgres", "SQL Server"] },
        { "key": "message", "label": "Message", "type": "multiline", "maxLength": 4000 }
      ],
      "limits": { "perIpPerHour": 5, "perDay": 200 },
      "redirect": "https://xeplr.com/thanks",
      "submitLabel": "Send",
      "sentMessage": "Thank you — we will be in touch."
    }
  }
}
```

| setting | |
|---|---|
| `to` | **Required.** One address or a list. Never sent to a browser |
| `subject` | `{{key}}` is filled from the values; line breaks are removed |
| `fields` | `key` (letters, digits, `_`), `label`, `type` (`text`, `email`, `tel`, `multiline`, `select` with `options`), `required`, `maxLength` (defaults: text 200, email 254, multiline 5000), `placeholder`, `help` |
| `origins` | Sites allowed to use the form (`https://host`, or `*`). Empty: any |
| `limits` | `perIpPerHour` (default 5) and `perDay` per form (default 200): sends, not attempts |
| `redirect`, `redirectError` | Where a form posted **without JavaScript** goes. From config only, never the request |
| `token` | `true` (default): every send must carry a form token (below). Set `false` only for a form posted with no JavaScript, which cannot fetch one |
| `captcha` | `{ "turnstile": { "siteKey": "…", "secretEnv": "TURNSTILE_SECRET" } }`: Cloudflare Turnstile, checked on the server |
| `title`, `submitLabel`, `sentMessage` | Shown in the mail and on the form |

Every form is checked when the service starts. A missing `to`, a duplicate key or an unknown type stops the boot with the problem named.

### What it does with a request

| | |
|---|---|
| `GET /public/v1/forms/:key` | The form's fields and labels, for drawing it. Never `to`, limits or secrets |
| `GET /public/v1/token/:key` | A single-use token for one send: `{ token, required, expiresIn, minWait }` |
| `POST /public/v1/send/:key` | JSON, or a plain HTML form post. `200 { success, message }`; a form post gets the `redirect` or a small thank-you page |
| `GET /embed.js`, `/embed.min.js` | The browser script |
| `GET /health` | `{ status: 'ok' }` |

Before anything reaches the provider:

- **Request size:** over **10 KB** is refused with **413**, by `Content-Length` before reading and by counting while reading (`maxBodyBytes`).
- **Origin:** a browser on a site not in `origins` gets **403**.
- **Request ceiling:** at most 60 requests an hour per address, valid or not.
- **Fields:** a key the form does not define (`to`, `html`, a typo) is **400**, naming it. Values must be text within `maxLength`; an email must look like one; a select must be one of its options.
- **Honeypot:** a filled `_hp` field gets a normal-looking success, and nothing is sent.
- **Form token:** the send must carry `_token`, or it is **403** with `{ token: "<reason>" }`. See *Form tokens* below.
- **Captcha:** when the form has one.
- **Limits:** **429** with `Retry-After`. Counted only once a mail has gone, so a provider outage uses up nobody's sends.
- **The mail is built here.** Every value is HTML-escaped into a table; the subject is one line.
- **Provider errors stay in the log.** The visitor gets a **502** without the provider's words, which can name the account.

**Behind nginx, pass `--trust-proxy` and set `X-Real-IP`**, or every visitor shares nginx's address and one limit:

```nginx
limit_req_zone $binary_remote_addr zone=forms:10m rate=20r/m;
server {
  server_name forms.example.com;
  location / {
    limit_req zone=forms burst=10 nodelay;     # the shared outer layer — the service's own limits are per process
    client_max_body_size 16k;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_pass http://127.0.0.1:19008;
  }
}
```

### Form tokens

A public form has no user to sign in, so a token cannot prove who is sending: anything a visitor's browser can fetch, a script can fetch too. What it does is make every send cost a round trip and a wait, and stop any send being repeated.

- **One form, one visitor.** `GET /public/v1/token/:key` issues a token signed by the service, for that form and the caller's address. A different form or address is refused.
- **Single use.** A used token is refused, so a captured send cannot be replayed. It is used up even when a field needs correcting; the embed script fetches the next one.
- **Not too soon.** A send under `minSeconds` (3) after its token was issued is refused. People do not fill a form in that time; scripts do.
- **Not too late.** A token lasts `ttlSeconds` (an hour). The embed script renews it for a page left open.
- **Not stockpiled.** At most `perIpPerHour` (30) tokens per address, across all forms.

The embed script does all of this itself: nothing to add to your HTML. Sending from code, call `XeplrForms.prepare('demo')` when the form appears, so the visitor's typing covers the wait; without it, `send()` fetches a token and waits the minimum first.

Set them in `forms.json` beside `forms`, if the defaults do not suit:

```json
{ "tokens": { "ttlSeconds": 3600, "minSeconds": 3, "perIpPerHour": 30 }, "forms": { … } }
```

Tokens are signed with `EMAIL_PUBLIC_TOKEN_SECRET`. Unset, the service makes a new secret each time it starts: every older token stops working and the embed script fetches a new one, so a visitor mid-form is asked to send again at worst. Used tokens are remembered in memory until they expire, as the send limits are, so behind several processes each remembers its own.

### The browser script

One `<script>`, no build and no framework. From jsDelivr, which serves every published version of this package:

```html
<script src="https://cdn.jsdelivr.net/npm/@xeplr/email@1/embed/embed.min.js" async></script>
```

Or from the service itself (`https://forms.example.com/embed.min.js`). That is the one to use behind a strict Content-Security-Policy: allow your forms origin only, not a public CDN, which would let an injected script load any npm package.

| you want | you write |
|---|---|
| A ready-made form, drawn from the config | `<div data-xeplr-form="demo" data-endpoint="https://forms.example.com"></div>` |
| **Your own form, as designed** | `<form data-xeplr-form="demo" data-endpoint="…">` with inputs whose `name`s are the form's field keys |
| To send from code (React, anything) | `XeplrForms.prepare('demo', { endpoint })` when the form appears, then `XeplrForms.send('demo', { name, email }, { endpoint })` → a Promise |
| No JavaScript at all | `<form action="https://forms.example.com/public/v1/send/demo" method="post">`, and `"token": false` on that form, since a page with no script cannot fetch one |

**With your own form, it draws nothing.** It takes over the submit, runs the browser's own checks (`required`, `type="email"`), sends, and then:

- sets `data-xeplr-state="sending" | "sent" | "error"` on the `<form>`, for your CSS
- writes the outcome into `[data-xeplr-message]`, and a field's problem into `[data-xeplr-error="<key>"]` with `aria-invalid` on the input
- fires `xeplr:sent` and `xeplr:error` (with `detail.status`, `detail.fields`). Call `preventDefault()` to show your own message instead.

**To add a field,** add the input to your HTML and the field to the form's config. A field the config does not define is refused, by name, rather than silently dropped.

**The ready-made form** is drawn in a shadow root, so the page's CSS cannot break it. Restyle it from outside with CSS variables on the element: `--xf-accent`, `--xf-text`, `--xf-border`, `--xf-radius`, `--xf-input-bg`, `--xf-error`, `--xf-success`, `--xf-gap`, `--xf-max-width`.

`data-endpoint` can sit on the `<script>` tag instead, for every form on the page; served by the service itself, the script needs none. Forms added after the page loads, such as by React or in a modal, are found on their own, or call `XeplrForms.mount(element)`.

After changing `embed/embed.js`, run `npm run build:embed`. A test fails the release while `embed.min.js` is stale.

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
| `EMAIL_ALLOW` | optional: the body pattern `/internal/send` accepts, as JSON (see Allowed body pattern) |
| `EMAIL_PUBLIC_PORT` | `startPublic()` port (default `19008`) |
| `EMAIL_PUBLIC_HOST` | `startPublic()` address (default `127.0.0.1`, so only nginx on the same machine reaches it) |
| `EMAIL_PUBLIC_TOKEN_SECRET` | optional: signs form tokens. Unset, a new secret each start |
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
