// Template rendering — everything verifiable without a database.
// Run:  node --test test/templates.test.js

var test = require('node:test');
var assert = require('node:assert');
var t = require('../lib/templates');

test('{{name}} substitutes, with or without whitespace', function() {
  assert.strictEqual(t.substitute('Hi {{name}}', { name: 'Ada' }), 'Hi Ada');
  assert.strictEqual(t.substitute('Hi {{ name }}', { name: 'Ada' }), 'Hi Ada');
  assert.strictEqual(t.substitute('{{a}}-{{a}}', { a: 'x' }), 'x-x');
});

test('a {single-brace} token is left ALONE', function() {
  // This is the whole reason bodies use {{ }}: the workflow engine resolves
  // {params.x} in a step's inputs before the action runs. If template bodies
  // used one brace, the engine would try to resolve the template's own
  // placeholders against a run context it cannot see.
  assert.strictEqual(
    t.substitute('{params.x} and {{y}}', { y: 'Y' }),
    '{params.x} and Y'
  );
});

test('a missing variable renders empty rather than leaving the token visible', function() {
  // "Hello ," is bad; "Hello {{firstName}}," in a customer's inbox is worse.
  assert.strictEqual(t.substitute('Hi {{nope}}!', {}), 'Hi !');
});

test('tokensIn lists each token once, in first-seen order', function() {
  assert.deepStrictEqual(
    t.tokensIn('Hi {{firstName}}, your {{item}} is ready. Bye {{firstName}}'),
    ['firstName', 'item']
  );
});

test('describeVariables surfaces tokens the body uses but never declared', function() {
  // A body saying {{frstName}} with firstName declared is a typo that would
  // otherwise ship silently and mail somebody "Hi ,".
  var vars = t.describeVariables({
    subject: 'Welcome {{firstName}}',
    html: '<p>Hi {{frstName}}</p>',
    text: null,
    variables: [{ name: 'firstName', description: 'Given name', required: true }]
  });
  var declared = vars.filter(function(v) { return v.declared; }).map(function(v) { return v.name; });
  var undeclared = vars.filter(function(v) { return !v.declared; }).map(function(v) { return v.name; });
  assert.deepStrictEqual(declared, ['firstName']);
  assert.deepStrictEqual(undeclared, ['frstName']);
});

test('objects render as JSON rather than [object Object]', function() {
  assert.strictEqual(t.substitute('{{o}}', { o: { a: 1 } }), '{"a":1}');
});
