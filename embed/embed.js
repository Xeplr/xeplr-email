/*!
 * @xeplr/email — embed.js
 *
 * Forms on any web page that send through the public @xeplr/email service.
 * One <script>, no build, no framework:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@xeplr/email@1/embed/embed.min.js" async></script>
 *
 * Three ways in:
 *
 *   1. A READY-MADE form, drawn from the service's definition:
 *        <div data-xeplr-form="contact" data-endpoint="https://forms.example.com"></div>
 *
 *   2. YOUR OWN form, left exactly as designed — this only sends it:
 *        <form data-xeplr-form="contact" data-endpoint="https://forms.example.com">
 *          <input name="name"> <input name="email" type="email"> <textarea name="message"></textarea>
 *          <p data-xeplr-message></p>
 *          <button>Send</button>
 *        </form>
 *      Each input's `name` is a field key from the service's form config.
 *      While it works the form carries data-xeplr-state="sending|sent|error";
 *      [data-xeplr-message] gets the outcome, [data-xeplr-error="<key>"] a
 *      field's problem, and the form fires `xeplr:sent` / `xeplr:error`
 *      (call event.preventDefault() on xeplr:sent to keep the values and show
 *      your own message instead).
 *
 *   3. FROM CODE:
 *        XeplrForms.prepare('contact', { endpoint: '…' })   when the form appears (fetches its token)
 *        XeplrForms.send('contact', { name: 'Ada', … }, { endpoint: '…' })  → Promise
 *        XeplrForms.mount(element)   (forms added later are found on their own too)
 *
 * Every send carries a single-use token from the service. The script fetches
 * it when a form appears, renews it while the page stays open, and fetches
 * the next one after each send: nothing to add to your HTML. A send made
 * before the service's minimum time (a few seconds) waits that long first.
 *
 * data-endpoint may sit on the <script> tag instead, for every form on the page.
 * Served by the service itself (/embed.js), it needs none: it calls home.
 *
 * Nothing here is a security boundary — the service checks everything again.
 */
