const { send } = require('../index');

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

      await send(body.to, body.subject, body.html, body.cc, body.attachments);
      return json(res, 200, { success: true });
    }

    // Not found
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

module.exports = handler;
