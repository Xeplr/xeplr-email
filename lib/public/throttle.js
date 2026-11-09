// THROTTLING — how many sends a visitor, and a form, get in a window.
//
// In memory, per process: right for the one public instance this is built
// for, and it needs no Redis. Behind several instances each counts on its own,
// so the real limit is N times the configured one — put nginx's limit_req in
// front as the outer, shared layer.
//
// A sliding window of timestamps per key: "5 an hour" means any 60 minutes,
// not "until the top of the hour", which a burst at :59 and :00 would double.

function createThrottle() {
  var hits = new Map();   // key → [timestamp, …] oldest first

  function prune(key, windowMs, now) {
    var list = hits.get(key);
    if (!list) return [];
    while (list.length && list[0] <= now - windowMs) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  }

  /**
   * Whether another hit fits under `limit` per `windowMs`, without counting
   * one. { ok, retryAfterSeconds } — retryAfter is when the oldest hit leaves
   * the window.
   */
  function check(key, limit, windowMs, now) {
    now = now || Date.now();
    var list = prune(key, windowMs, now);
    if (list.length < limit) return { ok: true, retryAfterSeconds: 0 };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
  }

  function record(key, now) {
    now = now || Date.now();
    var list = hits.get(key);
    if (!list) { list = []; hits.set(key, list); }
    list.push(now);
  }

  // Keys whose every hit has aged out are dropped, so a stream of one-time
  // visitors does not grow this forever. Longest window here is a day.
  function sweep(now) {
    now = now || Date.now();
    hits.forEach(function(list, key) {
      while (list.length && list[0] <= now - 24 * 3600 * 1000) list.shift();
      if (!list.length) hits.delete(key);
    });
  }

  var timer = setInterval(sweep, 10 * 60 * 1000);
  if (timer.unref) timer.unref();   // never what keeps the process alive

  return { check: check, record: record, sweep: sweep, size: function() { return hits.size; } };
}

module.exports = { createThrottle: createThrottle, HOUR: 3600 * 1000, DAY: 24 * 3600 * 1000 };
