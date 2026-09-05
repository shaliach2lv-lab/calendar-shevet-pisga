/*!
 * ics.js — Shevet Pisga Admin
 * ---------------------------------------------------------------------------
 * Dependency-free iCalendar (RFC 5545) feed generator.
 *
 * Reads the master event database (data/events.json) and produces the six
 * published .ics feeds. Design rules that must never be broken:
 *
 *   1. UIDs are stable. An existing event keeps its UID forever. New UIDs are
 *      only minted for events that have never been published to a schedule,
 *      and retired numbers are never reused.
 *   2. Filenames and subscription URLs never change.
 *   3. Every timed event is anchored to America/Los_Angeles via a real
 *      VTIMEZONE block plus TZID parameters. Never emit floating times.
 *   4. Output order follows the UID sequence number, which reproduces the
 *      original hand-written file order exactly, so diffs stay reviewable.
 *   5. The original files were committed with mixed line endings (pisga = CRLF,
 *      tet/shchavag = LF). We reproduce each file's own ending by default.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var TZID = 'America/Los_Angeles';

  var VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    'TZID:America/Los_Angeles',
    'X-LIC-LOCATION:America/Los_Angeles',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  /* Line endings as they exist in the repository today. */
  var LEGACY_EOL = {
    'unique-pisga.ics': '\r\n',
    'unique-pisga-en.ics': '\r\n',
    'unique-tet.ics': '\n',
    'unique-tet-en.ics': '\n',
    'unique-shchavag.ics': '\n',
    'unique-shchavag-en.ics': '\n'
  };

  var LANGS = ['he', 'en'];

  /* ----------------------------------------------------------------- utils */

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) { s = '0' + s; }
    return s;
  }

  function icsDate(v) {
    return String(v).slice(0, 10).replace(/-/g, '');
  }

  function icsDateTime(v) {
    var s = String(v);
    var d = s.slice(0, 10).replace(/-/g, '');
    var t = s.slice(11, 19).replace(/:/g, '');
    while (t.length < 6) { t += '0'; }
    return d + 'T' + t;
  }

  function icsStamp(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) { d = new Date(); }
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2) + 'T' +
      pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2) + 'Z';
  }

  function esc(text) {
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  function unesc(text) {
    return String(text)
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  function byteLen(s) {
    if (global.TextEncoder) { return new global.TextEncoder().encode(s).length; }
    return unescape(encodeURIComponent(s)).length;
  }

  /* RFC 5545 content lines are folded at 75 octets. No line in the legacy
     files comes close, so folding is a no-op for existing content. */
  function fold(line) {
    if (byteLen(line) <= 75) { return [line]; }
    var out = [];
    var cur = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (byteLen(cur + ch) > 74) { out.push(cur); cur = ' '; }
      cur += ch;
    }
    if (cur.length) { out.push(cur); }
    return out;
  }

  function unfold(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  }

  /* ------------------------------------------------------------------ uids */

  function uidSeq(uid) {
    var m = /-(\d+)@/.exec(uid || '');
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  function uidPrefix(uid) {
    var m = /^([a-z0-9_-]+?)-\d+@/i.exec(uid || '');
    return m ? m[1] : null;
  }

  /* Mints the next UID for a schedule. Never reuses a number that has been
     handed out before, even if the event that owned it was archived. */
  function nextUid(db, scheduleKey) {
    var max = 0;
    (db.events || []).forEach(function (ev) {
      var u = ev.uids && ev.uids[scheduleKey];
      if (!u) { return; }
      var n = uidSeq(u);
      if (n !== Number.MAX_SAFE_INTEGER && n > max) { max = n; }
    });
    if (!db.uidCounters) { db.uidCounters = {}; }
    var reserved = db.uidCounters[scheduleKey] || 0;
    var next = Math.max(max, reserved) + 1;
    db.uidCounters[scheduleKey] = next;
    return scheduleKey + '-' + pad(next, 3) + '@' + (db.uidDomain || 'shaliach2lv-lab.github.io');
  }

  /* Gives an event a UID for every schedule it is published to. Existing UIDs
     are never touched, and UIDs are never removed when a schedule is
     unchecked, so re-adding the event later restores the same identity for
     subscribers instead of creating a duplicate. */
  function ensureUids(db, ev) {
    var minted = [];
    if (!ev.uids) { ev.uids = {}; }
    (db.schedules || []).forEach(function (s) {
      var p = ev.publications && ev.publications[s.key];
      var wanted = !!(p && (p.he || p.en));
      if (wanted && !ev.uids[s.key]) {
        ev.uids[s.key] = nextUid(db, s.key);
        minted.push({ schedule: s.key, uid: ev.uids[s.key] });
      }
    });
    return minted;
  }

  /* ------------------------------------------------------- effective values */

  function coalesce(a, b) {
    return (a === null || a === undefined || a === '') ? b : a;
  }

  /* Resolves the master event against a per-schedule override. The master is
     always the default; the override only replaces the fields it declares. */
  function effective(ev, scheduleKey) {
    var o = (ev.overrides && ev.overrides[scheduleKey]) || {};
    var mt = ev.title || {};
    var md = ev.description || {};
    var ml = ev.location || {};
    var ot = o.title || {};
    var od = o.description || {};
    var ol = o.location || {};
    return {
      start: coalesce(o.start, ev.start),
      end: coalesce(o.end, ev.end),
      allDay: (typeof o.allDay === 'boolean') ? o.allDay : !!ev.allDay,
      title: { he: coalesce(ot.he, mt.he), en: coalesce(ot.en, mt.en) },
      description: { he: coalesce(od.he, md.he), en: coalesce(od.en, md.en) },
      location: { he: coalesce(ol.he, ml.he), en: coalesce(ol.en, ml.en) },
      status: coalesce(o.status, ev.status) || 'published',
      recurrence: coalesce(o.recurrence, ev.recurrence),
      link: coalesce(o.link, ev.link),
      category: coalesce(o.category, ev.category),
      hasOverride: Object.keys(o).length > 0,
      overriddenFields: Object.keys(o)
    };
  }

  /* Lists the concrete differences an override introduces, for the UI. */
  function overrideSummary(ev, scheduleKey) {
    var o = (ev.overrides && ev.overrides[scheduleKey]) || {};
    var out = [];
    if (o.start || o.end) {
      out.push({ field: 'time', from: timeRange(ev), to: timeRange({ start: coalesce(o.start, ev.start), end: coalesce(o.end, ev.end), allDay: ev.allDay }) });
    }
    if (o.title && (o.title.he || o.title.en)) {
      LANGS.forEach(function (l) {
        if (o.title[l]) { out.push({ field: 'title:' + l, from: (ev.title || {})[l] || '', to: o.title[l] }); }
      });
    }
    if (o.location && (o.location.he || o.location.en)) { out.push({ field: 'location', from: (ev.location || {}).he || '', to: o.location.he || o.location.en }); }
    if (o.status) { out.push({ field: 'status', from: ev.status, to: o.status }); }
    return out;
  }

  function hhmm(v) {
    var s = String(v);
    return s.slice(11, 16) || '';
  }

  function timeRange(ev) {
    if (ev.allDay) { return 'All day'; }
    return hhmm(ev.start) + '–' + hhmm(ev.end);
  }

  /* ------------------------------------------------------------ generation */

  function publishesTo(ev, scheduleKey, lang) {
    var p = ev.publications && ev.publications[scheduleKey];
    return !!(p && p[lang] && ev.uids && ev.uids[scheduleKey]);
  }

  function schedulesOf(ev) {
    var out = [];
    Object.keys(ev.publications || {}).forEach(function (k) {
      var p = ev.publications[k];
      if (p && (p.he || p.en)) { out.push(k); }
    });
    return out;
  }

  function feedCount(ev) {
    var n = 0;
    Object.keys(ev.publications || {}).forEach(function (k) {
      var p = ev.publications[k] || {};
      if (p.he) { n++; }
      if (p.en) { n++; }
    });
    return n;
  }

  function eventLines(db, ev, scheduleKey, lang) {
    var eff = effective(ev, scheduleKey);
    var seq = ev.sequence || 0;
    /* Untouched migrated events keep their original DTSTAMP so the first
       published diff shows nothing for them. */
    var stamp = seq > 0 ? icsStamp(ev.updatedAt) : (db.legacyDtstamp || icsStamp(ev.updatedAt));

    var lines = [
      'BEGIN:VEVENT',
      'UID:' + ev.uids[scheduleKey],
      'DTSTAMP:' + stamp
    ];

    if (eff.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + icsDate(eff.start));
      lines.push('DTEND;VALUE=DATE:' + icsDate(eff.end));
    } else {
      lines.push('DTSTART;TZID=' + TZID + ':' + icsDateTime(eff.start));
      lines.push('DTEND;TZID=' + TZID + ':' + icsDateTime(eff.end));
    }

    var other = lang === 'he' ? 'en' : 'he';
    var summary = eff.title[lang] || eff.title[other] || '';
    lines.push('SUMMARY:' + esc(summary));

    var desc = eff.description[lang];
    if (desc) { lines.push('DESCRIPTION:' + esc(desc)); }
    var loc = eff.location[lang];
    if (loc) { lines.push('LOCATION:' + esc(loc)); }
    if (eff.link) { lines.push('URL:' + eff.link); }
    if (eff.category) { lines.push('CATEGORIES:' + esc(eff.category)); }
    if (eff.recurrence) { lines.push('RRULE:' + eff.recurrence); }
    if (seq > 0) { lines.push('SEQUENCE:' + seq); }
    if (eff.status === 'cancelled' || eff.status === 'archived') { lines.push('STATUS:CANCELLED'); }
    if (seq > 0 && ev.updatedAt) { lines.push('LAST-MODIFIED:' + icsStamp(ev.updatedAt)); }

    lines.push('END:VEVENT');
    return lines;
  }

  function scheduleByKey(db, key) {
    var found = null;
    (db.schedules || []).forEach(function (s) { if (s.key === key) { found = s; } });
    return found;
  }

  /* options:
       eol           – force a line ending for every file
       extraHeaders  – include X-PUBLISHED-TTL / REFRESH-INTERVAL (default true)
       includeArchived – emit archived events as STATUS:CANCELLED tombstones
                         so subscribers actually drop them (default true) */
  function generateFeed(db, scheduleKey, lang, opts) {
    opts = opts || {};
    var sched = scheduleByKey(db, scheduleKey);
    if (!sched) { throw new Error('Unknown schedule: ' + scheduleKey); }
    var feed = sched.feeds[lang];
    var eol = opts.eol || LEGACY_EOL[feed.file] || '\r\n';
    var extras = opts.extraHeaders !== false;
    var keepTombstones = opts.includeArchived !== false;

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:' + feed.prodid,
      'CALSCALE:GREGORIAN',
      'X-WR-TIMEZONE:' + TZID,
      'X-WR-CALNAME:' + (feed.calname || sched.name[lang])
    ];
    if (extras) {
      lines.push('X-PUBLISHED-TTL:PT1H');
      lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    }
    lines = lines.concat(VTIMEZONE);

    var list = (db.events || []).filter(function (ev) {
      if (!publishesTo(ev, scheduleKey, lang)) { return false; }
      var st = effective(ev, scheduleKey).status;
      if ((st === 'archived' || st === 'cancelled') && !keepTombstones) { return false; }
      return true;
    });

    /* UID sequence order reproduces the original file order byte for byte and
       appends anything new at the end. */
    list.sort(function (a, b) {
      var d = uidSeq(a.uids[scheduleKey]) - uidSeq(b.uids[scheduleKey]);
      if (d !== 0) { return d; }
      return String(a.start).localeCompare(String(b.start));
    });

    list.forEach(function (ev) { lines = lines.concat(eventLines(db, ev, scheduleKey, lang)); });
    lines.push('END:VCALENDAR');

    var folded = [];
    lines.forEach(function (l) { folded = folded.concat(fold(l)); });
    return folded.join(eol) + eol;
  }

  function feedFiles(db) {
    var out = [];
    (db.schedules || []).forEach(function (s) {
      LANGS.forEach(function (l) {
        out.push({
          schedule: s.key,
          lang: l,
          file: s.feeds[l].file,
          name: s.name[l],
          color: s.color
        });
      });
    });
    return out;
  }

  function generateAll(db, opts) {
    var out = {};
    feedFiles(db).forEach(function (f) {
      out[f.file] = generateFeed(db, f.schedule, f.lang, opts);
    });
    return out;
  }

  /* ---------------------------------------------------------------- parsing */

  function parse(text) {
    var lines = unfold(text).split('\n');
    var events = [];
    var cur = null;
    var inTz = false;
    lines.forEach(function (line) {
      if (line === 'BEGIN:VTIMEZONE') { inTz = true; return; }
      if (line === 'END:VTIMEZONE') { inTz = false; return; }
      if (inTz) { return; }
      if (line === 'BEGIN:VEVENT') { cur = { allDay: false }; return; }
      if (line === 'END:VEVENT') { if (cur) { events.push(cur); } cur = null; return; }
      if (!cur) { return; }
      var i = line.indexOf(':');
      if (i < 0) { return; }
      var name = line.slice(0, i);
      var value = line.slice(i + 1);
      var key = name.split(';')[0];
      if (key === 'UID') { cur.uid = value; }
      else if (key === 'SUMMARY') { cur.summary = unesc(value); }
      else if (key === 'DESCRIPTION') { cur.description = unesc(value); }
      else if (key === 'LOCATION') { cur.location = unesc(value); }
      else if (key === 'DTSTAMP') { cur.dtstamp = value; }
      else if (key === 'SEQUENCE') { cur.sequence = parseInt(value, 10); }
      else if (key === 'STATUS') { cur.status = value; }
      else if (key === 'RRULE') { cur.rrule = value; }
      else if (key === 'URL') { cur.url = value; }
      else if (key === 'CATEGORIES') { cur.categories = value; }
      else if (key === 'DTSTART' || key === 'DTEND') {
        if (name.indexOf('VALUE=DATE') >= 0) { cur.allDay = true; }
        cur[key === 'DTSTART' ? 'start' : 'end'] = value;
      }
    });
    return events;
  }

  /* --------------------------------------------------------- verification */

  function validate(text) {
    var errors = [];
    var warnings = [];
    var t = unfold(text);
    if (t.indexOf('BEGIN:VCALENDAR') !== 0) { errors.push('Missing BEGIN:VCALENDAR'); }
    if (!/END:VCALENDAR\s*$/.test(t)) { errors.push('Missing END:VCALENDAR'); }
    if (t.indexOf('VERSION:2.0') < 0) { errors.push('Missing VERSION:2.0'); }
    if (t.indexOf('BEGIN:VTIMEZONE') < 0) { errors.push('Missing VTIMEZONE block'); }
    if (t.indexOf('TZID:America/Los_Angeles') < 0) { errors.push('Missing America/Los_Angeles timezone definition'); }
    var b = (t.match(/BEGIN:VEVENT/g) || []).length;
    var e = (t.match(/END:VEVENT/g) || []).length;
    if (b !== e) { errors.push('Unbalanced VEVENT blocks (' + b + ' begin / ' + e + ' end)'); }

    var evs = parse(text);
    var seen = {};
    evs.forEach(function (ev) {
      if (!ev.uid) { errors.push('Event without UID'); return; }
      if (seen[ev.uid]) { errors.push('Duplicate UID: ' + ev.uid); }
      seen[ev.uid] = true;
      if (!ev.start) { errors.push('No DTSTART: ' + ev.uid); }
      if (!ev.end) { warnings.push('No DTEND: ' + ev.uid); }
      if (!ev.summary) { errors.push('No SUMMARY: ' + ev.uid); }
      if (!ev.allDay && ev.start && ev.start.indexOf('T') < 0) { errors.push('Timed event with date-only DTSTART: ' + ev.uid); }
      if (!ev.allDay && ev.start && ev.end && ev.end < ev.start) { errors.push('DTEND before DTSTART: ' + ev.uid); }
    });
    return { ok: errors.length === 0, errors: errors, warnings: warnings, eventCount: evs.length };
  }

  /* Semantic diff between a published feed and a candidate feed. */
  function diff(oldText, newText) {
    var oldEv = {};
    var newEv = {};
    parse(oldText || '').forEach(function (e) { oldEv[e.uid] = e; });
    parse(newText || '').forEach(function (e) { newEv[e.uid] = e; });
    var added = [];
    var removed = [];
    var changed = [];
    var fields = ['start', 'end', 'summary', 'allDay', 'status', 'description', 'location', 'rrule'];
    Object.keys(newEv).forEach(function (u) { if (!oldEv[u]) { added.push(newEv[u]); } });
    Object.keys(oldEv).forEach(function (u) {
      if (!newEv[u]) { removed.push(oldEv[u]); return; }
      var a = oldEv[u];
      var b = newEv[u];
      var d = [];
      fields.forEach(function (f) {
        var av = a[f] === undefined ? '' : String(a[f]);
        var bv = b[f] === undefined ? '' : String(b[f]);
        if (av !== bv) { d.push({ field: f, from: av, to: bv }); }
      });
      if (d.length) { changed.push({ uid: u, summary: b.summary, fields: d }); }
    });
    return {
      identical: added.length === 0 && removed.length === 0 && changed.length === 0,
      byteIdentical: String(oldText) === String(newText),
      added: added,
      removed: removed,
      changed: changed,
      counts: { added: added.length, removed: removed.length, changed: changed.length }
    };
  }

  /* ------------------------------------------------------------------ api */

  var API = {
    TZID: TZID,
    LANGS: LANGS,
    VTIMEZONE: VTIMEZONE,
    LEGACY_EOL: LEGACY_EOL,
    pad: pad,
    esc: esc,
    unesc: unesc,
    fold: fold,
    unfold: unfold,
    icsDate: icsDate,
    icsDateTime: icsDateTime,
    icsStamp: icsStamp,
    uidSeq: uidSeq,
    uidPrefix: uidPrefix,
    nextUid: nextUid,
    ensureUids: ensureUids,
    effective: effective,
    overrideSummary: overrideSummary,
    timeRange: timeRange,
    publishesTo: publishesTo,
    schedulesOf: schedulesOf,
    feedCount: feedCount,
    scheduleByKey: scheduleByKey,
    feedFiles: feedFiles,
    generateFeed: generateFeed,
    generateAll: generateAll,
    parse: parse,
    validate: validate,
    diff: diff
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
  global.ICS = API;
}(typeof window !== 'undefined' ? window : this));
