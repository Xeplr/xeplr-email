// NOTE: `send` is required LAZILY inside handler() — index.js requires this file,
// so requiring it back at load time is a circular dependency (index's exports
// aren't ready yet). At call time they are.

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handler(req, res) {
  var url = req.url;
  var method = req.method;

  try {
    // Health check: GET /
    if (method === 'GET' && url === '/') {
      return json(res, 200, { service: 'email', status: 'running' });
    }

    // Send email: POST /internal/send
    if (method === 'POST' && url === '/internal/send') {
      var body = await parseBody(req);

      if (!body.to || !body.subject || !body.html) {
        return json(res, 400, { error: 'to, subject, and html are required' });
      }

      var email = require('../index');   // lazy: index has fully loaded by now
      // The allowed body pattern, when one is configured (lib/controlling.js).
      // Throws a 403 naming the field that does not fit.
      require('./controlling').check(body, email.getAllowRules());

      await email.send(body.to, body.subject, body.html, body.cc, body.attachments);
      return json(res, 200, { success: true });
    }

    // Not found
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    // A 403 from controlling carries its status and the refused field;
    // a body that is not JSON is the caller's mistake; anything else is ours.
    if (err.status === 403 && err.field) return json(res, 403, { error: err.message, field: err.field });
    if (err instanceof SyntaxError) return json(res, 400, { error: 'body must be JSON' });
    json(res, 500, { error: err.message });
  }
}

module.exports = handler;
