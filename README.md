# xeplr-email

Email service with multi-provider support, optional queue, CC, and file attachments.

## Setup

```js
var email = require('xeplr-email');

email.init({
  provider: 'smtp',          // 'smtp', 'aws', 'azure', or 'brevo'
  testTo: 'admin@example.com', // send test email on startup to verify health
  useQueue: true,             // optional: queue emails instead of sending immediately
  flushIntervalInSeconds: 5,  // queue flush interval (default: 5)
  maxEmptyTicks: 3,           // auto-pause after N empty ticks (default: 3)
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    user: 'user',
    pass: 'pass',
    from: 'app@example.com'
    // plus any of the optional SMTP settings, and `options` for anything not
    // named — see "Configuring from the environment" below
  }
});
```

Most apps do not write this literal: they call `configureFromEnv()` and keep
the values in their own `.env`. See
[Configuring from the environment](#configuring-from-the-environment).

## Usage

### send(to, subject, html, cc, attachments)

| Parameter   | Type       | Required | Description |
|-------------|------------|----------|-------------|
| to          | string[]   | yes      | Recipient emails |
| subject     | string     | yes      | Email subject |
| html        | string     | yes      | HTML body |
| cc          | string[]   | no       | CC recipients |
| attachments | string[]   | no       | File paths to attach |

### Send a simple email

```js
var email = require('xeplr-email');

email.send(['user@example.com'], 'Hello', '<p>Hi there</p>');
```

### Multiple recipients

```js
email.send(
  ['user@example.com', 'other@example.com'],
  'Hello',
  '<p>Hi there</p>'
);
```

### With CC

```js
email.send(
  ['user@example.com'],
  'Hello',
  '<p>Hi there</p>',
  ['manager@example.com', 'team@example.com']
);
```

### With attachments

Attachments are file paths — they get picked up and attached automatically.

```js
email.send(
  ['user@example.com'],
  'Report',
  '<p>See attached report.</p>',
  [],                                       // cc (empty)
  ['/tmp/report.pdf', '/tmp/data.csv']      // attachments
);
```

### With CC and attachments

```js
email.send(
  ['user@example.com'],
  'Report',
  '<p>See attached.</p>',
  ['boss@example.com'],
  ['/tmp/report.pdf']
);
```

### Via HTTP API

Start as standalone server:

```js
var email = require('xeplr-email');
email.start({ provider: 'smtp', useQueue: true, smtp: { ... } });
```

Then send via HTTP:

```
POST /internal/send
Content-Type: application/json

{
  "to": ["user@example.com"],
  "subject": "Hello",
  "html": "<p>Hi</p>",
  "cc": ["other@example.com"],
  "attachments": ["/tmp/report.pdf"]
}
```

## Providers

| Provider | Config key | Required fields |
|----------|-----------|----------------|
| SMTP     | `smtp`    | host, user, pass, from (port defaults to 587) |
| AWS SES  | `aws`     | region, accessKeyId, secretAccessKey, from |
| Azure    | `azure`   | connectionString, from |
| Brevo    | `brevo`   | apiKey, fromEmail, fromName |

## Configuring from the environment

Apps call `configureFromEnv()` once at boot rather than passing a config
literal. It reads `EMAIL_PROVIDER` plus that provider's vars, and returns
`false` if `EMAIL_PROVIDER` is unset.

```js
require('@xeplr/email').configureFromEnv();
```

Spread `requiredEnv` into the app's `env.required.js` so a missing value fails
`checkEnv` at startup. **The list follows the provider** — an install running
on SMTP is never asked for a Brevo key, and vice versa:

| `EMAIL_PROVIDER` | also required |
|------------------|---------------|
| `smtp`           | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| `brevo`          | `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` |

It is read when `requiredEnv` is accessed, not when this module loads, so the
app's `.env` only has to be loaded first.

### SMTP

Four vars are required. Everything else is optional and, when unset, is left
**out of the transport entirely** so nodemailer's own defaults apply.

| Var | Description |
|-----|-------------|
| `SMTP_HOST` | required |
| `SMTP_USER` | required |
| `SMTP_PASS` | required |
| `SMTP_FROM` | required — header `From` |
| `SMTP_PORT` | default 587. 465 = implicit TLS, 587/25 = STARTTLS |
| `SMTP_SECURE` | override the TLS mode otherwise derived from the port |
| `SMTP_REQUIRE_TLS` | refuse to send if STARTTLS is unavailable |
| `SMTP_IGNORE_TLS` | plaintext relay (internal only) |
| `SMTP_NAME` | EHLO/HELO hostname; some servers reject the default |
| `SMTP_AUTH_METHOD` | `LOGIN`, `PLAIN`, `CRAM-MD5`, … |
| `SMTP_CONNECTION_TIMEOUT` | ms |
| `SMTP_GREETING_TIMEOUT` | ms |
| `SMTP_SOCKET_TIMEOUT` | ms |
| `SMTP_POOL` | reuse connections across sends |
| `SMTP_MAX_CONNECTIONS` | with `SMTP_POOL` |
| `SMTP_MAX_MESSAGES` | with `SMTP_POOL` |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `false` for self-signed / internal CA |
| `SMTP_TLS_SERVERNAME` | SNI, when it differs from `SMTP_HOST` |
| `SMTP_DEBUG` | nodemailer protocol log |
| `SMTP_OPTIONS` | anything not named above — see below |

`secure` is derived from the port when not stated: 465 is implicit TLS from
the first byte, 587 and 25 start in the clear and negotiate STARTTLS. The
wrong pairing fails as a hang rather than as a message, which is why it is
inferred rather than defaulted to one value.

### SMTP_OPTIONS — anything not named above

A JSON **object** of nodemailer transport options, merged last. This is the
way in for whatever one particular server needs that this library has no name
for, so no server is unreachable without editing the library:

```
SMTP_OPTIONS={"dkim":{"domainName":"xeplr.com","keySelector":"mail","privateKey":"-----BEGIN..."}}
SMTP_OPTIONS={"proxy":"socks5://127.0.0.1:1080"}
SMTP_OPTIONS={"tls":{"ciphers":"TLSv1.2","minVersion":"TLSv1.2"}}
```

- **Merged last, so it overrides the named vars.** If `SMTP_PORT` and an
  `options.port` disagree, the JSON wins.
- **`tls` is merged one level deeper, not replaced.** A `tls` block here and
  the `SMTP_TLS_*` vars are two ways of saying the same thing; swapping one
  for the other would be a silent TLS downgrade.
- **Invalid JSON fails the boot** rather than being ignored. A typo would
  otherwise drop the one option the server needed and surface later as a
  refused connection — or as an unencrypted send that looked fine.
- Contents are passed to nodemailer **unvalidated** — that is what makes it
  open-ended. A misspelled key here is silently ignored by nodemailer, unlike
  the named vars. `SMTP_DEBUG=true` shows what actually happened on the wire.

The `email-send` action takes the same option names on its connection object,
including `options`, so one SMTP server is described identically whether it is
configured on a workflow step or in an install's env.

## Queue behavior

When `useQueue: true`:

- Emails are queued in memory, not sent immediately
- Queue flushes every `flushIntervalInSeconds` (default: 5s)
- Emails are sent one at a time, in order
- Queue auto-pauses after `maxEmptyTicks` consecutive empty flushes
- Queue auto-resumes when a new email is added

When `useQueue: false` (default):

- Emails are sent immediately and `send()` returns a promise

## Health check

When `testTo` is configured (or the `EMAIL_TEST_TO` env var), a test email is
sent on startup. Check health with:

```js
email.isHealthy(); // true if test email was sent successfully
```

A failed send prints the provider's own error and leaves `isHealthy()` false:

```
[email] health check FAILED — could not send test mail to admin@example.com: <reason>
```

The send is not awaited by `init()`, so `isHealthy()` is still `false` for as
long as the round-trip takes. Read it on a later tick, not on the line after
`init()`.