(function () {
  'use strict';

  if (window.XeplrForms) return;   // loaded twice: the first one wins

  var VERSION = '1';
  var API = '/public/v1';
  var HONEYPOT = '_hp';
  var TOKEN = '_token';
  var CDN_HOSTS = /(^|\.)(jsdelivr\.net|unpkg\.com)$/;

  var script = document.currentScript;

  // ── where the service is ──────────────────────────────────────────────

  function scriptEndpoint() {
    if (!script) return null;
    if (script.getAttribute('data-endpoint')) return script.getAttribute('data-endpoint');
    // Served by the service itself: its own origin is the endpoint. From a
    // CDN it cannot be — the CDN does not run the service.
    try {
      var u = new URL(script.src, location.href);
      if (/\/embed(\.min)?\.js$/.test(u.pathname) && !CDN_HOSTS.test(u.hostname)) return u.origin;
    } catch (e) { /* no src */ }
    return null;
  }
  var defaultEndpoint = scriptEndpoint();

  function endpointFor(el, explicit) {
    var e = explicit || (el && el.getAttribute('data-endpoint')) || defaultEndpoint;
    if (!e) throw new Error('XeplrForms: no endpoint — add data-endpoint="https://your-forms-service" to the form or the <script> tag');
    return String(e).replace(/\/+$/, '');
  }

  // ── talking to the service ────────────────────────────────────────────

  function request(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var err = new Error(data.error || ('The request failed (' + res.status + ')'));
        err.status = res.status;
        err.fields = data.fields || null;
        err.captcha = Boolean(data.captcha);
        err.token = data.token || null;   // why a token was refused: 'used', 'early', …
        throw err;
      });
    }, function () {
      var err = new Error('The form service could not be reached — please try again later');
      err.status = 0;
      throw err;
    });
  }

  // ── tokens ────────────────────────────────────────────────────────────
  // One waiting token per form: fetched ahead, so the visitor's own typing
  // time covers the service's minimum wait; handed to exactly one send.

  var tokens = {};   // base|key → { promise, token, readyAt, expiresAt, timer }

  function fetchToken(base, key) {
    var id = base + '|' + key;
    var entry = {};
    entry.promise = request(base + API + '/token/' + encodeURIComponent(key), { method: 'GET' }).then(function (data) {
      var now = Date.now();
      entry.token = data.token || null;
      entry.readyAt = now + (data.minWait || 0) * 1000;
      entry.expiresAt = data.expiresIn ? now + data.expiresIn * 1000 : Infinity;
      // Renewed a minute before it lapses, for a page left open.
      if (entry.token && data.expiresIn > 90) {
        entry.timer = setTimeout(function () {
          if (tokens[id] === entry) fetchToken(base, key).catch(function () { /* the send will fetch one */ });
        }, (data.expiresIn - 60) * 1000);
      }
      return entry;
    }, function (err) {
      if (tokens[id] === entry) delete tokens[id];
      throw err;
    });
    tokens[id] = entry;
    return entry.promise;
  }

  /** Fetch a form's token ahead of its send. Call when a form you send from code appears. */
  function prepare(key, options) {
    var base = endpointFor(null, options && options.endpoint);
    var id = base + '|' + key;
    return (tokens[id] ? tokens[id].promise : fetchToken(base, key)).then(function () { return true; });
  }

  /** The token for one send: the waiting one if it is still good, else a new one; after its minimum wait. */
  function takeToken(base, key) {
    var id = base + '|' + key;
    var pending = tokens[id] ? tokens[id].promise : fetchToken(base, key);
    return pending.then(function (entry) {
      if (tokens[id] === entry) delete tokens[id];
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.token && Date.now() > entry.expiresAt - 5000) return takeToken(base, key);
      var wait = entry.readyAt - Date.now();
      return new Promise(function (resolve) { setTimeout(function () { resolve(entry.token); }, Math.max(0, wait)); });
    });
  }

  /** Send values to a form. Resolves { success, message }; rejects an Error with .status and .fields. */
  function send(key, values, options) {
    var base = endpointFor(null, options && options.endpoint);
    var body = {};
    Object.keys(values || {}).forEach(function (k) {
      var v = values[k];
      if (v != null) body[k] = String(v);
    });
    var next = function () { fetchToken(base, key).catch(function () { /* fetched again on the next send */ }); };
    return takeToken(base, key).then(function (token) {
      if (token) body[TOKEN] = token;
      return request(base + API + '/send/' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (data) { next(); return data; }, function (err) { next(); throw err; });
  }

  var definitions = {};
  function definition(base, key) {
    var id = base + '|' + key;
    if (!definitions[id]) {
      definitions[id] = request(base + API + '/forms/' + encodeURIComponent(key), { method: 'GET' });
      definitions[id].catch(function () { delete definitions[id]; });   // a failure is retried next time
    }
    return definitions[id];
  }

  // ── sending a <form> ──────────────────────────────────────────────────

  /**
   * The honeypot: a field people never see or reach, that bots fill. Off-screen
   * rather than display:none, which some bots know to skip.
   */
  function addHoneypot(form) {
    if (form.querySelector('[name="' + HONEYPOT + '"]')) return;
    var wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important';
    var input = document.createElement('input');
    input.type = 'text';
    input.name = HONEYPOT;
    input.tabIndex = -1;
    input.autocomplete = 'off';
    wrap.appendChild(input);
    form.appendChild(wrap);
  }

  function valuesOf(form) {
    var out = {};
    new FormData(form).forEach(function (value, key) {
      if (typeof value === 'string') out[key] = value;   // files are never sent
    });
    return out;
  }

  function setState(form, state) {
    form.setAttribute('data-xeplr-state', state);
    var buttons = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = state === 'sending';
  }

  function showMessage(form, text, kind) {
    var el = form.querySelector('[data-xeplr-message]');
    if (!el) return;
    el.textContent = text || '';
    el.setAttribute('data-xeplr-kind', kind || '');
    if (kind === 'error') el.setAttribute('role', 'alert'); else el.setAttribute('role', 'status');
  }

  function clearFieldErrors(form) {
    var errs = form.querySelectorAll('[data-xeplr-error]');
    for (var i = 0; i < errs.length; i++) errs[i].textContent = '';
    var invalid = form.querySelectorAll('[aria-invalid="true"]');
    for (var j = 0; j < invalid.length; j++) invalid[j].removeAttribute('aria-invalid');
  }

  function showFieldErrors(form, fields) {
    var first = null;
    Object.keys(fields || {}).forEach(function (key) {
      var input = form.elements.namedItem(key);
      if (input && input.setAttribute) {
        input.setAttribute('aria-invalid', 'true');
        if (!first) first = input;
      }
      var slot = form.querySelector('[data-xeplr-error="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      if (slot) slot.textContent = fields[key];
    });
    if (first && first.focus) first.focus();
  }

  function fire(form, name, detail) {
    var event = new CustomEvent(name, { bubbles: true, cancelable: true, detail: detail });
    return form.dispatchEvent(event);
  }

  function enhance(form, key, base, sentMessage) {
    addHoneypot(form);
    form.setAttribute('data-xeplr-ready', '');
    // Its token now, while the visitor types: by the time they send, the
    // service's minimum wait has long passed.
    prepare(key, { endpoint: base }).catch(function () { /* fetched again when sent */ });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (form.getAttribute('data-xeplr-state') === 'sending') return;
      clearFieldErrors(form);
      // The form's own HTML rules (required, type="email") first: the browser
      // already knows how to say what is wrong, in the visitor's language.
      if (form.reportValidity && !form.reportValidity()) return;

      setState(form, 'sending');
      showMessage(form, 'Sending…', 'sending');
      send(key, valuesOf(form), { endpoint: base }).then(function (data) {
        setState(form, 'sent');
        if (fire(form, 'xeplr:sent', { form: key, response: data })) {
          showMessage(form, data.message || sentMessage || 'Sent.', 'sent');
          form.reset();
        } else {
          showMessage(form, '', '');
        }
        if (window.turnstile && form.querySelector('.cf-turnstile, [data-xeplr-captcha]')) window.turnstile.reset();
      }, function (err) {
        setState(form, 'error');
        showFieldErrors(form, err.fields);
        if (fire(form, 'xeplr:error', { form: key, error: err.message, status: err.status, fields: err.fields })) {
          showMessage(form, err.message, 'error');
        }
        if (window.turnstile && err.captcha) window.turnstile.reset();
      });
    });
  }

  // ── the ready-made form ───────────────────────────────────────────────

  // Drawn in a shadow root: the page's CSS cannot reach in and break it, and
  // its CSS cannot leak out. Restyle it from outside with these properties on
  // the host element, e.g. [data-xeplr-form] { --xf-accent: #0a7 }.
  var STYLE = [
    ':host{display:block;font:inherit;color:var(--xf-text,inherit)}',
    'form{display:grid;gap:var(--xf-gap,14px);max-width:var(--xf-max-width,560px)}',
    '.f{display:flex;flex-direction:column;gap:6px}',
    'label{font-size:var(--xf-label-size,.85rem);font-weight:600}',
    '.req{color:var(--xf-error,#c2372e)}',
    'input,select,textarea{font:inherit;font-size:var(--xf-input-size,.95rem);padding:var(--xf-input-padding,10px 12px);',
    'border:1px solid var(--xf-border,#c9c9c9);border-radius:var(--xf-radius,8px);background:var(--xf-input-bg,#fff);',
    'color:var(--xf-input-text,#1a1a1a);width:100%;box-sizing:border-box}',
    'textarea{resize:vertical;min-height:110px}',
    'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--xf-accent,#2563eb);',
    'box-shadow:0 0 0 3px var(--xf-ring,rgba(37,99,235,.15))}',
    '[aria-invalid="true"]{border-color:var(--xf-error,#c2372e)}',
    '.help{font-size:.8rem;color:var(--xf-muted,#6b6b6b);margin:0}',
    '.err{font-size:.8rem;color:var(--xf-error,#c2372e);margin:0}',
    '.err:empty{display:none}',
    'button{justify-self:start;font:inherit;font-weight:600;padding:var(--xf-button-padding,10px 20px);border:0;',
    'border-radius:var(--xf-radius,8px);background:var(--xf-accent,#2563eb);color:var(--xf-accent-text,#fff);cursor:pointer}',
    'button:disabled{opacity:.6;cursor:not-allowed}',
    '.msg{margin:0;font-size:.9rem}',
    '.msg:empty{display:none}',
    '.msg[data-xeplr-kind="sent"]{color:var(--xf-success,#047857)}',
    '.msg[data-xeplr-kind="error"]{color:var(--xf-error,#c2372e)}'
  ].join('');

  function node(tag, attrs, text) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === true) el.setAttribute(k, '');
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    });
    if (text != null) el.textContent = text;   // never innerHTML: labels come over the network
    return el;
  }

  function buildForm(def, uid) {
    var form = node('form', { novalidate: false });
    def.fields.forEach(function (f) {
      var id = 'xf-' + uid + '-' + f.key;
      var wrap = node('div', { 'class': 'f' });
      var label = node('label', { 'for': id }, f.label);
      if (f.required) label.appendChild(node('span', { 'class': 'req', 'aria-hidden': 'true' }, ' *'));
      wrap.appendChild(label);

      var input;
      if (f.type === 'multiline') {
        input = node('textarea', { id: id, name: f.key, rows: f.rows || 5 });
      } else if (f.type === 'select') {
        input = node('select', { id: id, name: f.key });
        input.appendChild(node('option', { value: '' }, f.placeholder || 'Select…'));
        f.options.forEach(function (o) { input.appendChild(node('option', { value: o }, o)); });
      } else {
        input = node('input', {
          id: id, name: f.key, type: f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text',
          autocomplete: f.type === 'email' ? 'email' : f.key === 'name' ? 'name' : null
        });
      }
      if (f.required) input.required = true;
      if (f.maxLength && f.type !== 'select') input.maxLength = f.maxLength;
      if (f.placeholder && f.type !== 'select') input.placeholder = f.placeholder;
      wrap.appendChild(input);
      if (f.help) wrap.appendChild(node('p', { 'class': 'help' }, f.help));
      wrap.appendChild(node('p', { 'class': 'err', 'data-xeplr-error': f.key }));
      form.appendChild(wrap);
    });
    if (def.captcha && def.captcha.turnstile) form.appendChild(node('div', { 'data-xeplr-captcha': '' }));
    form.appendChild(node('p', { 'class': 'msg', 'data-xeplr-message': '' }));
    form.appendChild(node('button', { type: 'submit' }, def.submitLabel || 'Send'));
    return form;
  }

  var turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!turnstileLoading) {
      turnstileLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = function () { resolve(window.turnstile); };
        s.onerror = function () { reject(new Error('The anti-spam check could not load')); };
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }

  var uid = 0;
  function render(host, key, base) {
    host.setAttribute('data-xeplr-ready', '');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = node('style', null, STYLE);
    root.appendChild(style);
    var status = node('p', { 'class': 'msg', role: 'status' }, 'Loading…');
    root.appendChild(status);

    definition(base, key).then(function (def) {
      root.removeChild(status);
      var form = buildForm(def, ++uid);
      root.appendChild(form);
      enhance(form, key, base, def.sentMessage);
      if (def.captcha && def.captcha.turnstile) {
        loadTurnstile().then(function (ts) {
          ts.render(form.querySelector('[data-xeplr-captcha]'), { sitekey: def.captcha.turnstile.siteKey });
        }, function (err) { showMessage(form, err.message, 'error'); });
      }
    }, function (err) {
      status.textContent = 'This form could not be loaded. ' + (err.status === 404 ? '(No form "' + key + '".)' : '');
      status.setAttribute('data-xeplr-kind', 'error');
      if (window.console) console.error('[XeplrForms] ' + key + ': ' + err.message);
    });
  }

  // ── finding forms ─────────────────────────────────────────────────────

  function mount(el) {
    if (!el || el.hasAttribute('data-xeplr-ready')) return;
    var key = el.getAttribute('data-xeplr-form');
    if (!key) return;
    var base;
    try { base = endpointFor(el); } catch (e) { if (window.console) console.error(e.message); return; }
    if (el.tagName === 'FORM') enhance(el, key, base, null);
    else render(el, key, base);
  }

  function scan(root) {
    var list = (root || document).querySelectorAll('[data-xeplr-form]:not([data-xeplr-ready])');
    for (var i = 0; i < list.length; i++) mount(list[i]);
  }

  // Forms that arrive later — a React page, a modal, anything rendered after
  // load — are found as they appear.
  function watch() {
    if (!window.MutationObserver) return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute('data-xeplr-form')) mount(n);
          scan(n);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.XeplrForms = { version: VERSION, send: send, prepare: prepare, mount: mount, scan: scan };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(); watch(); });
  } else {
    scan();
    watch();
  }
})();
