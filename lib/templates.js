// Rendering a stored template into a sendable message.
//
// VARIABLE SYNTAX IS {{name}}, not {name}, and the difference matters.
// A template body lives in this database and never passes through a caller's
// own interpolation — but the VALUES a caller supplies do. @xeplr/schema-
// handler (which the workflow engine uses on every step's inputs) resolves
// {token} and treats {{token}} as an escape. So a workflow step supplies
// `templateVars: { name: '{params.name}' }`, the engine resolves that to a
// real name, and only then does this file substitute it into `{{name}}`.
// Using {name} in bodies would have meant the engine trying to resolve the
// template's own placeholders against the run context, which it cannot see.

var crypto = require('crypto');
var db = require('./db');

function newId() {
  // 25 chars to match the id column and the rest of the suite's varchar(25).
  return crypto.randomBytes(12).toString('hex').slice(0, 24);
}

// {{ name }} / {{name}} — whitespace tolerated, because people type it.
var TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

function substitute(str, vars) {
  if (str == null) return null;
  return String(str).replace(TOKEN, function(_, key) {
    var v = vars[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Every {{token}} a body actually contains, in order of first appearance. */
function tokensIn(str) {
  var found = [];
  String(str || '').replace(TOKEN, function(_, key) {
    if (found.indexOf(key) === -1) found.push(key);
    return '';
  });
  return found;
}

/**
 * The variables a template uses — declared ones first, then any {{token}} that
 * appears in the body but was never declared.
 *
 * Undeclared tokens are surfaced rather than ignored: a body saying
 * "Hi {{frstName}}" with `firstName` declared is a typo that would otherwise
 * ship silently and mail somebody "Hi ,".
 */
function describeVariables(template) {
  var declared = (template.variables || []).map(function(v) {
    return { name: v.name, description: v.description || null, required: v.required !== false, declared: true };
  });
  var names = declared.map(function(v) { return v.name; });
  var used = tokensIn(template.subject).concat(tokensIn(template.html)).concat(tokensIn(template.text));
  used.forEach(function(t) {
    if (names.indexOf(t) === -1) {
      names.push(t);
      declared.push({ name: t, description: null, required: false, declared: false });
    }
  });
  return declared;
}

/**
 * Render a template by NAME into { subject, html, text }.
 *
 * By name rather than id because that is what a caller stores: a workflow step
 * holding a uuid is unreadable in a diff and wrong in the next environment,
 * where the same template has a different id.
 *
 * @param {string} name
 * @param {object} [vars]
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true] — refuse to render when a REQUIRED
 *   variable is missing. On by default: half-rendered mail reaches a customer
 *   and cannot be recalled, so failing loudly is the cheaper outcome.
 */
async function render(name, vars, opts) {
  vars = vars || {};
  opts = opts || {};
  var strict = opts.strict !== false;

  var tpl = await db.model().query().where({ name: name, isActive: true }).first();
  if (!tpl) {
    var err = new Error('No email template named "' + name + '".');
    err.code = 'EMAIL_TEMPLATE_NOT_FOUND';
    throw err;
  }

  if (strict) {
    var missing = (tpl.variables || [])
      .filter(function(v) { return v.required !== false; })
      .filter(function(v) { return vars[v.name] === undefined || vars[v.name] === null || vars[v.name] === ''; })
      .map(function(v) { return v.name; });
    if (missing.length) {
      var e2 = new Error('Template "' + name + '" is missing required variable(s): ' + missing.join(', ') + '.');
      e2.code = 'EMAIL_TEMPLATE_MISSING_VARS';
      throw e2;
    }
  }

  return {
    templateName: tpl.name,
    subject: substitute(tpl.subject, vars),
    html: substitute(tpl.html, vars),
    text: substitute(tpl.text, vars)
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────

var ALL = '*';

/**
 * Every template this tenant can use — its own, plus the ones inherited from
 * the company and from the product, with the nearest one winning.
 *
 * A name appears once. Seeing "User Registration" three times, each row
 * looking identical in a list, is not a choice anybody can make correctly.
 */
async function list(mtId1, mtId2) {
  var company = mtId1 || ALL;
  var workspace = mtId2 || ALL;
  var rows = await db.model().query()
    .where({ isActive: true })
    .whereIn('mtId1', [company, ALL])
    .whereIn('mtId2', [workspace, ALL])
    .orderBy('name');

  var byName = {};
  rows.forEach(function(row) {
    var held = byName[row.name];
    if (!held || rank(row, company, workspace) > rank(held, company, workspace)) byName[row.name] = row;
  });
  return Object.keys(byName).sort().map(function(name) { return byName[name]; });
}

// How SPECIFIC a row is to the caller. Exact workspace beats company-wide
// beats the product's own — the same order an override is expected to work in
// anywhere else in this system.
function rank(row, company, workspace) {
  var score = 0;
  if (row.mtId1 === company && company !== ALL) score += 2;
  if (row.mtId2 === workspace && workspace !== ALL) score += 1;
  return score;
}

/**
 * ONE template by name, resolved most-specific-first.
 *
 * Explicit rather than a BaseModel tenant filter, and the difference matters:
 * an automatic filter returns NOTHING for a send that has no tenant context —
 * a registration or invitation mail, which goes out before the recipient has
 * joined anything — and nothing is silence rather than an error. Here, no
 * tenant simply resolves to the product's own template at ('*', '*').
 */
async function get(name, mtId1, mtId2) {
  var company = mtId1 || ALL;
  var workspace = mtId2 || ALL;
  var candidates = [
    { mtId1: company, mtId2: workspace },
    { mtId1: company, mtId2: ALL },
    { mtId1: ALL, mtId2: ALL }
  ];
  for (var i = 0; i < candidates.length; i++) {
    var row = await db.model().query()
      .where({ name: name, isActive: true, mtId1: candidates[i].mtId1, mtId2: candidates[i].mtId2 })
      .first();
    if (row) return row;
  }
  return null;
}

/**
 * Create or update. `entry.mtId1` decides ownership: a value makes it that
 * tenant's own, omitted makes it a platform template.
 *
 * An existing row's owner is NEVER changed here — a patch that silently moved
 * a platform default into one tenant would take it away from every other.
 */
async function save(entry, userId) {
  var now = new Date().toISOString();
  if (entry.id) {
    await db.model().query().findById(entry.id).patch({
      name: entry.name, description: entry.description, subject: entry.subject,
      html: entry.html, text: entry.text, variables: entry.variables || [],
      recordModifiedDate: now, recordModifiedBy: userId || null
    });
    return entry.id;
  }
  var id = newId();
  await db.model().query().insert({
    id: id, name: entry.name, description: entry.description || null,
    subject: entry.subject, html: entry.html || null, text: entry.text || null,
    variables: entry.variables || [], isActive: true,
    mtId1: entry.mtId1 || ALL,
    mtId2: entry.mtId2 || ALL,
    recordCreatedDate: now, recordCreatedBy: userId || null
  });
  return id;
}

// Soft delete, matching the rest of the suite — and the partial unique index
// on (name) WHERE isActive means the name frees up for a replacement.
async function remove(id, userId) {
  return db.model().query().findById(id).patch({
    isActive: false, recordModifiedDate: new Date().toISOString(), recordModifiedBy: userId || null
  });
}

module.exports = {
  render: render,
  describeVariables: describeVariables,
  tokensIn: tokensIn,
  substitute: substitute,
  list: list,
  get: get,
  save: save,
  remove: remove
};
