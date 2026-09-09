// HTTP surface for the template store, mountable into any host that already
// has auth — it takes the gate rather than assuming one, the same shape
// @xeplr/jobs' router uses.
//
// Deliberately NOT ungated by default: a template body is the text this
// install sends to customers, so anyone who can PATCH one can change what
// every product here says. `config.auth` omitted leaves it open, which is
// fine for local development and wrong for anything reachable.

var express = require('express');
var templates = require('./templates');

function noop(req, res, next) { next(); }

function buildTemplatesRouter(config) {
  config = config || {};
  var gate = config.auth || noop;
  var router = express.Router();

  // The list a caller's UI turns into a dropdown. Each row carries its
  // variables so the form for "which values does this need" can be rendered
  // without a second round trip.
  router.get('/email-templates', gate, async function(req, res) {
    try {
      var rows = await templates.list();
      res.json({
        dataArray: rows.map(function(t) {
          return {
            id: t.id, name: t.name, description: t.description,
            subject: t.subject, html: t.html, text: t.text,
            variables: templates.describeVariables(t)
          };
        })
      });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  router.get('/email-templates/:name', gate, async function(req, res) {
    try {
      var t = await templates.get(req.params.name);
      if (!t) return res.status(404).json({ message: 'No template named "' + req.params.name + '".' });
      res.json({ dataArray: [Object.assign({}, t, { variables: templates.describeVariables(t) })] });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  router.post('/email-templates/save', gate, async function(req, res) {
    var body = req.body || {};
    if (!body.name || !body.subject) {
      return res.status(400).json({ message: 'name and subject are required' });
    }
    try {
      var id = await templates.save(body, req.user && req.user.id);
      res.json({ updatedIds: [id] });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  router.post('/email-templates/delete', gate, async function(req, res) {
    var ids = (req.body || {}).ids || [];
    try {
      for (var i = 0; i < ids.length; i++) await templates.remove(ids[i], req.user && req.user.id);
      res.json({ updatedIds: ids });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  // PREVIEW — render with sample values and return the result WITHOUT sending.
  // The whole point of a template is that it goes to customers, so being able
  // to see the rendered subject and body before that happens is not a luxury.
  // strict:false so a half-filled preview still shows you something.
  router.post('/email-templates/:name/preview', gate, async function(req, res) {
    try {
      var out = await templates.render(req.params.name, (req.body || {}).variables || {}, { strict: false });
      res.json({ dataArray: [out] });
    } catch (err) {
      res.status(400).json({ message: err.message, code: err.code });
    }
  });

  return router;
}

module.exports = buildTemplatesRouter;
