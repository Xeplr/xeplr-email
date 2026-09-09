// WHAT A TEMPLATE BODY IS ALLOWED TO CONTAIN, and what will survive Outlook.
//
// Two different jobs, deliberately two functions:
//
//   sanitize() REMOVES what must never be sent. A template body is authored in
//   a browser and delivered to somebody else's inbox, so it is untrusted input
//   twice over — once from whoever typed it, once from whatever pasted into
//   the editor. This is not advisory.
//
//   inspect() WARNS about what will not render the way it looks in the editor.
//   Outlook's desktop clients render through Word, which ignores most of the
//   CSS a browser preview will happily show — so a template can be perfectly
//   safe, look right in the editor, and arrive as a stack of unstyled blocks.
//   These are warnings and never rewrite anything: the author decides.
//
// Regex, not a DOM parser, because this package has no dependencies (see
// package.json) and must run identically on the server and in a browser
// preview. The consequence to know: sanitize is a DENY list applied to markup
// that may be malformed on purpose. It is the second line — the first is that
// only authenticated users reach the editor at all — and it is not a substitute
// for escaping at render time.

// TWO passes, because one is wrong in a way that looks right.
//
// Matching "<tag ...> up to the next > OR its closing tag" ends at the FIRST
// '>' — the end of the OPENING tag — so `<script>evil()</script>` lost its
// tags and left `evil()` sitting in the body as text. The paired form has to
// be removed WITH its content first; only then is it safe to sweep up whatever
// orphan tags are left.
var PAIRED = /<\s*(script|iframe|object|embed|applet|form|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
var ORPHAN = /<\s*\/?\s*(script|iframe|object|embed|applet|form|noscript|base|meta|link)\b[^>]*>/gi;
var ON_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
var JS_URL = /\s+(href|src|action|background|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;
var STYLE_EXPRESSION = /expression\s*\(/gi;
// The whole quoted value, closing quote included — stopping before it left
// `<a">x</a>`, which is broken markup produced by the thing meant to clean it.
var DATA_URL_SCRIPT = /\s+(href|src)\s*=\s*("[^"]*data:text\/html[^"]*"|'[^']*data:text\/html[^']*'|data:text\/html[^\s>]*)/gi;

/**
 * Strip what must never reach an inbox. Returns the cleaned HTML and a list of
 * what was taken out, so the UI can say so rather than silently editing.
 */
function sanitize(html) {
  var removed = [];
  var out = String(html == null ? '' : html);

  function drop(re, label) {
    var before = out;
    out = out.replace(re, function(match) {
      // A tag that opens the same element again inside itself is still one
      // removal to whoever is reading the list.
      if (removed.indexOf(label) === -1) removed.push(label);
      return '';
    });
    return before !== out;
  }

  drop(PAIRED, 'script/iframe/form and similar tags, with their contents');
  drop(ORPHAN, 'script/iframe/form and similar tags');
  drop(ON_ATTR, 'inline event handlers (onclick and friends)');
  drop(JS_URL, 'javascript: links');
  drop(DATA_URL_SCRIPT, 'data:text/html links');
  if (STYLE_EXPRESSION.test(out)) {
    out = out.replace(STYLE_EXPRESSION, 'void(');
    removed.push('CSS expression()');
  }
  return { html: out, removed: removed };
}

// Each rule: what to look for, and what the author will actually see happen.
// Phrased as consequences, not as rule names — "Outlook ignores flexbox" is
// something you can act on; "rule FLEX_UNSUPPORTED" is not.
var CHECKS = [
  { re: /display\s*:\s*(flex|grid)/i,
    say: 'Outlook (desktop) ignores flexbox and grid — this layout will stack vertically. Use a <table> for structure.' },
  { re: /position\s*:\s*(absolute|fixed|sticky)/i,
    say: 'Outlook ignores positioning — anything placed this way will land in the normal flow.' },
  { re: /<style\b/i,
    say: 'Some clients (Gmail on mobile in particular) drop <style> blocks. Inline the styles you cannot lose.' },
  { re: /background-image\s*:/i,
    say: 'Outlook needs VML for background images — this one will simply not appear.' },
  { re: /\d(rem|vh|vw)\b/i,
    say: 'rem/vh/vw are unreliable in email. Use px.' },
  { re: /<img\b(?![^>]*\balt\s*=)[^>]*>/i,
    say: 'An <img> with no alt — many clients block images by default, and this one will show nothing at all.' },
  { re: /<(video|audio|svg|canvas)\b/i,
    say: 'Video, audio, SVG and canvas do not render in most mail clients.' },
  { re: /<img\b(?![^>]*\bwidth\s*=)[^>]*>/i,
    say: 'An <img> with no width attribute — Outlook sizes it from the file, which is often not what you drew.' }
];

/**
 * Advisory only. Returns [{ message }] — nothing here changes the body.
 */
function inspect(html) {
  var body = String(html == null ? '' : html);
  if (!body.trim()) return [];
  var warnings = [];
  CHECKS.forEach(function(check) {
    if (check.re.test(body)) warnings.push({ message: check.say });
  });
  // A body with no table at all, but with layout intent, is the single most
  // common way an email looks right in a browser and wrong in Outlook.
  if (!/<table\b/i.test(body) && /<div\b[\s\S]*<div\b/i.test(body)) {
    warnings.push({ message: 'No <table> anywhere — nested <div>s are laid out by Word in Outlook and rarely survive. Tables are still the reliable way to build an email.' });
  }
  return warnings;
}

module.exports = { sanitize: sanitize, inspect: inspect };
