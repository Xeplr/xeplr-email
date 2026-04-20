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
  }
});
```

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
| SMTP     | `smtp`    | host, port, user, pass, from |
| AWS SES  | `aws`     | region, accessKeyId, secretAccessKey, from |
| Azure    | `azure`   | connectionString, from |
| Brevo    | `brevo`   | apiKey, fromEmail, fromName |

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

When `testTo` is configured (or `EMAIL_TEST_TO` env var), a test email is sent on startup. Check health with:

```js
email.isHealthy(); // true if test email was sent successfully
```
