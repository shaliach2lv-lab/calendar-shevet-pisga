/* ============================================================================
 *  Shevet Pisga  -  Admin Calendar
 *  admin/app.js
 *
 *  One master event  ->  six published feeds.
 *  Reads data/events.json, edits everything in memory, and regenerates the
 *  six .ics files through admin/ics.js.  Nothing is ever written to the live
 *  feeds from here unless publishing is explicitly switched on in Settings.
 * ========================================================================== */
(function () {
  'use strict';

  var ICS = window.ICS;

  /* ---------------------------------------------------------- dom helpers */

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (txt != null) { n.textContent = txt; }
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function on(n, e, f, o) { if (n) { n.addEventListener(e, f, o); } }
  function clear(n) { while (n && n.firstChild) { n.removeChild(n.firstChild); } }
  function ico(d) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  /* ------------------------------------------------------- colour helpers */

  function rgb(hex) {
    var h = String(hex || '#94a3b8').replace('#', '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function tint(hex, a) {
    var c = rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function shade(hex, f) {
    var c = rgb(hex).map(function (v) { return Math.max(0, Math.min(255, Math.round(v * f))); });
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  /* ------------------------------------------------------------ constants */

  var DATA_URL = '../data/events.json';
  var LS_DRAFT = 'pisga.admin.draft.v1';
  var LS_PREFS = 'pisga.admin.prefs.v1';

  /* ------------------------------------------------- publishing guardrails */
  /* Live publishing is deliberately narrow. One repository, one branch, six
     file names. Anything outside this list is refused locally, before a
     request is ever made, so neither a bug nor a bad paste can touch another
     file in the repo. */

  var PUBLISH_REPO = 'shaliach2lv-lab/calendar-shevet-pisga';
  var PUBLISH_BRANCH = 'main';
  var PUBLISH_ALLOW = [
    'unique-pisga.ics', 'unique-pisga-en.ics',
    'unique-tet.ics', 'unique-tet-en.ics',
    'unique-shchavag.ics', 'unique-shchavag-en.ics'
  ];
  function allowedFile(name) { return PUBLISH_ALLOW.indexOf(String(name)) >= 0; }

  /* The master database is written by the very same commit as the feeds, so a
     bumped SEQUENCE can never be lost with a cleared browser. It is the only
     path outside the six feeds this app may ever write, and it is spelled out
     here so the whole write surface stays readable in one place. */
  var PUBLISH_DB = 'data/events.json';
  function writablePath(p) { return allowedFile(p) || String(p) === PUBLISH_DB; }

  /* --------------------------------------------------- credential hygiene */
  /* The GitHub token lives in exactly one place: S.token, in memory, for the
     life of this tab. It is never written to localStorage or sessionStorage,
     never placed in a URL, never saved into events.json, never committed and
     never printed. scrub() is the last line of defence: anything that comes
     back from the API and is shown to the operator goes through it first. */

  function scrub(s) {
    return String(s == null ? '' : s)
      .replace(/gh[pousr]_[A-Za-z0-9]{6,}/g, '[redacted]')
      .replace(/github_pat_[A-Za-z0-9_]{6,}/g, '[redacted]');
  }

  /* Older tools left credential-looking entries in this browser's storage.
     We only ever look at the key NAMES so the value is never read, never
     shown and never reusable by this app, and we offer to forget them. */
  var CRED_KEY_HINT = /(tok|pat|secret|passwd|password|auth|cred)/i;
  function foreignCredKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('pisga.admin.') !== 0 && CRED_KEY_HINT.test(k)) { out.push(k); }
      }
      for (var j = 0; j < sessionStorage.length; j++) {
        var sk = sessionStorage.key(j);
        if (sk && CRED_KEY_HINT.test(sk)) { out.push(sk); }
      }
    } catch (e) { /* storage unavailable - nothing to report */ }
    return out;
  }
  function forgetCredKey(k) {
    try { localStorage.removeItem(k); } catch (e) {}
    try { sessionStorage.removeItem(k); } catch (e) {}
  }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['January', 'February', 'March', 'April', 'May', 'June',
             'July', 'August', 'September', 'October', 'November', 'December'];
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var DAY_START = 7 * 60;
  var DAY_END = 23 * 60;
  var PX_PER_MIN = 0.78;
  var SNAP = 15;
  var GUTTER = 56;

  /* ------------------------------------------- wall clock date arithmetic */
  /*  Everything in the database is Los Angeles wall time with no offset, so
      all maths happens on plain strings anchored to UTC midnight.  That keeps
      the operator's own browser timezone out of the picture entirely.       */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dnum(k) { return { y: +k.slice(0, 4), m: +k.slice(5, 7), d: +k.slice(8, 10) }; }
  function dkey(iso) { return String(iso || '').slice(0, 10); }
  function tpart(iso) { var s = String(iso || ''); return s.length > 10 ? s.slice(11, 16) : ''; }
  function mins(iso) { var t = tpart(iso); return t ? (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)) : 0; }
  function utc(k) { var p = dnum(k); return Date.UTC(p.y, p.m - 1, p.d); }
  function keyOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(k, n) { return keyOf(utc(k) + n * 86400000); }
  function diffDays(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }
  function dow(k) { return new Date(utc(k)).getUTCDay(); }
  function startOfWeek(k) { return addDays(k, -dow(k)); }
  function startOfMonth(k) { return k.slice(0, 8) + '01'; }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addMonths(k, n) {
    var p = dnum(k), t = p.m - 1 + n, y = p.y + Math.floor(t / 12);
    var m = ((t % 12) + 12) % 12;
    return y + '-' + pad2(m + 1) + '-' + pad2(Math.min(p.d, daysInMonth(y, m + 1)));
  }
  function todayKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }
  function nowMins() {
    var s = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour12: false });
    return (+s.slice(0, 2)) * 60 + (+s.slice(3, 5));
  }
  function isoAt(k, m) {
    var d = k, mm = m;
    while (mm >= 1440) { d = addDays(d, 1); mm -= 1440; }
    while (mm < 0) { d = addDays(d, -1); mm += 1440; }
    return d + 'T' + pad2(Math.floor(mm / 60)) + ':' + pad2(mm % 60) + ':00';
  }
  function fmtT(m) {
    var h = Math.floor(m / 60) % 24, mm = m % 60, ap = h >= 12 ? 'PM' : 'AM', hh = h % 12;
    if (hh === 0) { hh = 12; }
    return hh + (mm ? ':' + pad2(mm) : '') + ' ' + ap;
  }
  function fmtT2(m) {
    var h = Math.floor(m / 60) % 24, mm = m % 60, ap = h >= 12 ? 'PM' : 'AM', hh = h % 12;
    if (hh === 0) { hh = 12; }
    return hh + ':' + pad2(mm) + ' ' + ap;
  }
  function fmtRange(a, b) { return fmtT(a) + ' - ' + fmtT(b); }
  function prettyDate(k) { var p = dnum(k); return DOW[dow(k)] + ', ' + MONS[p.m - 1] + ' ' + p.d + ', ' + p.y; }
  function prettyShort(k) { var p = dnum(k); return MONS[p.m - 1] + ' ' + p.d; }

  /* ---------------------------------------------------------------- state */

  var S = {
    db: null,
    view: 'month',
    screen: 'calendar',
    cursor: todayKey(),
    miniCursor: startOfMonth(todayKey()),
    lang: 'all',
    q: '',
    sched: {},
    flags: { archived: false, dirtyOnly: false, multiOnly: false },
    solo: null,
    selected: {},
    editingId: null,
    draft: null,
    history: [],
    dirty: {},
    gen: null,
    live: null,
    token: '',
    publishEnabled: false,
    tokenKind: ''
  };

  /* --------------------------------------------------------- undo history */

  function snap() { return JSON.stringify({ e: S.db.events, d: S.dirty }); }

  function commit(label) {
    S.history.push({ label: label, s: snap() });
    if (S.history.length > 80) { S.history.shift(); }
    syncBadges();
  }

  function undo() {
    if (!S.history.length) { toast('Nothing to undo'); return; }
    var h = S.history.pop();
    var st = JSON.parse(h.s);
    S.db.events = st.e;
    S.dirty = st.d;
    S.gen = null;
    S.genDb = null;
    if (S.editingId && !byId(S.editingId)) { closeEditor(); }
    else if (S.editingId) { S.draft = JSON.parse(JSON.stringify(byId(S.editingId))); renderEditor(); }
    saveDraft();
    renderAll();
    toast('Undone - ' + h.label, 'ok');
  }

  function dirtyCount() { return Object.keys(S.dirty).length; }
  function markDirty(id) { S.dirty[id] = true; S.gen = null; S.genDb = null; }

  function syncBadges() {
    var u = $('#btnUndo'); if (u) { u.disabled = S.history.length === 0; }
    var d = $('#navDot'); if (d) { d.hidden = dirtyCount() === 0; }
  }

  /* -------------------------------------------------------- local storage */

  function saveDraft() {
    try {
      localStorage.setItem(LS_DRAFT, JSON.stringify({
        at: new Date().toISOString(), events: S.db.events, dirty: S.dirty
      }));
    } catch (e) { /* over quota - not fatal, the draft is a convenience */ }
  }
  function readDraft() {
    try { return JSON.parse(localStorage.getItem(LS_DRAFT) || 'null'); } catch (e) { return null; }
  }
  function dropDraft() { try { localStorage.removeItem(LS_DRAFT); } catch (e) {} }

  function savePrefs() {
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify({
        view: S.view, lang: S.lang, sched: S.sched, flags: S.flags
      }));
    } catch (e) {}
  }
  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_PREFS) || 'null'); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- toast */

  function toast(msg, kind, ms) {
    var host = $('#toaster'); if (!host) { return; }
    var t = el('div', 'toast' + (kind === 'err' ? ' err' : ''));
    t.appendChild(el('div', 'toast-msg', msg));
    host.appendChild(t);
    var life = ms || (kind === 'err' ? 5200 : 2800);
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, life);
    setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, life + 320);
  }

  /* --------------------------------------------------------------- modals */

  function modal(o) {
    var root = $('#modalRoot');
    clear(root);
    root.hidden = false;
    requestAnimationFrame(function () { root.classList.add('show'); });
    var m = el('div', 'modal' + (o.wide ? ' wide' : ''));
    var h = el('div', 'modal-h');
    h.appendChild(el('div', 'modal-t', o.title));
    if (o.sub) { h.appendChild(el('div', 'modal-s', o.sub)); }
    m.appendChild(h);
    var b = el('div', 'modal-b');
    if (typeof o.body === 'string') { b.innerHTML = o.body; } else if (o.body) { b.appendChild(o.body); }
    m.appendChild(b);
    var f = el('div', 'modal-f');
    (o.actions || []).forEach(function (a) {
      var btn = el('button', 'btn ' + (a.cls || 'btn-ghost'), a.label);
      on(btn, 'click', function () {
        if (a.close !== false) { closeModal(); }
        if (a.fn) { a.fn(); }
      });
      f.appendChild(btn);
    });
    m.appendChild(f);
    root.appendChild(m);
    root.onclick = function (e) { if (e.target === root) { closeModal(); } };
    return m;
  }

  function closeModal() {
    var r = $('#modalRoot');
    if (!r) { return; }
    r.classList.remove('show');
    setTimeout(function () { r.hidden = true; clear(r); }, 150);
  }

  function confirmDialog(title, sub, bodyHtml, okLabel, okCls, fn) {
    modal({
      title: title, sub: sub, body: bodyHtml,
      actions: [
        { label: 'Cancel', cls: 'btn-ghost' },
        { label: okLabel, cls: okCls || 'btn-accent', fn: fn }
      ]
    });
  }

  /* -------------------------------------------------------- event helpers */

  function scheds() { return (S.db && S.db.schedules) || []; }

  function schedOf(k) {
    var l = scheds();
    for (var i = 0; i < l.length; i++) { if (l[i].key === k) { return l[i]; } }
    return null;
  }
  function byId(id) {
    var l = (S.db && S.db.events) || [];
    for (var i = 0; i < l.length; i++) { if (l[i].id === id) { return l[i]; } }
    return null;
  }
  function pubScheds(ev) {
    return scheds().filter(function (s) {
      var p = ev.publications && ev.publications[s.key];
      return !!(p && (p.he || p.en));
    });
  }
  function feedsOf(ev) {
    var out = [];
    scheds().forEach(function (s) {
      ['he', 'en'].forEach(function (l) {
        var p = ev.publications && ev.publications[s.key];
        if (p && p[l]) { out.push({ schedule: s, lang: l, file: s.feeds[l].file, uid: (ev.uids || {})[s.key] }); }
      });
    });
    return out;
  }
  function titleOf(ev) {
    var t = ev.title || {};
    return (S.lang === 'en' ? (t.en || t.he) : (t.he || t.en)) || 'Untitled';
  }
  function altOf(ev) {
    var t = ev.title || {};
    var other = S.lang === 'en' ? t.he : t.en;
    return (other && other !== titleOf(ev)) ? other : '';
  }
  function isRtl(s) { return /[\u0590-\u05FF]/.test(String(s || '')); }

  /*  view() resolves the times we should DISPLAY.  When exactly one schedule
      is switched on we show that schedule's real (overridden) time, so the
      calendar never lies about what a subscriber actually receives.        */
  function view(ev) {
    if (S.solo) {
      var e = ICS.effective(ev, S.solo);
      return { start: e.start, end: e.end, allDay: e.allDay };
    }
    return { start: ev.start, end: ev.end, allDay: !!ev.allDay };
  }
  function span(ev) {
    var v = view(ev);
    var s = dkey(v.start);
    var e = dkey(v.end || v.start);
    if (v.allDay) { e = addDays(e, -1); if (diffDays(s, e) < 0) { e = s; } }
    return { s: s, e: e, v: v };
  }
  function primary(ev) { var l = pubScheds(ev); return l.length ? l[0].color : '#94a3b8'; }
  function rail(ev) {
    var l = pubScheds(ev);
    if (l.length < 2) { return l.length ? l[0].color : '#94a3b8'; }
    var st = [];
    l.forEach(function (s, i) {
      st.push(s.color + ' ' + (i * 100 / l.length).toFixed(3) + '%');
      st.push(s.color + ' ' + ((i + 1) * 100 / l.length).toFixed(3) + '%');
    });
    return 'linear-gradient(180deg,' + st.join(',') + ')';
  }
  function dots(ev) {
    return pubScheds(ev).map(function (s) {
      return '<i class="chip-dot" style="background:' + s.color + '"></i>';
    }).join('');
  }
  function chipVars(ev) {
    var c = primary(ev);
    return '--rail:' + rail(ev) + ';--chip-bg:' + tint(c, 0.13) +
           ';--chip-solid:' + c + ';--chip-ink:' + shade(c, 0.6) +
           ';--chip-ink-2:' + shade(c, 0.82);
  }
  function overrideKeys(ev) { return Object.keys(ev.overrides || {}); }
  function hasOverride(ev) { return overrideKeys(ev).length > 0; }
  function archived(ev) { return ev.status === 'archived' || ev.status === 'cancelled'; }

  /* ------------------------------------------------------------ filtering */

  function schedOn(k) { return S.sched[k] !== false; }

  function computeSolo() {
    var lit = scheds().filter(function (s) { return schedOn(s.key); });
    S.solo = (lit.length === 1) ? lit[0].key : null;
  }

  function matches(ev) {
    if (!S.flags.archived && archived(ev)) { return false; }
    if (S.flags.dirtyOnly && !S.dirty[ev.id]) { return false; }
    var list = pubScheds(ev);
    if (S.flags.multiOnly && list.length < 2) { return false; }
    var lit = list.filter(function (s) { return schedOn(s.key); });
    if (!lit.length) { return false; }
    if (S.lang !== 'all') {
      var ok = lit.some(function (s) { return !!ev.publications[s.key][S.lang]; });
      if (!ok) { return false; }
    }
    if (S.q) {
      var t = ev.title || {}, d = ev.description || {}, lo = ev.location || {};
      var hay = [t.he, t.en, d.he, d.en, lo.he, lo.en, ev.notes, ev.category, ev.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(S.q) < 0) { return false; }
    }
    return true;
  }

  function visible() { return ((S.db && S.db.events) || []).filter(matches); }

  function activeFilters() {
    var n = 0;
    scheds().forEach(function (s) { if (!schedOn(s.key)) { n++; } });
    if (S.lang !== 'all') { n++; }
    if (S.flags.archived) { n++; }
    if (S.flags.dirtyOnly) { n++; }
    if (S.flags.multiOnly) { n++; }
    return n;
  }

  function sortEv(a, b) {
    var va = view(a), vb = view(b);
    if (!!va.allDay !== !!vb.allDay) { return va.allDay ? -1 : 1; }
    if (va.start !== vb.start) { return va.start < vb.start ? -1 : 1; }
    return titleOf(a).localeCompare(titleOf(b));
  }

  function eventsOn(key, pool) {
    return (pool || visible()).filter(function (ev) {
      var sp = span(ev);
      return diffDays(sp.s, key) >= 0 && diffDays(key, sp.e) >= 0;
    }).sort(sortEv);
  }

  /*  Simple greedy lane packing for overlapping timed events.              */
  function packLanes(items) {
    var lanes = [];
    items.forEach(function (it) {
      var placed = false;
      for (var i = 0; i < lanes.length && !placed; i++) {
        if (lanes[i][lanes[i].length - 1].e <= it.s) { lanes[i].push(it); it.lane = i; placed = true; }
      }
      if (!placed) { it.lane = lanes.length; lanes.push([it]); }
    });
    items.forEach(function (it) { it.lanes = lanes.length; });
    return lanes.length;
  }

  /* ----------------------------------------------------------- sidebar ui */

  var CHECK = '<path d="m5 12 4.5 4.5L19 7"/>';

  function renderSidebar() {
    var host = $('#fSchedules');
    if (!host) { return; }
    clear(host);
    scheds().forEach(function (s) {
      var count = (S.db.events || []).filter(function (ev) {
        var p = ev.publications && ev.publications[s.key];
        return !!(p && (p.he || p.en)) && !archived(ev);
      }).length;
      var lab = el('label', 'frow');
      lab.title = 'Double-click to show only this schedule';
      lab.innerHTML =
        '<input type="checkbox"' + (schedOn(s.key) ? ' checked' : '') + '>' +
        '<span class="swatch" style="--sc:' + s.color + '">' + ico(CHECK) + '</span>' +
        '<span class="frow-label">' + esc(s.name.he) + '</span>' +
        '<span class="frow-count">' + count + '</span>';
      on(lab.querySelector('input'), 'change', function (e) {
        S.sched[s.key] = e.target.checked;
        savePrefs(); renderAll();
      });
      on(lab, 'dblclick', function (e) {
        e.preventDefault();
        scheds().forEach(function (o) { S.sched[o.key] = (o.key === s.key); });
        savePrefs(); renderAll();
        toast(s.name.en + ' only - showing the times this schedule really publishes');
      });
      host.appendChild(lab);
    });

    var flags = $('#fFlags');
    clear(flags);
    [['archived', 'Archived'], ['dirtyOnly', 'Unpublished changes'], ['multiOnly', 'In 2 or more schedules']]
      .forEach(function (f) {
        var lab = el('label', 'frow');
        lab.innerHTML =
          '<input type="checkbox"' + (S.flags[f[0]] ? ' checked' : '') + '>' +
          '<span class="swatch" style="--sc:var(--ink-2)">' + ico(CHECK) + '</span>' +
          '<span class="frow-label">' + f[1] + '</span>';
        on(lab.querySelector('input'), 'change', function (e) {
          S.flags[f[0]] = e.target.checked; savePrefs(); renderAll();
        });
        flags.appendChild(lab);
      });

    $$('#fLang button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang') === S.lang);
    });

    var fc = $('#filterCount');
    var n = activeFilters();
    if (fc) { fc.hidden = n === 0; fc.textContent = String(n); }

    var fm = $('#feedMini');
    clear(fm);
    ICS.feedFiles(S.db).forEach(function (f) {
      var s = schedOf(f.schedule);
      var row = el('div', 'frow');
      row.style.cursor = 'default';
      row.innerHTML =
        '<span class="pub-dot" style="background:' + s.color + '"></span>' +
        '<span class="frow-label mono" style="font-size:10.4px">' + esc(f.file) + '</span>';
      fm.appendChild(row);
    });
  }

  /* -------------------------------------------------------- mini calendar */

  function renderMini() {
    var host = $('#mini');
    if (!host) { return; }
    clear(host);
    var cur = S.miniCursor, p = dnum(cur);
    var head = el('div', 'mini-head');
    head.innerHTML =
      '<div class="mini-title">' + MON[p.m - 1] + ' ' + p.y + '</div>' +
      '<div class="mini-nav">' +
        '<button data-mv="-1" aria-label="Previous month">' + ico('<path d="m15 18-6-6 6-6"/>') + '</button>' +
        '<button data-mv="1" aria-label="Next month">' + ico('<path d="m9 18 6-6-6-6"/>') + '</button>' +
      '</div>';
    host.appendChild(head);
    $$('button', head).forEach(function (b) {
      on(b, 'click', function () {
        S.miniCursor = addMonths(S.miniCursor, +b.getAttribute('data-mv'));
        renderMini();
      });
    });

    var grid = el('div', 'mini-grid');
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { grid.appendChild(el('div', 'mini-dow', d)); });

    var busy = {};
    visible().forEach(function (ev) {
      var sp = span(ev);
      for (var k = sp.s; diffDays(k, sp.e) >= 0; k = addDays(k, 1)) { busy[k] = 1; }
    });

    var first = startOfWeek(startOfMonth(cur));
    var tk = todayKey();
    for (var i = 0; i < 42; i++) {
      var k = addDays(first, i), kp = dnum(k);
      var b = el('button', 'mini-day', String(kp.d));
      if (kp.m !== p.m) { b.classList.add('out'); }
      if (k === tk) { b.classList.add('today'); }
      if (k === S.cursor) { b.classList.add('sel'); }
      if (busy[k]) { b.classList.add('has'); }
      (function (kk) {
        on(b, 'click', function () {
          S.cursor = kk;
          gotoScreen('calendar');
          renderAll();
        });
      }(k));
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }

  /* --------------------------------------------------------------- toolbar */

  function rangeOfView() {
    if (S.view === 'month') {
      var f = startOfWeek(startOfMonth(S.cursor));
      return { from: f, to: addDays(f, 41) };
    }
    if (S.view === 'week') { var w = startOfWeek(S.cursor); return { from: w, to: addDays(w, 6) }; }
    if (S.view === 'day') { return { from: S.cursor, to: S.cursor }; }
    return { from: S.cursor, to: addDays(S.cursor, 60) };
  }

  function renderToolbar() {
    var p = dnum(S.cursor), label = '';
    if (S.view === 'month') { label = MON[p.m - 1] + ' ' + p.y; }
    else if (S.view === 'week') {
      var a = startOfWeek(S.cursor), b = addDays(a, 6), pa = dnum(a), pb = dnum(b);
      label = (pa.m === pb.m)
        ? MON[pa.m - 1] + ' ' + pa.d + ' - ' + pb.d + ', ' + pb.y
        : MONS[pa.m - 1] + ' ' + pa.d + ' - ' + MONS[pb.m - 1] + ' ' + pb.d + ', ' + pb.y;
    } else if (S.view === 'day') { label = DOWL[dow(S.cursor)] + ', ' + MON[p.m - 1] + ' ' + p.d + ', ' + p.y; }
    else { label = 'Agenda from ' + prettyShort(S.cursor); }
    var t = $('#tbTitle'); if (t) { t.textContent = label; }

    var r = rangeOfView();
    var inRange = visible().filter(function (ev) {
      var sp = span(ev);
      return diffDays(sp.s, r.to) >= 0 && diffDays(r.from, sp.e) >= 0;
    });
    var sum = $('#tbSummary');
    if (sum) {
      var bits = [inRange.length + (inRange.length === 1 ? ' event' : ' events')];
      if (S.solo) { bits.push(schedOf(S.solo).name.en + ' times'); }
      if (dirtyCount()) { bits.push(dirtyCount() + ' unpublished'); }
      sum.textContent = bits.join('  -  ');
    }
    $$('#viewSeg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === S.view);
    });
  }

  /* ------------------------------------------------------------ event chip */

  function chipNode(ev, dayKey) {
    var sp = span(ev), v = sp.v;
    var c = el('div', 'chip');
    c.setAttribute('style', chipVars(ev));
    c.dataset.id = ev.id;
    c.dataset.day = dayKey;
    if (v.allDay) { c.classList.add('allday'); }
    if (archived(ev)) { c.classList.add('cancelled'); }
    if (S.dirty[ev.id]) { c.classList.add('dirty'); }
    if (S.editingId === ev.id) { c.classList.add('sel'); }

    var multi = diffDays(sp.s, sp.e) > 0;
    var head = (multi && dayKey !== sp.s) ? '\u2039 ' : '';
    var tail = (multi && dayKey !== sp.e) ? ' \u203A' : '';

    var html = '';
    if (!v.allDay && dayKey === sp.s) {
      html += '<span class="chip-time">' + fmtT(mins(v.start)) + '</span>';
    }
    html += '<span class="chip-title" dir="' + (isRtl(titleOf(ev)) ? 'rtl' : 'ltr') + '">' +
            esc(head + titleOf(ev) + tail) + '</span>';
    html += '<span class="chip-dots">' + dots(ev) + '</span>';
    c.innerHTML = html;
    c.title = tooltip(ev);
    if (!v.allDay || multi) { c.setAttribute('data-drag', '1'); }
    else { c.setAttribute('data-drag', '1'); }
    return c;
  }

  function tooltip(ev) {
    var v = view(ev), lines = [titleOf(ev)];
    var alt = altOf(ev);
    if (alt) { lines.push(alt); }
    if (v.allDay) {
      var sp = span(ev);
      lines.push(sp.s === sp.e ? 'All day - ' + prettyDate(sp.s)
                               : 'All day - ' + prettyShort(sp.s) + ' to ' + prettyShort(sp.e));
    } else {
      lines.push(prettyDate(dkey(v.start)) + '   ' + fmtT2(mins(v.start)) + ' - ' + fmtT2(mins(v.end)));
    }
    lines.push(pubScheds(ev).map(function (s) { return s.name.en; }).join(' + ') +
               '  (' + ICS.feedCount(ev) + ' feeds)');
    overrideKeys(ev).forEach(function (k) {
      var e = ICS.effective(ev, k);
      if (!ev.overrides[k].start && !ev.overrides[k].end) { return; }
      lines.push(schedOf(k).name.en + ' override: ' + fmtT2(mins(e.start)) + ' - ' + fmtT2(mins(e.end)));
    });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ month view */

  function renderMonth(host) {
    var wrap = el('div', 'month');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.flex = '1';
    wrap.style.minHeight = '0';

    var hd = el('div', 'month-dow');
    for (var i = 0; i < 7; i++) {
      var d = el('div', 'mcell-h' + (i === 0 || i === 6 ? ' we' : ''));
      d.style.justifyContent = 'center';
      d.appendChild(el('span', '', DOW[i]));
      hd.appendChild(d);
    }
    wrap.appendChild(hd);

    var grid = el('div', 'month-grid');
    grid.style.flex = '1';
    grid.style.minHeight = '0';
    grid.style.overflowY = 'auto';

    var first = startOfWeek(startOfMonth(S.cursor));
    var month = dnum(S.cursor).m;
    var tk = todayKey();
    var pool = visible();

    for (var w = 0; w < 6; w++) {
      var row = el('div', 'month-week');
      for (var i2 = 0; i2 < 7; i2++) {
        var k = addDays(first, w * 7 + i2);
        var kp = dnum(k);
        var cell = el('div', 'mcell');
        cell.dataset.day = k;
        cell.setAttribute('data-drop', 'day');
        if (kp.m !== month) { cell.classList.add('out'); }
        if (i2 === 0 || i2 === 6) { cell.classList.add('we'); }
        if (k === tk) { cell.classList.add('today'); }

        var h = el('div', 'mcell-h');
        var num = el('div', 'mnum', (kp.d === 1 ? MONS[kp.m - 1] + ' ' : '') + kp.d);
        h.appendChild(num);
        var add = el('button', 'mcell-add');
        add.innerHTML = ico('<path d="M12 5v14M5 12h14"/>');
        add.title = 'New event on ' + prettyDate(k);
        (function (kk) { on(add, 'click', function (e) { e.stopPropagation(); createEvent(kk, 14 * 60); }); }(k));
        h.appendChild(add);
        cell.appendChild(h);

        eventsOn(k, pool).forEach(function (ev) { cell.appendChild(chipNode(ev, k)); });
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    wrap.appendChild(grid);
    host.appendChild(wrap);
    requestAnimationFrame(function () { collapseOverflow(grid); });
  }

  function collapseOverflow(grid) {
    $$('.mcell', grid).forEach(function (cell) {
      var chips = $$('.chip', cell);
      chips.forEach(function (c) { c.style.display = ''; });
      var old = cell.querySelector('.more');
      if (old) { old.parentNode.removeChild(old); }
      if (!chips.length) { return; }
      var head = cell.querySelector('.mcell-h');
      var room = cell.clientHeight - (head ? head.offsetHeight : 0) - 10;
      var ch = chips[0].offsetHeight + 3;
      var fit = Math.max(1, Math.floor(room / ch));
      if (chips.length <= fit) { return; }
      var keep = fit - 1;
      var hidden = chips.length - keep;
      chips.forEach(function (c, i) { if (i >= keep) { c.style.display = 'none'; } });
      var more = el('button', 'more', '+' + hidden + ' more');
      var day = cell.dataset.day;
      on(more, 'click', function (e) { e.stopPropagation(); dayPeek(day); });
      cell.appendChild(more);
    });
  }

  function dayPeek(day) {
    var list = eventsOn(day);
    var box = el('div', '');
    list.forEach(function (ev) {
      var v = view(ev);
      var r = el('div', 'impact-row');
      r.innerHTML =
        '<span class="pub-dot" style="background:' + primary(ev) + '"></span>' +
        '<span style="flex:0 0 96px;color:var(--ink-3);font-size:11.5px">' +
          (v.allDay ? 'All day' : fmtT2(mins(v.start))) + '</span>' +
        '<span style="flex:1" dir="auto">' + esc(titleOf(ev)) + '</span>';
      r.style.cursor = 'pointer';
      on(r, 'click', function () { closeModal(); openEditor(ev.id); });
      box.appendChild(r);
    });
    modal({
      title: prettyDate(day),
      sub: list.length + (list.length === 1 ? ' event' : ' events'),
      body: box,
      actions: [
        { label: 'Open day view', cls: 'btn-outline', fn: function () { S.cursor = day; setView('day'); } },
        { label: 'Close', cls: 'btn-ghost' }
      ]
    });
  }

  /* ------------------------------------------------------- week / day view */

  function renderTimeGrid(host, days) {
    var cols = 'var(--gut) repeat(' + days.length + ',minmax(0,1fr))';
    var tg = el('div', 'tg');
    tg.style.setProperty('--gut', GUTTER + 'px');
    var tk = todayKey();
    var pool = visible();

    var head = el('div', 'tg-head');
    head.style.gridTemplateColumns = cols;
    head.appendChild(el('div', 'tg-corner'));
    days.forEach(function (k) {
      var p = dnum(k);
      var h = el('div', 'tg-dayh' + (k === tk ? ' today' : ''));
      h.innerHTML = '<div class="tg-dow">' + DOW[dow(k)] + '</div><div class="tg-dnum">' + p.d + '</div>';
      on(h, 'click', function () { S.cursor = k; setView('day'); });
      h.style.cursor = 'pointer';
      head.appendChild(h);
    });
    tg.appendChild(head);

    var ad = el('div', 'tg-allday');
    ad.style.gridTemplateColumns = cols;
    ad.appendChild(el('div', 'tg-allday-lbl', 'All day'));
    days.forEach(function (k) {
      var col = el('div', 'tg-allday-col');
      col.dataset.day = k;
      col.setAttribute('data-drop', 'day');
      eventsOn(k, pool).filter(function (ev) { return view(ev).allDay; })
        .forEach(function (ev) { col.appendChild(chipNode(ev, k)); });
      ad.appendChild(col);
    });
    tg.appendChild(ad);

    var body = el('div', 'tg-body');
    var inner = el('div', 'tg-inner');
    inner.style.gridTemplateColumns = cols;
    var height = (DAY_END - DAY_START) * PX_PER_MIN;
    inner.style.height = height + 'px';

    var gut = el('div', 'tg-gutter');
    for (var m = DAY_START; m <= DAY_END; m += 60) {
      var lab = el('div', 'tg-hour', fmtT(m));
      lab.style.top = ((m - DAY_START) * PX_PER_MIN) + 'px';
      gut.appendChild(lab);
    }
    inner.appendChild(gut);

    days.forEach(function (k) {
      var col = el('div', 'tg-col' + (k === tk ? ' today' : ''));
      col.dataset.day = k;
      col.setAttribute('data-drop', 'time');
      for (var m2 = DAY_START; m2 <= DAY_END; m2 += 30) {
        var ln = el('div', 'tg-line' + (m2 % 60 ? ' half' : ''));
        ln.style.top = ((m2 - DAY_START) * PX_PER_MIN) + 'px';
        col.appendChild(ln);
      }
      if (k === tk) {
        var nm = nowMins();
        if (nm >= DAY_START && nm <= DAY_END) {
          var nl = el('div', 'tg-now');
          nl.style.top = ((nm - DAY_START) * PX_PER_MIN) + 'px';
          col.appendChild(nl);
        }
      }

      var items = eventsOn(k, pool).filter(function (ev) { return !view(ev).allDay; })
        .map(function (ev) {
          var v = view(ev);
          var s0 = (dkey(v.start) === k) ? mins(v.start) : 0;
          var e0 = (dkey(v.end) === k) ? mins(v.end) : 1440;
          if (e0 <= s0) { e0 = s0 + 30; }
          return { ev: ev, s: s0, e: e0 };
        });
      items.sort(function (a, b) { return a.s - b.s || b.e - a.e; });
      packLanes(items);

      items.forEach(function (it) {
        var top = (Math.max(DAY_START, it.s) - DAY_START) * PX_PER_MIN;
        var hgt = Math.max(17, (Math.min(DAY_END, it.e) - Math.max(DAY_START, it.s)) * PX_PER_MIN);
        var n = el('div', 'tev');
        n.setAttribute('style', chipVars(it.ev));
        n.style.top = top + 'px';
        n.style.height = hgt + 'px';
        var wpc = 100 / it.lanes;
        n.style.left = 'calc(' + (it.lane * wpc) + '% + 2px)';
        n.style.width = 'calc(' + wpc + '% - 5px)';
        n.dataset.id = it.ev.id;
        n.dataset.day = k;
        n.setAttribute('data-drag', '1');
        if (archived(it.ev)) { n.classList.add('cancelled'); }
        if (S.dirty[it.ev.id]) { n.classList.add('dirty'); }
        if (S.editingId === it.ev.id) { n.classList.add('sel'); }
        n.innerHTML =
          '<div class="tev-t" dir="' + (isRtl(titleOf(it.ev)) ? 'rtl' : 'ltr') + '">' + esc(titleOf(it.ev)) + '</div>' +
          (hgt > 30 ? '<div class="tev-time">' + fmtT(it.s) + ' - ' + fmtT(it.e) + '</div>' : '') +
          '<div class="tev-dots">' + dots(it.ev) + '</div>' +
          '<div class="tev-handle" data-handle="1"></div>';
        n.title = tooltip(it.ev);
        col.appendChild(n);
      });

      (function (kk) {
        on(col, 'dblclick', function (e) {
          if (e.target.closest('.tev')) { return; }
          var rect = col.getBoundingClientRect();
          var m3 = DAY_START + Math.round(((e.clientY - rect.top) / PX_PER_MIN) / SNAP) * SNAP;
          createEvent(kk, Math.max(DAY_START, Math.min(DAY_END - 60, m3)));
        });
      }(k));

      inner.appendChild(col);
    });

    body.appendChild(inner);
    tg.appendChild(body);
    host.appendChild(tg);

    requestAnimationFrame(function () {
      var target = (nowMins() - DAY_START - 120) * PX_PER_MIN;
      body.scrollTop = Math.max(0, Math.min(target, height - body.clientHeight));
    });
  }

  /* ---------------------------------------------------------- agenda view */

  function renderAgenda(host) {
    var wrap = el('div', 'agenda scroll');
    var pool = visible().slice().sort(sortEv);
    var from = S.cursor;
    var groups = {};
    var order = [];
    pool.forEach(function (ev) {
      var sp = span(ev);
      if (diffDays(from, sp.e) < 0) { return; }
      var k = diffDays(from, sp.s) < 0 ? from : sp.s;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(ev);
    });
    order.sort();

    if (!order.length) {
      wrap.appendChild(el('div', 'ag-empty', 'No events match the current filters from ' + prettyDate(from) + ' onwards.'));
      host.appendChild(wrap);
      return;
    }

    var tk = todayKey();
    order.slice(0, 200).forEach(function (k) {
      var p = dnum(k);
      var day = el('div', 'ag-day' + (k === tk ? ' today' : ''));
      var date = el('div', 'ag-date');
      date.innerHTML =
        '<div class="ag-dow">' + DOW[dow(k)] + '</div>' +
        '<div class="ag-dnum">' + p.d + '</div>' +
        '<div class="ag-mon">' + MONS[p.m - 1] + " '" + String(p.y).slice(2) + '</div>';
      day.appendChild(date);
      var list = el('div', 'ag-list');
      groups[k].sort(sortEv).forEach(function (ev) {
        var v = view(ev);
        var it = el('div', 'ag-item');
        it.dataset.id = ev.id;
        var r = el('div', 'ag-rail');
        r.style.background = rail(ev);
        it.appendChild(r);
        var when = el('div', 'ag-when', v.allDay ? 'All day' : fmtT2(mins(v.start)) + '\n' + fmtT2(mins(v.end)));
        when.style.whiteSpace = 'pre-line';
        it.appendChild(when);
        var bodyb = el('div', 'ag-body');
        var t1 = el('div', 'ag-title', titleOf(ev));
        t1.setAttribute('dir', isRtl(titleOf(ev)) ? 'rtl' : 'ltr');
        bodyb.appendChild(t1);
        if (altOf(ev)) {
          var t2 = el('div', 'ag-title-alt', altOf(ev));
          t2.setAttribute('dir', isRtl(altOf(ev)) ? 'rtl' : 'ltr');
          bodyb.appendChild(t2);
        }
        var meta = el('div', 'ag-meta');
        meta.innerHTML = stags(ev) + (S.dirty[ev.id] ? '<span class="pill pill-warn">unpublished</span>' : '') +
          (archived(ev) ? '<span class="pill pill-mute">archived</span>' : '') +
          (hasOverride(ev) ? '<span class="pill pill-accent">override</span>' : '');
        bodyb.appendChild(meta);
        it.appendChild(bodyb);
        on(it, 'click', function () { openEditor(ev.id); });
        list.appendChild(it);
      });
      day.appendChild(list);
      wrap.appendChild(day);
    });
    host.appendChild(wrap);
  }

  function stags(ev) {
    return scheds().map(function (s) {
      var p = (ev.publications || {})[s.key] || {};
      var lit = !!(p.he || p.en);
      return '<span class="stag' + (lit ? '' : ' off') + '" style="--tint:' + tint(s.color, lit ? 0.14 : 0.05) +
        ';--tone:' + shade(s.color, 0.62) + '"><i></i>' + esc(s.name.en.replace(' Schedule', '').replace(/ \(.*\)/, '')) +
        '<span class="langs"><span class="' + (p.he ? 'on' : '') + '">HE</span><span class="' + (p.en ? 'on' : '') + '">EN</span></span></span>';
    }).join('');
  }

  /* ------------------------------------------------------------- shell ui */

  function renderCal() {
    var host = $('#calHost');
    if (!host) { return; }
    clear(host);
    if (S.view === 'month') { renderMonth(host); }
    else if (S.view === 'week') {
      var w = startOfWeek(S.cursor), days = [];
      for (var i = 0; i < 7; i++) { days.push(addDays(w, i)); }
      renderTimeGrid(host, days);
    } else if (S.view === 'day') { renderTimeGrid(host, [S.cursor]); }
    else { renderAgenda(host); }
  }

  function setView(v) {
    S.view = v;
    if (v === 'month') { S.miniCursor = startOfMonth(S.cursor); }
    savePrefs();
    gotoScreen('calendar');
    renderAll();
  }

  function gotoScreen(name) {
    S.screen = name;
    $$('.screen').forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== name; });
    $$('.nav-item').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-screen') === name); });
    var fab = $('#fab'); if (fab) { fab.hidden = (name !== 'calendar' && name !== 'events'); }
  }

  function renderAll() {
    computeSolo();
    renderPubState();
    renderSidebar();
    renderMini();
    renderToolbar();
    if (S.screen === 'calendar') { renderCal(); }
    if (S.screen === 'events') { renderList(); }
    if (S.screen === 'schedules') { renderSchedules(); }
    if (S.screen === 'sync') { renderSync(); }
    if (S.screen === 'settings') { renderSettings(); }
    syncBadges();
  }

  function step(dir) {
    if (S.view === 'month') { S.cursor = addMonths(S.cursor, dir); S.miniCursor = startOfMonth(S.cursor); }
    else if (S.view === 'week') { S.cursor = addDays(S.cursor, 7 * dir); }
    else if (S.view === 'day') { S.cursor = addDays(S.cursor, dir); }
    else { S.cursor = addDays(S.cursor, 30 * dir); }
    renderAll();
  }

  /* ------------------------------------------------------------ mutations */

  function nowStamp() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

  function touch(ev, who) {
    ev.updatedAt = nowStamp();
    ev.updatedBy = who || 'admin-ui';
    markDirty(ev.id);
  }

  function newId() {
    var n = 0;
    (S.db.events || []).forEach(function (e) {
      var m = /^evt_(\d+)$/.exec(e.id || '');
      if (m) { n = Math.max(n, +m[1]); }
    });
    return 'evt_' + pad4(n + 1);
  }
  function pad4(n) { var s = String(n); while (s.length < 4) { s = '0' + s; } return s; }

  function blankEvent(day, m) {
    var pubs = {};
    scheds().forEach(function (s) { pubs[s.key] = { he: schedOn(s.key), en: schedOn(s.key) }; });
    if (!scheds().some(function (s) { return pubs[s.key].he; })) {
      scheds().forEach(function (s) { pubs[s.key] = { he: true, en: true }; });
    }
    return {
      id: newId(),
      title: { he: '', en: '' },
      description: { he: null, en: null },
      location: { he: null, en: null },
      allDay: false,
      start: isoAt(day, m),
      end: isoAt(day, m + 120),
      timezone: 'America/Los_Angeles',
      recurrence: null,
      category: null,
      color: null,
      status: 'published',
      link: null,
      notes: null,
      publications: pubs,
      uids: {},
      overrides: {},
      sequence: 0,
      createdAt: nowStamp(),
      updatedAt: nowStamp(),
      updatedBy: 'admin-ui'
    };
  }

  function createEvent(day, m) {
    var ev = blankEvent(day || S.cursor, m == null ? 14 * 60 : m);
    commit('create event');
    S.db.events.push(ev);
    ICS.ensureUids(S.db, ev);
    markDirty(ev.id);
    saveDraft();
    renderAll();
    openEditor(ev.id, true);
  }

  function duplicateEvent(id) {
    var src = byId(id);
    if (!src) { return; }
    var copy = JSON.parse(JSON.stringify(src));
    copy.id = newId();
    copy.uids = {};
    copy.sequence = 0;
    copy.createdAt = nowStamp();
    copy.updatedAt = nowStamp();
    copy.updatedBy = 'admin-ui';
    var t = copy.title || {};
    if (t.en) { t.en = t.en + ' (copy)'; }
    if (t.he) { t.he = t.he + ' - עותק'; }
    commit('duplicate event');
    S.db.events.push(copy);
    var minted = ICS.ensureUids(S.db, copy);
    markDirty(copy.id);
    saveDraft();
    renderAll();
    openEditor(copy.id, true);
    toast('Duplicated with ' + minted.length + ' brand new UIDs - the original keeps its own', 'ok');
  }

  function shiftISO(iso, days, minutesDelta) {
    if (!iso) { return iso; }
    if (String(iso).length <= 10) { return addDays(iso, days); }
    var k = addDays(dkey(iso), days);
    return isoAt(k, mins(iso) + (minutesDelta || 0));
  }

  /*  Moving a master event moves every schedule override with it, so a
      Shachbag 13:00 override stays 13:00 relative to the new day.          */
  function moveEvent(id, days, minutesDelta, label) {
    var ev = byId(id);
    if (!ev) { return; }
    if (!days && !minutesDelta) { return; }
    commit(label || 'move event');
    ev.start = shiftISO(ev.start, days, minutesDelta);
    ev.end = shiftISO(ev.end, days, minutesDelta);
    Object.keys(ev.overrides || {}).forEach(function (k) {
      var o = ev.overrides[k];
      if (o.start) { o.start = shiftISO(o.start, days, minutesDelta); }
      if (o.end) { o.end = shiftISO(o.end, days, minutesDelta); }
    });
    touch(ev);
    saveDraft();
    renderAll();
    if (S.editingId === id) { S.draft = JSON.parse(JSON.stringify(ev)); renderEditor(); }
  }

  function resizeEvent(id, newEndMins) {
    var ev = byId(id);
    if (!ev || ev.allDay) { return; }
    var startM = mins(ev.start);
    var e = Math.max(startM + SNAP, newEndMins);
    commit('change duration');
    var old = mins(ev.end) + diffDays(dkey(ev.start), dkey(ev.end)) * 1440;
    var delta = e - old;
    ev.end = isoAt(dkey(ev.start), e);
    Object.keys(ev.overrides || {}).forEach(function (k) {
      var o = ev.overrides[k];
      if (o.end) { o.end = isoAt(dkey(o.end), mins(o.end) + delta); }
    });
    touch(ev);
    saveDraft();
    renderAll();
    if (S.editingId === id) { S.draft = JSON.parse(JSON.stringify(ev)); renderEditor(); }
  }

  function impactHtml(ev) {
    var rows = feedsOf(ev).map(function (f) {
      return '<div class="impact-row">' +
        '<span class="pub-dot" style="background:' + f.schedule.color + '"></span>' +
        '<span style="flex:1">' + esc(f.file) + '</span>' +
        '<span class="mono" style="color:var(--ink-3);font-size:11px">' + esc(f.uid || 'no uid') + '</span>' +
        '</div>';
    }).join('');
    return '<div class="impact">' + (rows || '<div class="impact-row">Not published anywhere yet.</div>') + '</div>';
  }

  function archiveEvent(id) {
    var ev = byId(id);
    if (!ev) { return; }
    var n = ICS.feedCount(ev);
    confirmDialog(
      'Archive this event?',
      titleOf(ev),
      '<p class="note">The event is not deleted. It stays in the database with its UIDs intact and is ' +
      'published one last time as a cancelled entry, which is what tells Google and Apple to remove it ' +
      'from a subscriber\'s calendar. Deleting the UID outright would leave a ghost event behind forever.</p>' +
      '<div class="flabel" style="margin-top:12px">Affects ' + n + (n === 1 ? ' feed' : ' feeds') + '</div>' +
      impactHtml(ev),
      'Archive event', 'btn-danger',
      function () {
        commit('archive event');
        ev.status = 'archived';
        touch(ev);
        saveDraft();
        closeEditor();
        renderAll();
        toast('Archived - it will publish as CANCELLED until subscribers refresh', 'ok', 4200);
      }
    );
  }

  function restoreEvent(id) {
    var ev = byId(id);
    if (!ev) { return; }
    commit('restore event');
    ev.status = 'published';
    touch(ev);
    saveDraft();
    if (S.editingId === id) { S.draft = JSON.parse(JSON.stringify(ev)); renderEditor(); }
    renderAll();
    toast('Restored', 'ok');
  }

    /* -------------------------------------------------- permanent removal */
  /* Archive and Remove permanently are two different things on purpose.

     Archive keeps the master row, keeps every UID and publishes the event
     one last time as STATUS:CANCELLED. That cancelled entry is the only
     sentence a subscribed calendar understands as "drop this one".

     Remove permanently is the step after that. The master row leaves
     the master database, so the event is no longer generated into any feed
     at all and its UIDs simply stop existing. Nothing is left to publish a
     cancellation with, so it is offered only from a working copy that
     matches the live database exactly, and only behind a typed
     confirmation. Archive and Restore are untouched by any of this. */

  function removeReadiness() {
    return fetch(DATA_URL + '?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) { throw new Error(PUBLISH_DB + ' responded ' + r.status); }
        return r.json();
      })
      .then(function (liveDb) {
        var reasons = [];
        var mine = (S.db && S.db.events) || [];
        var live = (liveDb && liveDb.events) || [];
        if (dirtyCount()) {
          reasons.push(dirtyCount() + ' unpublished change' + (dirtyCount() === 1 ? '' : 's') +
            ' are waiting in this browser. Publish them, or undo them, before removing anything.');
        }
        if (mine.length !== live.length) {
          reasons.push('This browser holds ' + mine.length + ' master events and the live ' +
            PUBLISH_DB + ' holds ' + live.length + '.');
        } else {
          var liveJson = {};
          live.forEach(function (e) { liveJson[e.id] = JSON.stringify(e); });
          var drift = mine.filter(function (e) { return liveJson[e.id] !== JSON.stringify(e); }).length;
          if (drift) {
            reasons.push(drift + ' master event' + (drift === 1 ? '' : 's') +
              ' in this browser differ from the live ' + PUBLISH_DB + '.');
          }
        }
        return reasons;
      });
  }

  /* A real dry run: generate the six files from a database that no longer
     contains the event and diff them against what is live right now. The
     rows below are whatever ICS.diff actually reports, so a removal can
     never be dressed up as a cancellation or the other way round. */
  function removalPlan(ev) {
    var db = JSON.parse(JSON.stringify(S.db));
    db.events = db.events.filter(function (e) { return e.id !== ev.id; });
    var gen = ICS.generateAll(db, { extraHeaders: false });
    var live = S.live || {};
    var uids = Object.keys(ev.uids || {}).map(function (k) { return ev.uids[k]; }).filter(Boolean);
    var plan = { gen: gen, changed: [], untouched: [], removed: [], strays: 0, ghosts: [] };
    ICS.feedFiles(S.db).forEach(function (f) {
      var before = live[f.file] || '';
      var after = gen[f.file] || '';
      if (uids.some(function (u) { return after.indexOf(u) >= 0; })) { plan.ghosts.push(f.file); }
      var d = before ? ICS.diff(before, after) : null;
      if (!d || d.identical) {
        plan.untouched.push({ file: f.file, color: f.color });
        return;
      }
      plan.changed.push({ file: f.file, color: f.color, counts: d.counts });
      (d.removed || []).forEach(function (x) {
        plan.removed.push({ file: f.file, color: f.color, uid: x.uid, summary: x.summary });
      });
      plan.strays += d.counts.added + d.counts.changed;
    });
    return plan;
  }

  function showRemoveBlocked(ev, reasons) {
    modal({
      title: 'Remove permanently is blocked',
      sub: titleOf(ev),
      body: '<p class="note warn">A master event may only be removed from a working copy that matches the live ' +
        esc(PUBLISH_DB) + ' exactly. Anything else and the preview would be describing a database the ' +
        'repository does not have.</p>' +
        '<div class="impact" style="margin-top:11px">' +
        reasons.map(function (t) {
          return '<div class="impact-row"><span class="pill pill-warn">BLOCKED</span>' +
            '<span style="flex:1">' + esc(t) + '</span></div>';
        }).join('') + '</div>',
      actions: [{ label: 'Close', cls: 'btn-ghost' }]
    });
  }

  function showRemovePreview(ev) {
    var plan = removalPlan(ev);
    var stop = [];
    if (plan.ghosts.length) {
      stop.push('A UID of this event is still present in ' + plan.ghosts.join(', ') + '.');
    }
    if (plan.strays) {
      stop.push(plan.strays + ' unrelated event change' + (plan.strays === 1 ? '' : 's') +
        ' appeared in the generated files.');
    }
    if (feedsOf(ev).length && !plan.changed.length) {
      stop.push('The generated feeds do not differ from the live ones, so this removal cannot be verified.');
    }

    var h = '';
    h += '<p class="note warn"><b>This is not Archive.</b> Archive keeps the row in ' + esc(PUBLISH_DB) +
      ' and publishes it one more time as STATUS:CANCELLED. Remove permanently deletes the row, so the event ' +
      'is generated into no feed at all and its UIDs stop existing. Once that has been published the admin ' +
      'cannot bring it back.</p>';
    if (!archived(ev)) {
      h += '<p class="note warn" style="margin-top:10px">This event has never been published as cancelled. ' +
        'Anyone already subscribed may keep a copy of it for ever. Archive it and publish that first if that ' +
        'matters.</p>';
    }

    h += '<div class="flabel" style="margin-top:14px">Master event to remove</div><div class="impact">' +
      '<div class="impact-row"><span class="pill pill-danger">REMOVED</span>' +
      '<span style="flex:1" dir="auto">' + esc(titleOf(ev)) + '</span>' +
      '<span class="mono" style="font-size:11px">' + esc(ev.id) + '</span></div>' +
      '<div class="impact-row"><span style="flex:1">' + esc(prettyDate(dkey(ev.start))) + '</span>' +
      '<span class="mono" style="font-size:11px">status ' + esc(ev.status || 'published') + '</span></div>' +
      '</div>';

    h += '<div class="flabel" style="margin-top:14px">Feed entries that disappear (' + plan.removed.length +
      ')</div><div class="impact">' + (plan.removed.length
        ? plan.removed.map(function (x) {
            return '<div class="impact-row"><span class="pill pill-danger">REMOVED</span>' +
              '<span class="pub-dot" style="background:' + x.color + '"></span>' +
              '<span class="mono" style="flex:1;font-size:11px">' + esc(x.file) + '</span>' +
              '<span class="mono" style="font-size:11px">' + esc(x.uid || '') + '</span></div>';
          }).join('')
        : '<div class="impact-row">This event is in no feed, so only ' + esc(PUBLISH_DB) +
          ' changes.</div>') + '</div>';

    h += '<div class="flabel" style="margin-top:14px">Files this will change (' + (plan.changed.length + 1) +
      ')</div><div class="impact">' +
      plan.changed.map(function (f) {
        return '<div class="impact-row"><span class="pub-dot" style="background:' + f.color + '"></span>' +
          '<span class="mono" style="flex:1;font-size:11px">' + esc(f.file) + '</span>' +
          '<b>' + f.counts.removed + ' removed</b></div>';
      }).join('') +
      '<div class="impact-row"><span class="pub-dot" style="background:var(--ink-3)"></span>' +
      '<span class="mono" style="flex:1;font-size:11px">' + esc(PUBLISH_DB) + '</span>' +
      '<b>1 master row</b></div></div>';

    h += '<div class="flabel" style="margin-top:14px">Files that stay untouched (' + plan.untouched.length +
      ')</div><div class="impact">' + (plan.untouched.length
        ? plan.untouched.map(function (f) {
            return '<div class="impact-row"><span class="pub-dot" style="background:' + f.color + '"></span>' +
              '<span class="mono" style="flex:1;font-size:11px">' + esc(f.file) + '</span>' +
              '<span style="color:var(--ink-3);font-size:11.5px">no event change</span></div>';
          }).join('')
        : '<div class="impact-row">None.</div>') + '</div>';

    if (stop.length) {
      h += '<div class="flabel" style="margin-top:14px">Refused</div><div class="impact">' +
        stop.map(function (t) {
          return '<div class="impact-row"><span class="pill pill-warn">STOP</span>' +
            '<span style="flex:1">' + esc(t) + '</span></div>';
        }).join('') + '</div>';
    } else {
      h += '<div class="field" style="margin-top:14px">' +
        '<label class="flabel">Type REMOVE to confirm</label>' +
        '<input class="input mono" id="fRemoveConfirm" autocomplete="off" spellcheck="false" placeholder="REMOVE">' +
        '</div>' +
        '<p class="note">Nothing is written anywhere by this dialog. It only drops the row from the copy in ' +
        'this browser; the live files change on the next publish, in the same single commit as always.</p>';
    }

    var m = modal({
      title: 'Remove permanently?',
      sub: plan.removed.length + (plan.removed.length === 1 ? ' feed entry' : ' feed entries') + ' \u00b7 ' +
        plan.changed.length + ' of 6 feeds \u00b7 ' + PUBLISH_DB,
      wide: true, body: h,
      actions: stop.length
        ? [{ label: 'Close', cls: 'btn-ghost' }]
        : [{ label: 'Cancel', cls: 'btn-ghost' },
           {
             label: 'Remove permanently', cls: 'btn-danger', close: false,
             fn: function () {
               var i = $('#fRemoveConfirm', m);
               if (!i || i.value.trim().toUpperCase() !== 'REMOVE') {
                 toast('Type REMOVE to confirm', 'err');
                 return;
               }
               closeModal();
               performRemove(ev);
             }
           }]
    });

    var ok = $('.modal-f .btn-danger', m);
    var inp = $('#fRemoveConfirm', m);
    if (ok && inp) {
      ok.disabled = true;
      on(inp, 'input', function () {
        ok.disabled = inp.value.trim().toUpperCase() !== 'REMOVE';
      });
      setTimeout(function () { inp.focus(); }, 60);
    }
  }

  function performRemove(ev) {
    var i = (S.db.events || []).indexOf(ev);
    if (i < 0) { return; }
    commit('remove event permanently');
    S.db.events.splice(i, 1);
    delete S.selected[ev.id];
    markDirty(ev.id);
    S.live = null;
    saveDraft();
    closeEditor();
    renderAll();
    toast('Removed from the master database - it is in no feed now. Publish to write that to the repository.',
      'ok', 6000);
  }

  function removeEventPermanently(id) {
    var ev = byId(id);
    if (!ev) { return; }
    toast('Checking this working copy against the live database\u2026');
    S.live = null;
    Promise.all([removeReadiness(), fetchLive()]).then(function (r) {
      if (r[0].length) { showRemoveBlocked(ev, r[0]); return; }
      showRemovePreview(ev);
    }).catch(function (e) {
      modal({
        title: 'Remove permanently is not available',
        sub: 'Nothing was changed',
        body: '<div class="impact"><div class="impact-row">' + esc(scrub(e && e.message)) + '</div></div>' +
          '<p class="note" style="margin-top:10px">The live master database and the six live feeds have to be ' +
          'readable before a removal can be previewed honestly.</p>',
        actions: [{ label: 'Close', cls: 'btn-ghost' }]
      });
    });
  }

  function syncRemoveButton() {
    var b = $('#soRemove');
    if (!b) { return; }
    var blocked = dirtyCount() > 0;
    b.disabled = blocked;
    b.title = blocked
      ? 'Publish or undo the unpublished changes first - a removal needs a clean working copy'
      : 'Delete this master event from ' + PUBLISH_DB + ' so that it exists in no feed at all';
  }

/* ---------------------------------------------------------- drag engine */
  /*  One pointer handler for month chips, week/day blocks and resize grips.
      Nothing moves until the pointer has travelled a few pixels, so a plain
      click still opens the editor.                                        */

  var drag = null;

  function pointerDown(e) {
    if (e.button != null && e.button !== 0) { return; }
    var node = e.target.closest('[data-drag]');
    if (!node) { return; }
    var id = node.dataset.id;
    var ev = byId(id);
    if (!ev) { return; }
    var handle = e.target.closest('[data-handle]');
    drag = {
      id: id, node: node, mode: handle ? 'resize' : 'move',
      x0: e.clientX, y0: e.clientY, moved: false,
      fromDay: node.dataset.day, ghost: null, hint: null,
      startM: view(ev).allDay ? null : mins(view(ev).start),
      endM: view(ev).allDay ? null : mins(view(ev).end),
      allDay: view(ev).allDay
    };
    node.setPointerCapture && node.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!drag) { return; }
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) { return; }
    if (!drag.moved) {
      drag.moved = true;
      drag.node.classList.add('is-dragging');
      drag.hint = el('div', 'drag-hint');
      document.body.appendChild(drag.hint);
    }
    var ev = byId(drag.id);

    if (drag.mode === 'resize') {
      var col = drag.node.parentNode;
      var rect = col.getBoundingClientRect();
      var raw = DAY_START + (e.clientY - rect.top) / PX_PER_MIN;
      var m = Math.round(raw / SNAP) * SNAP;
      m = Math.max(drag.startM + SNAP, Math.min(DAY_END, m));
      drag.newEnd = m;
      drag.node.style.height = Math.max(17, (m - drag.startM) * PX_PER_MIN) + 'px';
      drag.hint.textContent = fmtT2(drag.startM) + ' - ' + fmtT2(m) + '   (' +
        Math.round((m - drag.startM) / 6) / 10 + ' h)';
    } else {
      var over = document.elementFromPoint(e.clientX, e.clientY);
      var target = over && over.closest('[data-drop]');
      $$('.drop-target').forEach(function (n) { n.classList.remove('drop-target'); });
      if (target) {
        target.classList.add('drop-target');
        drag.toDay = target.dataset.day;
        drag.toKind = target.getAttribute('data-drop');
        if (drag.toKind === 'time' && !drag.allDay) {
          var r2 = target.getBoundingClientRect();
          var raw2 = DAY_START + (e.clientY - r2.top) / PX_PER_MIN;
          var dur = drag.endM - drag.startM;
          var m2 = Math.round((raw2 - dur / 2) / SNAP) * SNAP;
          m2 = Math.max(0, Math.min(1440 - dur, m2));
          drag.toMins = m2;
        } else { drag.toMins = null; }
      } else { drag.toDay = null; }
      var txt = drag.toDay ? prettyDate(drag.toDay) : 'Release outside to cancel';
      if (drag.toMins != null) { txt += '   ' + fmtT2(drag.toMins) + ' - ' + fmtT2(drag.toMins + (drag.endM - drag.startM)); }
      drag.hint.textContent = txt;
    }
    drag.hint.style.left = (e.clientX + 14) + 'px';
    drag.hint.style.top = (e.clientY + 16) + 'px';
  }

  function pointerUp(e) {
    if (!drag) { return; }
    var d = drag;
    drag = null;
    $$('.drop-target').forEach(function (n) { n.classList.remove('drop-target'); });
    if (d.hint && d.hint.parentNode) { d.hint.parentNode.removeChild(d.hint); }
    d.node.classList.remove('is-dragging');

    if (!d.moved) { openEditor(d.id); return; }

    if (d.mode === 'resize') {
      if (d.newEnd != null) { resizeEvent(d.id, d.newEnd); toast('Duration updated', 'ok'); }
      else { renderAll(); }
      return;
    }
    if (!d.toDay) { renderAll(); return; }
    var days = diffDays(d.fromDay, d.toDay);
    var dm = (d.toMins != null && d.startM != null) ? (d.toMins - d.startM) : 0;
    if (!days && !dm) { renderAll(); return; }
    var ev = byId(d.id);
    var n = ICS.feedCount(ev);
    moveEvent(d.id, days, dm, 'move event');
    toast('Moved to ' + prettyDate(d.toDay) + (dm ? ' at ' + fmtT2(d.toMins) : '') +
          '  -  ' + n + (n === 1 ? ' feed' : ' feeds') + ' will change on publish', 'ok', 3600);
  }

  /* --------------------------------------------------------- slide editor */

  function openEditor(id, isNew) {
    var ev = byId(id);
    if (!ev) { return; }
    S.editingId = id;
    S.draft = JSON.parse(JSON.stringify(ev));
    S.draftNew = !!isNew;
    $('#scrim').hidden = false;
    $('#editor').hidden = false;
    requestAnimationFrame(function () {
      $('#scrim').classList.add('show');
      $('#editor').classList.add('show');
    });
    renderEditor();
    renderCal();
    setTimeout(function () {
      var f = $('#soBody input');
      if (isNew && f) { f.focus(); }
    }, 180);
  }

  function closeEditor() {
    S.editingId = null;
    S.draft = null;
    var sc = $('#scrim'), ed = $('#editor');
    if (sc) { sc.classList.remove('show'); }
    if (ed) { ed.classList.remove('show'); }
    setTimeout(function () {
      if (sc) { sc.hidden = true; }
      if (ed) { ed.hidden = true; }
    }, 220);
    renderCal();
  }

  function draftDirty() {
    var ev = byId(S.editingId);
    return ev && S.draft && JSON.stringify(ev) !== JSON.stringify(S.draft);
  }

  function fieldRow(label, html) {
    return '<div class="field"><label class="flabel">' + label + '</label>' + html + '</div>';
  }

  function renderEditor() {
    var d = S.draft;
    if (!d) { return; }
    var body = $('#soBody');
    var scrollTop = body.scrollTop;
    $('#soTitle').textContent = titleOf(d) || 'New event';
    var st = $('#soStatus');
    st.innerHTML = archived(d)
      ? '<span class="pill pill-mute">archived</span>'
      : (S.dirty[d.id] ? '<span class="pill pill-warn">unpublished</span>' : '<span class="pill pill-ok">published</span>');

    var startKey = dkey(d.start);
    var endKey = dkey(d.end || d.start);
    var h = '';

    /* titles ------------------------------------------------------------ */
    h += '<div class="field">' +
      '<label class="flabel">Title  -  עברית</label>' +
      '<input class="input rtl big" id="fTitleHe" dir="rtl" value="' + esc((d.title || {}).he || '') + '" placeholder="שם האירוע">' +
      '</div>';
    h += '<div class="field">' +
      '<label class="flabel">Title  -  English</label>' +
      '<input class="input" id="fTitleEn" value="' + esc((d.title || {}).en || '') + '" placeholder="Event name">' +
      '</div>';

    /* when -------------------------------------------------------------- */
    h += '<div class="field">' +
      '<label class="flabel">When</label>' +
      '<div style="margin-bottom:10px"><label class="switch"><input type="checkbox" id="fAllDay"' + (d.allDay ? ' checked' : '') +
      '><span class="track"></span><span class="switch-l">All-day event</span></label></div>';

    if (d.allDay) {
      h += '<div class="row2">' +
        '<div><label class="flabel">First day</label><input class="input" type="date" id="fDate" value="' + startKey + '"></div>' +
        '<div><label class="flabel">Last day</label><input class="input" type="date" id="fDateEnd" value="' +
          addDays(endKey, -1) + '"></div>' +
        '</div>';
    } else {
      h += '<input class="input" type="date" id="fDate" style="margin-bottom:8px" value="' + startKey + '">' +
        '<div class="row-when">' +
        '<input class="input" type="time" id="fStart" step="300" value="' + tpart(d.start) + '">' +
        '<span class="arrow-sep">to</span>' +
        '<input class="input" type="time" id="fEnd" step="300" value="' + tpart(d.end) + '">' +
        '</div>' +
        '<div class="note" id="whenHint" style="margin-top:6px"></div>';
    }
    h += '</div>';

    /* published to ------------------------------------------------------ */
    h += '<div class="field"><label class="flabel">Published to</label><div class="pub">';
    scheds().forEach(function (s) {
      var p = (d.publications || {})[s.key] || {};
      var lit = !!(p.he || p.en);
      h += '<div class="pub-row' + (lit ? '' : ' off') + '" style="--tone:' + shade(s.color, 0.72) + '">' +
        '<span class="pub-dot" style="background:' + s.color + '"></span>' +
        '<span class="pub-name">' + esc(s.name.he) + '<br><span style="font-size:10.5px;color:var(--ink-3)">' +
          esc(s.name.en) + '</span></span>' +
        '<span class="lang-toggle">' +
          '<button data-pub="' + s.key + '" data-lang="he" class="' + (p.he ? 'on' : '') + '">HE</button>' +
          '<button data-pub="' + s.key + '" data-lang="en" class="' + (p.en ? 'on' : '') + '">EN</button>' +
        '</span></div>';
    });
    h += '</div><div class="note" style="margin-top:7px">' +
      ICS.feedCount(d) + ' of 6 files will contain this event.</div></div>';

    /* overrides --------------------------------------------------------- */
    h += '<div class="field"><label class="flabel">Schedule-specific differences</label>';
    var defTxt = d.allDay ? 'All day' : fmtT2(mins(d.start)) + ' - ' + fmtT2(mins(d.end));
    h += '<div class="ovr"><div class="ovr-h">' + ico('<path d="M7 4v6a4 4 0 0 0 4 4h8"/>') +
         'Default (everyone)</div><div class="ovr-line"><span class="ovr-key">All schedules</span>' +
         '<span class="ovr-to">' + defTxt + '</span></div></div>';
    scheds().forEach(function (s) {
      var o = (d.overrides || {})[s.key];
      var p = (d.publications || {})[s.key] || {};
      if (!(p.he || p.en)) { return; }
      var eff = ICS.effective(d, s.key);
      var diff = !!(o && (o.start || o.end));
      var box = '<div class="ovr" style="border-color:' + tint(s.color, diff ? 0.55 : 0.22) + '">';
      box += '<div class="ovr-h"><span class="pub-dot" style="background:' + s.color + '"></span>' +
             esc(s.name.he) + (diff ? '' : '  -  same as default') + '</div>';
      if (diff) {
        box += '<div class="ovr-line"><span class="ovr-key">Time</span>' +
               '<span class="ovr-from">' + defTxt + '</span>' +
               '<span class="ovr-arrow">' + ico('<path d="M5 12h14M13 6l6 6-6 6"/>') + '</span>' +
               '<span class="ovr-to">' + (eff.allDay ? 'All day' : fmtT2(mins(eff.start)) + ' - ' + fmtT2(mins(eff.end))) + '</span>' +
               '</div>';
      }
      box += '<div style="display:flex;gap:7px;margin-top:7px">' +
             '<button class="btn btn-outline btn-sm" data-ovr="' + s.key + '">' +
             (diff ? 'Edit override' : 'Give this schedule its own time') + '</button>' +
             (diff ? '<button class="btn btn-ghost btn-sm" data-ovrdel="' + s.key + '">Remove</button>' : '') +
             '</div></div>';
      h += box;
    });
    h += '</div>';

    /* details ----------------------------------------------------------- */
    h += '<details class="disclose"><summary>Location, description &amp; notes</summary><div style="padding-top:11px">' +
      fieldRow('Location  -  עברית', '<input class="input rtl" dir="rtl" id="fLocHe" value="' + esc((d.location || {}).he || '') + '">') +
      fieldRow('Location  -  English', '<input class="input" id="fLocEn" value="' + esc((d.location || {}).en || '') + '">') +
      fieldRow('Description  -  עברית', '<textarea class="input rtl" dir="rtl" id="fDescHe" rows="3" style="height:auto;padding:8px 10px">' + esc((d.description || {}).he || '') + '</textarea>') +
      fieldRow('Description  -  English', '<textarea class="input" id="fDescEn" rows="3" style="height:auto;padding:8px 10px">' + esc((d.description || {}).en || '') + '</textarea>') +
      fieldRow('Internal notes (never published)', '<input class="input" id="fNotes" value="' + esc(d.notes || '') + '">') +
      '</div></details>';

    h += '<details class="disclose"><summary>Category, repeat &amp; status</summary><div style="padding-top:11px">' +
      fieldRow('Category', '<input class="input" id="fCat" value="' + esc(d.category || '') + '" placeholder="none">') +
      fieldRow('Repeat rule (RRULE)', '<input class="input mono" id="fRec" value="' + esc(d.recurrence || '') +
        '" placeholder="none  -  e.g. FREQ' + '=' + 'WEEKLY;BYDAY' + '=' + 'SU">') +
      (d.recurrence ? '<p class="note">A repeating event is drawn once here, on its first date. ' +
        'Every occurrence is written into the six feeds, so subscribers see the whole series.</p>' : '') +
      fieldRow('Status', '<select class="input" id="fStatus">' +
        ['published', 'draft', 'archived'].map(function (v) {
          return '<option value="' + v + '"' + (d.status === v ? ' selected' : '') + '>' + v + '</option>';
        }).join('') + '</select>') +
      '</div></details>';

    /* identity ---------------------------------------------------------- */
    var uidRows = scheds().map(function (s) {
      var u = (d.uids || {})[s.key];
      return u ? (s.key + '  ' + u) : (s.key + '  -');
    }).join('<br>');
    h += '<details class="disclose"><summary>Identity &amp; UIDs</summary><div style="padding-top:11px">' +
      '<div class="note" style="margin-bottom:8px">These identifiers are what make an edit land on the ' +
      'existing calendar entry instead of creating a duplicate. They are never regenerated.</div>' +
      '<div class="uid-list">id  ' + esc(d.id) + '<br>' + uidRows +
      '<br>sequence  ' + (d.sequence || 0) + '<br>updated  ' + esc(d.updatedAt || '') + '</div></div></details>';

    body.innerHTML = h;
    body.scrollTop = scrollTop;
    wireEditor();
    updateWhenHint();

    var arc = $('#soArchive');
    arc.textContent = archived(d) ? 'Restore' : 'Archive';
    arc.className = archived(d) ? 'btn btn-outline' : 'btn btn-danger';
    $('#soSave').disabled = false;
    syncRemoveButton();
    markEditorDirty();
  }

  function setDraft(path, value) {
    var d = S.draft;
    var parts = path.split('.');
    var o = d;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]]) { o[parts[i]] = {}; }
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    markEditorDirty();
  }

  function markEditorDirty() {
    var s = $('#soSave');
    if (s) { s.textContent = draftDirty() ? 'Save changes' : 'Save'; }
  }

  function updateWhenHint() {
    var hint = $('#whenHint');
    if (!hint || !S.draft || S.draft.allDay) { return; }
    var d = S.draft;
    var a = mins(d.start), b = mins(d.end) + diffDays(dkey(d.start), dkey(d.end)) * 1440;
    var len = Math.max(0, b - a);
    hint.textContent = DOWL[dow(dkey(d.start))] + '  -  ' + fmtT2(a) + ' to ' + fmtT2(b % 1440) +
      '  -  ' + (Math.round(len / 6) / 10) + ' hours  -  Los Angeles time';
  }

  function wireEditor() {
    var d = S.draft;

    on($('#fTitleHe'), 'input', function (e) { setDraft('title.he', e.target.value); $('#soTitle').textContent = titleOf(S.draft); });
    on($('#fTitleEn'), 'input', function (e) { setDraft('title.en', e.target.value); $('#soTitle').textContent = titleOf(S.draft); });
    on($('#fLocHe'), 'input', function (e) { setDraft('location.he', e.target.value || null); });
    on($('#fLocEn'), 'input', function (e) { setDraft('location.en', e.target.value || null); });
    on($('#fDescHe'), 'input', function (e) { setDraft('description.he', e.target.value || null); });
    on($('#fDescEn'), 'input', function (e) { setDraft('description.en', e.target.value || null); });
    on($('#fNotes'), 'input', function (e) { setDraft('notes', e.target.value || null); });
    on($('#fCat'), 'input', function (e) { setDraft('category', e.target.value || null); });
    on($('#fRec'), 'input', function (e) { setDraft('recurrence', e.target.value || null); });
    on($('#fStatus'), 'change', function (e) { setDraft('status', e.target.value); });

    on($('#fAllDay'), 'change', function (e) {
      var k = dkey(S.draft.start);
      if (e.target.checked) {
        S.draft.allDay = true;
        S.draft.start = k;
        S.draft.end = addDays(k, 1);
      } else {
        S.draft.allDay = false;
        S.draft.start = isoAt(k, 14 * 60);
        S.draft.end = isoAt(k, 16 * 60);
      }
      markEditorDirty();
      renderEditor();
    });

    on($('#fDate'), 'change', function (e) {
      var nk = e.target.value;
      if (!nk) { return; }
      var days = diffDays(dkey(S.draft.start), nk);
      var dur = diffDays(dkey(S.draft.start), dkey(S.draft.end));
      S.draft.start = shiftISO(S.draft.start, days, 0);
      S.draft.end = S.draft.allDay ? addDays(nk, Math.max(1, dur)) : shiftISO(S.draft.end, days, 0);
      Object.keys(S.draft.overrides || {}).forEach(function (kk) {
        var o = S.draft.overrides[kk];
        if (o.start) { o.start = shiftISO(o.start, days, 0); }
        if (o.end) { o.end = shiftISO(o.end, days, 0); }
      });
      markEditorDirty();
      renderEditor();
    });

    on($('#fDateEnd'), 'change', function (e) {
      if (!e.target.value) { return; }
      S.draft.end = addDays(e.target.value, 1);
      markEditorDirty();
    });

    on($('#fStart'), 'change', function (e) {
      var v = e.target.value;
      if (!v) { return; }
      S.draft.start = dkey(S.draft.start) + 'T' + v + ':00';
      if (S.draft.end <= S.draft.start) {
        S.draft.end = isoAt(dkey(S.draft.start), mins(S.draft.start) + 120);
        var f = $('#fEnd'); if (f) { f.value = tpart(S.draft.end); }
      }
      markEditorDirty(); updateWhenHint();
    });
    on($('#fEnd'), 'change', function (e) {
      var v = e.target.value;
      if (!v) { return; }
      S.draft.end = dkey(S.draft.start) + 'T' + v + ':00';
      if (S.draft.end <= S.draft.start) { S.draft.end = isoAt(dkey(S.draft.start), mins(S.draft.start) + 60); }
      markEditorDirty(); updateWhenHint();
    });

    $$('[data-pub]').forEach(function (b) {
      on(b, 'click', function () {
        var k = b.getAttribute('data-pub'), l = b.getAttribute('data-lang');
        if (!S.draft.publications) { S.draft.publications = {}; }
        if (!S.draft.publications[k]) { S.draft.publications[k] = { he: false, en: false }; }
        S.draft.publications[k][l] = !S.draft.publications[k][l];
        markEditorDirty();
        renderEditor();
      });
    });

    $$('[data-ovr]').forEach(function (b) {
      on(b, 'click', function () { editOverride(b.getAttribute('data-ovr')); });
    });
    $$('[data-ovrdel]').forEach(function (b) {
      on(b, 'click', function () {
        var k = b.getAttribute('data-ovrdel');
        delete S.draft.overrides[k];
        markEditorDirty();
        renderEditor();
      });
    });
  }

  function editOverride(key) {
    var d = S.draft;
    var s = schedOf(key);
    var eff = ICS.effective(d, key);
    var box = el('div', '');
    box.innerHTML =
      '<p class="note">The master event stays where it is. Only ' + esc(s.name.en) +
      ' publishes this different time, in both its Hebrew and English feeds.</p>' +
      '<div class="ovr" style="margin-bottom:12px"><div class="ovr-line">' +
      '<span class="ovr-key">Default</span><span class="ovr-to">' +
      (d.allDay ? 'All day' : fmtT2(mins(d.start)) + ' - ' + fmtT2(mins(d.end))) + '</span></div></div>' +
      '<div class="row-when">' +
        '<input class="input w3" type="time" step="300" id="ovStart" value="' + tpart(eff.start) + '">' +
        '<span class="arrow-sep">to</span>' +
        '<input class="input w3" type="time" step="300" id="ovEnd" value="' + tpart(eff.end) + '">' +
      '</div>';
    modal({
      title: s.name.he + '  -  own time',
      sub: s.name.en,
      body: box,
      actions: [
        { label: 'Cancel', cls: 'btn-ghost' },
        {
          label: 'Apply override', cls: 'btn-accent', close: false,
          fn: function () {
            var a = $('#ovStart').value, b = $('#ovEnd').value;
            if (!a || !b) { return; }
            if (!d.overrides) { d.overrides = {}; }
            var k = dkey(d.start);
            var o = d.overrides[key] || {};
            o.start = k + 'T' + a + ':00';
            o.end = k + 'T' + b + ':00';
            if (o.end <= o.start) { o.end = isoAt(k, mins(o.start) + 60); }
            d.overrides[key] = o;
            closeModal();
            markEditorDirty();
            renderEditor();
          }
        }
      ]
    });
  }

  function saveEditor() {
    var d = S.draft;
    if (!d) { return; }
    if (!(d.title || {}).he && !(d.title || {}).en) {
      toast('Give the event a title in at least one language', 'err');
      return;
    }
    var live = byId(d.id);
    if (!live) { return; }
    if (!draftDirty()) { closeEditor(); return; }

    commit('edit event');
    var idx = S.db.events.indexOf(live);
    d.updatedAt = nowStamp();
    d.updatedBy = 'admin-ui';
    S.db.events[idx] = d;
    var minted = ICS.ensureUids(S.db, d);
    markDirty(d.id);
    saveDraft();
    var n = ICS.feedCount(d);
    S.draft = JSON.parse(JSON.stringify(d));
    renderAll();
    renderEditor();
    toast('Saved  -  ' + n + (n === 1 ? ' feed' : ' feeds') + ' affected' +
      (minted.length ? ', ' + minted.length + ' new UID' + (minted.length > 1 ? 's' : '') + ' minted' : ', all UIDs preserved'), 'ok', 3600);
  }

  /* ------------------------------------------------------------ event list */

  function renderList() {
    var host = $('#eventList');
    if (!host) { return; }
    clear(host);
    var rows = visible().slice().sort(function (a, b) {
      if (a.start !== b.start) { return a.start < b.start ? -1 : 1; }
      return titleOf(a).localeCompare(titleOf(b));
    });

    var head = el('div', 'lrow head');
    head.innerHTML = '<span></span><span>Event</span><span>When</span><span>Published to</span><span>UIDs</span>';
    host.appendChild(head);

    rows.forEach(function (ev) {
      var v = view(ev);
      var r = el('div', 'lrow' + (S.selected[ev.id] ? ' sel' : ''));
      var chk = el('div', 'lcheck' + (S.selected[ev.id] ? ' on' : ''));
      chk.innerHTML = ico('<path d="m5 12 4.5 4.5L19 7"/>');
      on(chk, 'click', function (e) {
        e.stopPropagation();
        if (S.selected[ev.id]) { delete S.selected[ev.id]; } else { S.selected[ev.id] = true; }
        renderList();
      });
      r.appendChild(chk);

      var t = el('div', '');
      var t1 = el('div', 'ltitle', titleOf(ev));
      t1.setAttribute('dir', isRtl(titleOf(ev)) ? 'rtl' : 'ltr');
      t.appendChild(t1);
      if (altOf(ev)) {
        var t2 = el('div', 'lsub', altOf(ev));
        t2.setAttribute('dir', isRtl(altOf(ev)) ? 'rtl' : 'ltr');
        t.appendChild(t2);
      }
      if (archived(ev)) {
        var t3 = el('div', 'lsub');
        t3.innerHTML = '<span class="pill pill-warn">archived</span>';
        t.appendChild(t3);
        r.style.opacity = '.62';
      }
      r.appendChild(t);

      var w = el('div', 'lwhen');
      w.innerHTML = prettyShort(dkey(v.start)) + ', ' + dnum(dkey(v.start)).y +
        '<div class="lsub">' + (v.allDay ? 'All day' : fmtT2(mins(v.start)) + ' - ' + fmtT2(mins(v.end))) +
        (ev.recurrence ? '  -  repeats' : '') + '</div>';
      r.appendChild(w);

      var p = el('div', '');
      p.innerHTML = stags(ev);
      r.appendChild(p);

      var u = el('div', 'lsub mono');
      u.textContent = ICS.feedCount(ev) + ' feeds  -  ' + Object.keys(ev.uids || {}).length + ' uids' +
        (hasOverride(ev) ? '  -  override' : '');
      r.appendChild(u);

      on(r, 'click', function () { openEditor(ev.id); });
      host.appendChild(r);
    });

    var n = Object.keys(S.selected).length;
    var info = $('#selInfo');
    if (info) { info.textContent = n ? n + ' selected' : rows.length + (rows.length === 1 ? ' event' : ' events'); }
    var mb = $('#btnMerge');
    if (mb) { mb.disabled = n < 2; }
  }

  /* ---------------------------------------------------------------- merge */

  function mergeSelected() {
    var ids = Object.keys(S.selected);
    var list = ids.map(byId).filter(Boolean);
    if (list.length < 2) { return; }

    /* A merge is only safe when no two events publish to the same schedule,
       because each schedule can hold exactly one UID on the merged master. */
    var owners = {};
    var clash = [];
    list.forEach(function (ev) {
      pubScheds(ev).forEach(function (s) {
        if (owners[s.key]) { clash.push(s); } else { owners[s.key] = ev; }
      });
    });

    if (clash.length) {
      modal({
        title: 'These events cannot be merged',
        sub: 'Two of them publish to the same schedule',
        body: '<p class="note">Merging would force one of the two existing UIDs to be dropped, and a dropped ' +
          'UID leaves a permanent ghost event in every subscriber\'s calendar. ' +
          'Conflicting schedules: <b>' + clash.map(function (s) { return esc(s.name.en); }).join(', ') + '</b>.</p>' +
          '<p class="note" style="margin-top:9px">Pick events that live in different schedules, ' +
          'for example one Pisga event and one Shachbag event.</p>',
        actions: [{ label: 'Close', cls: 'btn-ghost' }]
      });
      return;
    }

    list.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    var base = list[0];
    var rest = list.slice(1);

    var preview = '';
    preview += '<div class="flabel">Result  -  one master event</div><div class="impact">';
    preview += '<div class="impact-row"><span class="pub-dot" style="background:' + primary(base) +
      '"></span><span style="flex:1" dir="auto">' + esc(titleOf(base)) + '</span><span class="mono" style="color:var(--ink-3)">' +
      (base.allDay ? 'all day' : fmtT2(mins(base.start)) + ' - ' + fmtT2(mins(base.end))) + '</span></div></div>';

    preview += '<div class="flabel" style="margin-top:13px">Every UID is kept</div><div class="impact">';
    list.forEach(function (ev) {
      scheds().forEach(function (s) {
        var u = (ev.uids || {})[s.key];
        if (!u) { return; }
        preview += '<div class="impact-row"><span class="pub-dot" style="background:' + s.color + '"></span>' +
          '<span style="flex:0 0 110px">' + esc(s.name.en.split(' ')[0]) + '</span>' +
          '<span class="mono" style="flex:1;font-size:11px">' + esc(u) + '</span></div>';
      });
    });
    preview += '</div>';

    var ovr = [];
    rest.forEach(function (ev) {
      pubScheds(ev).forEach(function (s) {
        var same = ev.start === base.start && ev.end === base.end && !!ev.allDay === !!base.allDay;
        var sameTitle = JSON.stringify(ev.title) === JSON.stringify(base.title);
        if (!same || !sameTitle) { ovr.push({ key: s.key, ev: ev, time: !same, title: !sameTitle }); }
      });
    });
    if (ovr.length) {
      preview += '<div class="flabel" style="margin-top:13px">Differences preserved as overrides</div><div class="impact">';
      ovr.forEach(function (o) {
        var s = schedOf(o.key);
        preview += '<div class="impact-row"><span class="pub-dot" style="background:' + s.color + '"></span>' +
          '<span style="flex:1">' + esc(s.name.en) + '</span><span style="color:var(--ink-3);font-size:11.5px">' +
          [o.time ? 'own time' : '', o.title ? 'own title' : ''].filter(Boolean).join(' + ') + '</span></div>';
      });
      preview += '</div>';
    }
    preview += '<p class="note" style="margin-top:13px">' + rest.length +
      (rest.length === 1 ? ' event record is' : ' event records are') +
      ' folded into the master. Nothing is deleted from any feed and no subscriber loses an event.</p>';

    modal({
      title: 'Merge ' + list.length + ' events into one',
      sub: 'One master event, ' + Object.keys(owners).length + ' schedules, all UIDs preserved',
      wide: true,
      body: preview,
      actions: [
        { label: 'Cancel', cls: 'btn-ghost' },
        {
          label: 'Merge', cls: 'btn-accent',
          fn: function () {
            commit('merge events');
            rest.forEach(function (ev) {
              pubScheds(ev).forEach(function (s) {
                base.publications[s.key] = JSON.parse(JSON.stringify(ev.publications[s.key]));
                base.uids[s.key] = (ev.uids || {})[s.key];
                var o = {};
                if (ev.start !== base.start || ev.end !== base.end || !!ev.allDay !== !!base.allDay) {
                  o.start = ev.start; o.end = ev.end;
                  if (!!ev.allDay !== !!base.allDay) { o.allDay = !!ev.allDay; }
                }
                if (JSON.stringify(ev.title) !== JSON.stringify(base.title)) { o.title = ev.title; }
                if (JSON.stringify(ev.location) !== JSON.stringify(base.location) &&
                    ((ev.location || {}).he || (ev.location || {}).en)) { o.location = ev.location; }
                if (ev.overrides && ev.overrides[s.key]) {
                  Object.keys(ev.overrides[s.key]).forEach(function (f) { o[f] = ev.overrides[s.key][f]; });
                }
                if (Object.keys(o).length) {
                  if (!base.overrides) { base.overrides = {}; }
                  base.overrides[s.key] = o;
                }
              });
              var i = S.db.events.indexOf(ev);
              if (i >= 0) { S.db.events.splice(i, 1); }
              delete S.dirty[ev.id];
            });
            touch(base);
            S.selected = {};
            saveDraft();
            renderAll();
            toast('Merged into one master event - every UID preserved', 'ok', 4000);
          }
        }
      ]
    });
  }

  /* ------------------------------------------------------------ schedules */

  function renderSchedules() {
    var host = $('#scheduleCards');
    if (!host) { return; }
    clear(host);
    scheds().forEach(function (s) {
      var evs = (S.db.events || []).filter(function (ev) {
        var p = ev.publications && ev.publications[s.key];
        return !!(p && (p.he || p.en));
      });
      var live = evs.filter(function (ev) { return !archived(ev); });
      var ovr = evs.filter(function (ev) { return ev.overrides && ev.overrides[s.key]; });
      var c = el('div', 'card');
      c.innerHTML =
        '<div class="card-h"><span class="card-dot" style="background:' + s.color + '"></span>' +
        '<span class="card-t" dir="rtl">' + esc(s.name.he) + '</span></div>' +
        '<div class="lsub" style="margin-bottom:11px">' + esc(s.name.en) + '</div>' +
        '<div class="kv"><span>Events</span><b>' + live.length + '</b></div>' +
        '<div class="kv"><span>Own times</span><b>' + ovr.length + '</b></div>' +
        '<div class="kv"><span>Archived</span><b>' + (evs.length - live.length) + '</b></div>' +
        '<div class="kv"><span>Hebrew feed</span><b class="mono">' + esc(s.feeds.he.file) + '</b></div>' +
        '<div class="kv"><span>English feed</span><b class="mono">' + esc(s.feeds.en.file) + '</b></div>' +
        '<div class="note" style="margin-top:11px">Subscription URLs are permanent. Renaming these files ' +
        'would silently break every existing subscriber.</div>';
      host.appendChild(c);
    });
  }

  /* --------------------------------------------------------- generate ics */

  /*  sequence is bumped only for events that actually changed, and only at
      generation time, so untouched events produce a byte-identical file.   */
  function preparedDb() {
    var db = JSON.parse(JSON.stringify(S.db));
    db.events.forEach(function (ev) {
      if (S.dirty[ev.id]) { ev.sequence = (ev.sequence || 0) + 1; }
    });
    return db;
  }

  function generate() {
    var db = preparedDb();
    var out = ICS.generateAll(db, { extraHeaders: false });
    S.gen = out;
    /* Hold on to the exact database these bytes came from. Publishing commits
       this object, so the SEQUENCE inside a feed and the number stored in
       data/events.json are always the same number. */
    S.genDb = db;
    return out;
  }

  /* Byte-for-byte the shape the repository already uses - two-space JSON with a
     trailing newline - so a published database produces a reviewable diff. */
  function dbJson(db) {
    var copy = JSON.parse(JSON.stringify(db));
    copy.generatedAt = nowStamp();
    copy.generator = 'admin-ui';
    return JSON.stringify(copy, null, 2) + '\n';
  }

  function fetchLive() {
    if (S.live) { return Promise.resolve(S.live); }
    var files = ICS.feedFiles(S.db).map(function (f) { return f.file; });
    return Promise.all(files.map(function (f) {
      return fetch('../' + f + '?cb=' + Date.now(), { cache: 'reload' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .catch(function () { return ''; });
    })).then(function (texts) {
      var m = {};
      files.forEach(function (f, i) { m[f] = texts[i]; });
      S.live = m;
      return m;
    });
  }

  /* -------------------------------------------------------------- sync ui */

  function renderSync() {
    var host = $('#syncPanel');
    if (!host) { return; }
    clear(host);

    var n = dirtyCount();
    var banner = el('div', '');
  banner.innerHTML = pubbarHtml();
  host.appendChild(banner);

  var top = el('div', 'card');
    top.innerHTML =
      '<div class="card-h"><span class="card-t">' +
      (n ? n + (n === 1 ? ' event has' : ' events have') + ' unpublished changes' : 'Everything is published') +
      '</span></div>' +
      '<div class="kv"><span>Master events</span><b>' + (S.db.events || []).length + '</b></div>' +
      '<div class="kv"><span>Feed files</span><b>6</b></div>' +
      '<div class="kv"><span>Live publishing</span><b>' +
        (S.publishEnabled ? 'ON - a confirmed publish reaches subscribers' : 'OFF - preview only') + '</b></div>' +
      '<div style="display:flex;gap:8px;margin-top:13px;flex-wrap:wrap">' +
      '<button class="btn btn-primary btn-sm" id="btnGen">Generate &amp; compare</button>' +
      '<button class="btn btn-outline btn-sm" id="btnDl">Download all six</button>' +
        '<button class="btn btn-danger btn-sm" id="btnReviewSync">Review and publish&hellip;</button>' +
      '</div>';
    host.appendChild(top);

    var res = el('div', '');
    res.id = 'syncResult';
    res.style.marginTop = '14px';
    host.appendChild(res);

    on($('#btnGen'), 'click', function () { runCompare(); });
    on($('#btnDl'), 'click', function () { downloadAll(); });
    on($('#btnReviewSync'), 'click', function () { reviewAndPublish(); });

    var note = el('div', 'card');
    note.style.marginTop = '14px';
    note.innerHTML =
      '<div class="card-h"><span class="card-t">What "synced" actually means</span></div>' +
      '<div class="kv"><span>Published to feed</span><b>we control this</b></div>' +
      '<div class="kv"><span>Calendar clients refreshed</span><b>we cannot control this</b></div>' +
      '<p class="note" style="margin-top:10px">Once a file is committed the feed is authoritative immediately. ' +
      'Google, Apple and Outlook then re-read it on their own schedule, usually somewhere between one hour ' +
      'and a day. The feeds ask for an hourly refresh, but that is a request, not a guarantee. ' +
      'This panel will never claim a subscriber has seen a change.</p>';
    host.appendChild(note);

    if (S.gen) { paintCompare(); }
  }

  function runCompare() {
    var res = $('#syncResult');
    res.innerHTML = '<div class="card"><div class="spinner spin-sm"></div> Generating six files and comparing with what is live...</div>';
    generate();
    fetchLive().then(function () { paintCompare(); });
  }

  function paintCompare() {
    var res = $('#syncResult');
    if (!res) { return; }
    clear(res);
    var files = ICS.feedFiles(S.db);
    var anyChange = false;

    files.forEach(function (f) {
      var text = S.gen[f.file];
      var live = (S.live || {})[f.file] || '';
      var v = ICS.validate(text);
      var d = live ? ICS.diff(live, text) : null;
      if (!d || !d.identical) { anyChange = true; }
      var s = schedOf(f.schedule);

      var c = el('div', 'card');
      c.style.marginBottom = '11px';
      var nch = d ? (d.counts.added + d.counts.removed + d.counts.changed) : 0;
      var pill = !live ? '<span class="pill pill-mute">no live copy</span>'
        : d.byteIdentical ? '<span class="pill pill-ok">byte identical</span>'
        : d.identical ? '<span class="pill pill-ok">same events, header only</span>'
        : '<span class="pill pill-warn">' + nch + ' event change' + (nch === 1 ? '' : 's') + '</span>';
      c.innerHTML =
        '<div class="card-h"><span class="card-dot" style="background:' + s.color + '"></span>' +
        '<span class="card-t mono">' + esc(f.file) + '</span>' + pill + '</div>' +
        '<div class="kv"><span>Events in file</span><b>' + v.eventCount + '</b></div>' +
        '<div class="kv"><span>Valid iCalendar</span><b>' + (v.ok ? 'yes' : 'NO  -  ' + v.errors.join('; ')) + '</b></div>' +
        (d && !d.identical
          ? '<div class="kv"><span>Added / removed / changed</span><b>' +
            d.counts.added + ' / ' + d.counts.removed + ' / ' + d.counts.changed + '</b></div>' : '') +
        '<div style="display:flex;gap:7px;margin-top:11px">' +
        '<button class="btn btn-outline btn-sm" data-show="' + f.file + '">View file</button>' +
        (d && !d.identical ? '<button class="btn btn-ghost btn-sm" data-diff="' + f.file + '">View diff</button>' : '') +
        '</div>';
      res.appendChild(c);
    });

    $$('[data-show]', res).forEach(function (b) {
      on(b, 'click', function () { showText(b.getAttribute('data-show'), S.gen[b.getAttribute('data-show')]); });
    });
    $$('[data-diff]', res).forEach(function (b) {
      on(b, 'click', function () { showDiff(b.getAttribute('data-diff')); });
    });

    var foot = el('div', 'note ' + (anyChange ? 'warn' : 'ok'));
    foot.style.marginTop = '10px';
    foot.textContent = anyChange
      ? ('These files are ready. ' + (S.publishEnabled
        ? 'Live publishing is ON - use Review and publish for the confirmation screen.'
        : 'Preview mode, so nothing has been written to the live feeds.'))
      : 'No event in any of the six feeds differs from what subscribers already have. Only the refresh headers are new.';
    res.appendChild(foot);
  }

  function showText(name, text) {
    var pre = el('pre', 'code');
    pre.textContent = text;
    pre.style.maxHeight = '58vh';
    pre.style.overflow = 'auto';
    modal({
      title: name, sub: text.length + ' bytes', wide: true, body: pre,
      actions: [
        { label: 'Copy', cls: 'btn-outline', close: false, fn: function () {
            navigator.clipboard.writeText(text).then(function () { toast('Copied ' + name, 'ok'); });
        } },
        { label: 'Close', cls: 'btn-ghost' }
      ]
    });
  }

  function showDiff(name) {
    var d = ICS.diff((S.live || {})[name] || '', S.gen[name]);
    var h = '';
    function block(title, arr, cls) {
      if (!arr.length) { return ''; }
      var s = '<div class="flabel" style="margin-top:11px">' + title + ' (' + arr.length + ')</div><div class="impact">';
      arr.slice(0, 60).forEach(function (x) {
        s += '<div class="impact-row"><span class="pill ' + cls + '">' + title.toUpperCase() + '</span>' +
          '<span class="mono" style="flex:1;font-size:11px">' + esc(x.uid || '') + '</span>' +
          '<span style="color:var(--ink-3);font-size:11.5px" dir="auto">' + esc(x.summary || '') + '</span></div>';
      });
      return s + '</div>';
    }
    h += block('Added', d.added, 'pill-ok');
    h += block('Removed', d.removed, 'pill-danger');
    h += block('Changed', d.changed, 'pill-warn');
    if (!h) { h = '<p class="note">No event-level differences.</p>'; }
    modal({ title: 'Diff  -  ' + name, sub: 'against the live feed', wide: true, body: h,
      actions: [{ label: 'Close', cls: 'btn-ghost' }] });
  }

  function downloadAll() {
    var out = S.gen || generate();
    Object.keys(out).forEach(function (name, i) {
      setTimeout(function () {
        var blob = new Blob([out[name]], { type: 'text/calendar' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      }, i * 260);
    });
    toast('Downloading six .ics files', 'ok');
  }

  /* ------------------------------------------------------------- settings */

  /* ------------------------------------------------------ publish state ui */
  /* The current mode is impossible to miss: a pill in the top bar, a banner
     on the sync and settings screens, a red hairline under the top bar and a
     marker in the tab title. */

  var PUB_CSS =
    '#pubState{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;' +
    'font-size:11.5px;font-weight:700;letter-spacing:.03em;white-space:nowrap;border:1px solid var(--line-strong);' +
    'background:var(--surface-3);color:var(--ink-2)}' +
    '#pubState.live{background:var(--danger-soft);border-color:#f97066;color:var(--danger)}' +
    '#pubState .short{display:none}' +
    '@media (max-width:1040px){#pubState .long{display:none}#pubState .short{display:inline}}' +
    'body.live-pub .topbar{box-shadow:inset 0 3px 0 0 var(--danger)}' +
    '.pubbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 13px;margin-bottom:14px;' +
    'border:1px solid var(--line-strong);border-radius:var(--r-lg);background:var(--surface-3);' +
    'font-size:13.5px;font-weight:650}' +
    '.pubbar.live{background:var(--danger-soft);border-color:#f97066;color:var(--danger)}' +
    '.pubbar .why{font-weight:450;font-size:12.5px;color:var(--ink-2)}' +
    '.pubbar.live .why{color:var(--danger)}';

  function installPubState() {
    if (!document.getElementById('pubStateCss')) {
      var st = el('style');
      st.id = 'pubStateCss';
      st.textContent = PUB_CSS;
      document.head.appendChild(st);
    }
    var host = $('.topbar-right');
    if (host && !$('#pubState')) {
      var b = el('button', '');
      b.id = 'pubState';
      b.type = 'button';
      b.title = 'Publishing state - click to open Settings';
      on(b, 'click', function () { gotoScreen('settings'); renderAll(); });
      host.insertBefore(b, host.firstChild);
    }
    renderPubState();
  }

  function renderPubState() {
    var live = !!S.publishEnabled;
    document.body.classList.toggle('live-pub', live);
    document.title = (live ? '🟢 LIVE - ' : '⚪ Preview - ') + 'Calendar Admin · Shevet Pisga';
    var b = $('#pubState');
    if (!b) { return; }
    b.className = live ? 'live' : '';
    b.innerHTML = (live ? '🟢' : '⚪') +
      '<span class="long">' + (live ? 'LIVE PUBLISHING ON' : 'PREVIEW MODE - NOTHING WILL BE PUBLISHED') + '</span>' +
      '<span class="short">' + (live ? 'LIVE' : 'PREVIEW MODE') + '</span>';
  }

  function pubbarHtml() {
    var live = !!S.publishEnabled;
    return '<div class="pubbar' + (live ? ' live' : '') + '">' +
      '<span>' + (live ? '🟢 LIVE PUBLISHING ON' : '⚪ PREVIEW MODE - NOTHING WILL BE PUBLISHED') + '</span>' +
      '<span class="why">' + (live
        ? 'A confirmed publish overwrites the six live feeds that subscribers read.'
        : 'Generate, diff and download freely. The six live .ics files are untouched.') +
      '</span></div>';
  }

  /* --------------------------------------------------------------- settings */

  function renderSettings() {
    var host = $('#settingsPanel');
    if (!host) { return; }
    clear(host);

    var live = !!S.publishEnabled;

    /* ---- the switch --------------------------------------------------- */
    var c0 = el('div', 'card');
    c0.style.borderColor = live ? '#f97066' : 'var(--line-strong)';
    c0.innerHTML =
      '<div class="card-h"><span class="card-t" style="letter-spacing:.06em">LIVE PUBLISHING</span>' +
      (live ? '<span class="pill pill-danger">ON</span>' : '<span class="pill pill-mute">OFF</span>') + '</div>' +
      '<div class="seg" id="pubSeg" style="max-width:220px;margin:2px 0 12px">' +
      '<button data-pubmode="off"' + (live ? '' : ' class="on"') + '>OFF</button>' +
      '<button data-pubmode="on"' + (live ? ' class="on"' : '') + '>ON</button>' +
      '</div>' +
      (live
        ? '<p class="note warn"><b>Changes you publish will reach real subscribers.</b> A confirmed publish ' +
          'overwrites the ticked live .ics files on ' + esc(PUBLISH_BRANCH) + ', and rewrites ' + PUBLISH_DB + ' in the ' +
          'same commit so the SEQUENCE counters are stored with them. Filenames and subscription URLs never ' +
          'change and every UID is preserved, so entries update in place instead of duplicating.</p>'
        : '<p class="note">Preview mode is the default. Edit, generate the six feeds and read every diff as much ' +
          'as you like - nothing is written to the live .ics files while this is off.</p>') +
      '<div class="kv" style="margin-top:12px"><span>Repository it may write to</span><b class="mono">' +
      esc(PUBLISH_REPO) + '</b></div>' +
      '<div class="kv"><span>Branch</span><b class="mono">' + esc(PUBLISH_BRANCH) + '</b></div>' +
      '<div class="kv"><span>Files it may write</span><b>' + PUBLISH_ALLOW.length + ' feed files + ' + PUBLISH_DB + '</b></div>' +
      '<div style="display:flex;gap:8px;margin-top:13px;flex-wrap:wrap">' +
      '<button class="btn ' + (live ? 'btn-danger' : 'btn-outline') + ' btn-sm" id="btnReview">' +
      (live ? 'Review and publish&hellip;' : 'Review changes (preview)') + '</button>' +
      '</div>';
    host.appendChild(c0);

    $$('[data-pubmode]', c0).forEach(function (b) {
      on(b, 'click', function () {
        var want = b.getAttribute('data-pubmode') === 'on';
        if (want === live) { return; }
        if (!want) {
          S.publishEnabled = false;
          renderAll();
          toast('⚪ Preview mode - nothing will be published', 'ok');
          return;
        }
        confirmDialog(
          'Turn LIVE PUBLISHING on?',
          'From then on a confirmed publish affects real subscribers',
          '<p class="note warn"><b>While this is on, publishing overwrites the six live .ics files.</b> ' +
          'Everyone subscribed to the three schedules in Google, Apple or Outlook picks the change up on their ' +
          'next refresh, usually between an hour and a day later.</p>' +
          '<p class="note" style="margin-top:9px">Turning this on publishes nothing by itself. You will still get ' +
          'a confirmation screen with the exact per-feed counts before a single byte is written.</p>' +
          '<p class="note" style="margin-top:9px">Every publish is one commit containing the ticked feeds and ' +
          esc(PUBLISH_DB) + '. That is what keeps the SEQUENCE counters in the repository instead of in this ' +
          'browser, so you never have to export anything by hand.</p>' +
          '<div class="kv" style="margin-top:11px"><span>Repository</span><b class="mono">' + esc(PUBLISH_REPO) + '</b></div>' +
          '<div class="kv"><span>Branch</span><b class="mono">' + esc(PUBLISH_BRANCH) + '</b></div>' +
          '<div class="kv"><span>Files it may write</span><b>' + PUBLISH_ALLOW.length + ' feed files + ' + PUBLISH_DB + '</b></div>',
          'Turn it on', 'btn-danger',
          function () {
            S.publishEnabled = true;
            renderAll();
            toast('🟢 LIVE PUBLISHING ON - changes you confirm will reach subscribers', 'ok', 6000);
          }
        );
      });
    });
    on($('#btnReview'), 'click', function () { reviewAndPublish(); });

    /* ---- token -------------------------------------------------------- */
    var kind = S.tokenKind;
    var c1 = el('div', 'card');
    c1.style.marginTop = '14px';
    c1.innerHTML =
      '<div class="card-h"><span class="card-t">GitHub access</span>' +
      (S.token
        ? '<span class="pill pill-ok">token loaded for this tab</span>'
        : '<span class="pill pill-mute">no token</span>') + '</div>' +
      '<div class="field"><label class="flabel">Fine-grained personal access token</label>' +
      '<input class="input mono" id="setTok" type="password" autocomplete="off" autocapitalize="off" ' +
      'autocorrect="off" spellcheck="false" placeholder="github_pat_&hellip;">' +
      '<div class="note" style="margin-top:6px">Held in memory for this tab only. It is never written to ' +
      'localStorage or sessionStorage, never put in a URL, never saved into events.json, never committed and ' +
      'never logged. Closing or reloading this tab forgets it.</div></div>' +
      (kind === 'classic'
        ? '<p class="note warn">That looks like a classic token, which can reach every repository you own. ' +
          'A fine-grained token limited to this one repository is strongly preferred.</p>'
        : '') +
      (kind === 'unknown'
        ? '<p class="note warn">That does not look like a GitHub token. Publishing will fail with 401.</p>'
        : '') +
      '<div class="flabel" style="margin-top:14px">Minimum permission this app needs</div>' +
      '<div class="kv"><span>Token type</span><b>Fine-grained</b></div>' +
      '<div class="kv"><span>Repository access</span><b>Only <span class="mono">' + esc(PUBLISH_REPO) + '</span></b></div>' +
      '<div class="kv"><span>Repository permissions</span><b>Contents: Read and write</b></div>' +
      '<div class="kv"><span>Everything else</span><b>No access</b></div>' +
      '<div class="kv"><span>Account permissions</span><b>None</b></div>' +
      '<div style="display:flex;gap:8px;margin-top:13px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" id="btnTokClear"' + (S.token ? '' : ' disabled') + '>' +
      'Clear token from memory</button>' +
      '<a class="btn btn-outline btn-sm" target="_blank" rel="noopener noreferrer" ' +
      'href="https://github.com/settings/personal-access-tokens/new">Create a token on GitHub</a>' +
      '</div>';
    host.appendChild(c1);

    on($('#setTok'), 'input', function (e) {
      var v = String(e.target.value || '').trim();
      S.token = v;
      var was = S.tokenKind;
      S.tokenKind = !v ? '' : (/^github_pat_/.test(v) ? 'fine' : (/^gh[pous]_/.test(v) ? 'classic' : 'unknown'));
      var cb = $('#btnTokClear');
      if (cb) { cb.disabled = !v; }
      if (S.tokenKind !== was && (S.tokenKind === 'classic' || S.tokenKind === 'unknown' || was === 'classic' || was === 'unknown')) {
        var keep = v;
        renderSettings();
        var f = $('#setTok');
        if (f) { f.value = keep; f.focus(); }
      }
    });
    on($('#btnTokClear'), 'click', function () {
      S.token = '';
      S.tokenKind = '';
      renderSettings();
      toast('Token cleared from memory', 'ok');
    });

    /* ---- leftovers from older tools ----------------------------------- */
    var stale = foreignCredKeys();
    if (stale.length) {
      var c2 = el('div', 'card');
      c2.style.marginTop = '14px';
      c2.innerHTML =
        '<div class="card-h"><span class="card-t">Credentials left in this browser</span>' +
        '<span class="pill pill-warn">' + stale.length + '</span></div>' +
        '<p class="note warn">An older tool stored these entries. This app never reads them and cannot use ' +
        'them - only their names are listed here, never their contents. Revoke the credential on GitHub first, ' +
        'then forget the entry.</p>' +
        '<div class="impact" style="margin-top:10px">' + stale.map(function (k) {
          return '<div class="impact-row"><span class="mono" style="flex:1">' + esc(k) + '</span>' +
            '<button class="btn btn-danger btn-sm" data-forget="' + esc(k) + '">Forget</button></div>';
        }).join('') + '</div>';
      host.appendChild(c2);
      $$('[data-forget]', c2).forEach(function (b) {
        on(b, 'click', function () {
          forgetCredKey(b.getAttribute('data-forget'));
          renderSettings();
          toast('Entry removed from this browser', 'ok');
        });
      });
    }

    /* ---- working copy -------------------------------------------------- */
    var c3 = el('div', 'card');
    c3.style.marginTop = '14px';
    c3.innerHTML =
      '<div class="card-h"><span class="card-t">Working copy</span></div>' +
      '<div class="kv"><span>Unpublished changes</span><b>' + dirtyCount() + '</b></div>' +
      '<div class="kv"><span>Undo steps</span><b>' + S.history.length + '</b></div>' +
      '<p class="note" style="margin-top:10px">Edits live in this browser until you publish. Publishing then ' +
      'commits ' + PUBLISH_DB + ' alongside the feeds, so the master database and the SEQUENCE counters ' +
      'survive a cleared browser without you exporting anything. The export below is only a manual backup.</p>' +
      '<div style="display:flex;gap:8px;margin-top:13px;flex-wrap:wrap">' +
      '<button class="btn btn-outline btn-sm" id="btnExport">Export events.json</button>' +
      '<button class="btn btn-ghost btn-sm" id="btnReload">Discard and reload from disk</button>' +
      '</div>';
    host.appendChild(c3);

    on($('#btnExport'), 'click', function () {
      var db = preparedDb();
      db.generatedAt = nowStamp();
      var blob = new Blob([JSON.stringify(db, null, 2) + '\n'], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'events.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('events.json exported', 'ok');
    });
    on($('#btnReload'), 'click', function () {
      confirmDialog('Discard all local changes?', dirtyCount() + ' events have unpublished edits',
        '<p class="note">The working copy in this browser is thrown away and the published ' +
        'data/events.json is loaded again. The live feeds are untouched either way.</p>',
        'Discard', 'btn-danger', function () { dropDraft(); S.leaving = true; location.reload(); });
    });
  }

  /* ------------------------------------------------------- publish preview */
  /* One master event can appear in up to six feeds, so the confirmation
     screen reports both numbers: how many events the operator changed, and
     how many feed entries that actually produces. */

  function uidIndex() {
    var m = {};
    ((S.db && S.db.events) || []).forEach(function (ev) {
      Object.keys(ev.uids || {}).forEach(function (k) { m[ev.uids[k]] = ev; });
    });
    return m;
  }

  function publishSummary() {
    var gen = S.gen || generate();
    var live = S.live || {};
    var idx = uidIndex();
    var perFeed = [];
    var touched = {}, addedIds = {}, removedIds = {}, changedIds = {};

    ICS.feedFiles(S.db).forEach(function (f) {
      var text = gen[f.file] || '';
      var before = live[f.file] || '';
      var d = before ? ICS.diff(before, text) : null;
      var counts = d ? d.counts : { added: 0, removed: 0, changed: 0 };
      perFeed.push({
        file: f.file, schedule: f.schedule, lang: f.lang, name: f.name, color: f.color,
        counts: counts, changes: counts.added + counts.removed + counts.changed,
        fresh: !before, valid: ICS.validate(text)
      });
      if (!d) { return; }
      [['added', d.added], ['removed', d.removed], ['changed', d.changed]].forEach(function (pair) {
        (pair[1] || []).forEach(function (x) {
          var ev = idx[x.uid];
          var id = ev ? ev.id : ('uid:' + x.uid);
          touched[id] = (touched[id] || 0) + 1;
          if (pair[0] === 'removed' || (ev && archived(ev))) { removedIds[id] = 1; }
          else if (pair[0] === 'added') { addedIds[id] = 1; }
          else { changedIds[id] = 1; }
        });
      });
    });

    var events = { added: 0, changed: 0, removed: 0 };
    Object.keys(touched).forEach(function (id) {
      if (removedIds[id]) { events.removed++; }
      else if (addedIds[id] && !changedIds[id]) { events.added++; }
      else { events.changed++; }
    });

    return {
      gen: gen,
      perFeed: perFeed,
      events: events,
      multi: Object.keys(touched).filter(function (id) { return touched[id] > 1; }).length,
      feedChanges: perFeed.reduce(function (a, f) { return a + f.changes; }, 0),
      files: perFeed.filter(function (f) { return f.changes > 0; }).map(function (f) { return f.file; }),
      invalid: perFeed.filter(function (f) { return !f.valid.ok; })
    };
  }

  function reviewAndPublish() {
    var btns = [$('#btnReview'), $('#btnReviewSync')];
    btns.forEach(function (b) { if (b) { b.disabled = true; } });
    toast('Generating the six files and reading what is live right now…');
    generate();
    S.live = null;
    fetchLive().then(function () {
      btns.forEach(function (b) { if (b) { b.disabled = false; } });
      showPublishPreview();
    }).catch(function () {
      btns.forEach(function (b) { if (b) { b.disabled = false; } });
      toast('Could not read the live feeds to compare against - nothing was published', 'err');
    });
  }

  function showPublishPreview() {
    var sum = publishSummary();
    var live = !!S.publishEnabled;
    var total = sum.events.added + sum.events.changed + sum.events.removed;

    if (!sum.files.length) {
      modal({
        title: 'Nothing to publish',
        sub: 'Every feed already matches what subscribers have',
        body: '<p class="note ok">All six generated files are identical to the live ones at event level. ' +
          'Only the refresh headers would change, which is not worth a commit.</p>',
        actions: [{ label: 'Close', cls: 'btn-ghost' }]
      });
      return;
    }

    var sel = {};
    sum.files.forEach(function (f) { sel[f] = true; });

    var h = '';
    h += '<div class="flabel">You are about to publish</div>';
    h += '<div class="impact">' +
      '<div class="impact-row"><span class="pill pill-warn">CHANGED</span>' +
      '<span style="flex:1">events changed</span><b>' + sum.events.changed + '</b></div>' +
      '<div class="impact-row"><span class="pill pill-ok">ADDED</span>' +
      '<span style="flex:1">events added</span><b>' + sum.events.added + '</b></div>' +
      '<div class="impact-row"><span class="pill pill-danger">REMOVED</span>' +
      '<span style="flex:1">events removed or cancelled</span><b>' + sum.events.removed + '</b></div>' +
      '</div>';
    if (sum.multi) {
      h += '<p class="note warn" style="margin-top:10px"><b>' + sum.multi +
        (sum.multi === 1 ? ' event appears' : ' events appear') + ' in more than one feed.</b> That is why ' +
        total + (total === 1 ? ' event edit produces ' : ' event edits produce ') + sum.feedChanges +
        ' feed entries below - one change, several calendars.</p>';
    }
    h += '<div class="flabel" style="margin-top:14px">Per feed - tick what to write</div><div class="impact">';
    sum.perFeed.forEach(function (f) {
      var can = f.changes > 0;
      var right = can ? (f.changes + (f.changes === 1 ? ' change' : ' changes')) : 'no change';
      h += '<div class="impact-row">' +
        '<label class="switch" title="' + esc(f.file) + '">' +
        '<input type="checkbox" data-pv="' + esc(f.file) + '"' + (can ? ' checked' : ' disabled') + '>' +
        '<span class="track"></span></label>' +
        '<span class="pub-dot" style="background:' + f.color + '"></span>' +
        '<span style="flex:1" dir="auto">' + esc(f.name) + ' — ' + (f.lang === 'he' ? 'Hebrew' : 'English') + '</span>' +
        '<span class="mono" style="color:var(--ink-3);font-size:11px">' + esc(f.file) + '</span>' +
        '<b style="min-width:86px;text-align:right">' + right + '</b></div>';
    });
    h += '</div>';
    if (sum.invalid.length) {
      h += '<p class="note warn" style="margin-top:10px">' + sum.invalid.length +
        ' generated file(s) failed iCalendar validation. Publishing is blocked until that is fixed.</p>';
    }
    h += live
      ? '<p class="note warn" style="margin-top:12px">🟢 Live publishing is ON. Publishing overwrites the ticked ' +
        'files on ' + esc(PUBLISH_BRANCH) + ' and subscribers receive them on their next refresh. UIDs are ' +
        'preserved and SEQUENCE is bumped, so entries update in place. ' + esc(PUBLISH_DB) + ' is written by the ' +
        'same commit, which is what makes the new SEQUENCE numbers permanent.</p>'
      : '<p class="note" style="margin-top:12px">⚪ Preview mode. This is exactly what would be written, and ' +
        esc(PUBLISH_DB) + ' would travel in the same commit. Nothing can be published until live publishing ' +
        'is switched on in Settings.</p>';

    var box = el('div', '');
    box.innerHTML = h;

    var acts = live
      ? [{ label: 'Cancel', cls: 'btn-ghost' },
         { label: 'Publish changes', cls: 'btn-danger', close: false, fn: function () {
             var picked = Object.keys(sel).filter(function (f) { return sel[f]; });
             if (!picked.length) { toast('Tick at least one feed first', 'err'); return; }
             if (sum.invalid.length) { toast('Invalid files - nothing was published', 'err'); return; }
             closeModal();
             doPublish(sum.gen, picked, picked.length === sum.files.length);
           } }]
      : [{ label: 'Close', cls: 'btn-ghost' },
         { label: 'Open Settings', cls: 'btn-outline', fn: function () { gotoScreen('settings'); renderAll(); } }];

    var m = modal({
      title: live ? 'Publish changes' : 'Preview - nothing will be published',
      sub: total + (total === 1 ? ' event' : ' events') + ' · ' + sum.feedChanges + ' feed entries · ' +
        sum.files.length + ' of 6 files',
      wide: true, body: box, actions: acts
    });
    $$('[data-pv]', m).forEach(function (cb) {
      on(cb, 'change', function () { sel[cb.getAttribute('data-pv')] = cb.checked; });
    });
  }

  /* ------------------------------------------------------------- publishing */
  /* Every gate is checked again here, immediately before the network call,
     so no UI path can bypass them. */

  function doPublish(out, names, full) {
    if (!S.publishEnabled) { toast('Live publishing is OFF - nothing was published', 'err'); return; }
    if (!S.token) { toast('Enter a GitHub token in Settings first', 'err'); return; }
    var files = (names || []).filter(allowedFile);
    if (!files.length) { toast('Nothing to publish', 'err'); return; }

    /* The exact database the .ics files were generated from. Committing this
       same object in the same commit is what makes the bumped SEQUENCE
       numbers permanent instead of living only in this browser. */
    var genDb = S.genDb;
    if (!genDb) { toast('Run Review and publish again first', 'err'); return; }

    var map = {};
    files.forEach(function (name) { map[name] = out[name]; });
    map[PUBLISH_DB] = dbJson(genDb);

    var bad = Object.keys(map).filter(function (p) {
      return typeof map[p] !== 'string' || !map[p].length;
    });
    if (bad.length) { toast('Generated content is missing - nothing was published', 'err'); return; }

    var msg = 'calendar: publish ' + files.length +
      (files.length === 1 ? ' feed' : ' feeds') + ' and the master database\n\n' +
      files.map(function (f) { return '- ' + f; }).join('\n') + '\n- ' + PUBLISH_DB +
      '\n\nOne commit, so the SEQUENCE counters in ' + PUBLISH_DB +
      ' can never drift from the published feeds.';

    toast('Writing ' + files.length + (files.length === 1 ? ' feed' : ' feeds') +
      ' and ' + PUBLISH_DB + ' in a single commit…');

    commitFiles(map, msg).then(function (info) {
      S.live = null;
      S.gen = null;
      S.genDb = null;
      (S.db.events || []).forEach(function (ev) {
        if (S.dirty[ev.id]) { ev.sequence = (ev.sequence || 0) + 1; }
      });
      if (full) { S.dirty = {}; }
      saveDraft();
      renderAll();
      toast('Published ' + files.length + (files.length === 1 ? ' feed' : ' feeds') + ' and ' +
        PUBLISH_DB + ' in commit ' + String(info.sha).slice(0, 7) +
        '. The SEQUENCE counters are now stored in the repository.', 'ok', 8000);
    }).catch(function (e) {
      S.live = null;
      S.gen = null;
      S.genDb = null;
      renderAll();
      modal({
        title: 'Nothing was published',
        sub: 'The commit was refused, so every live file is unchanged',
        body: '<div class="impact"><div class="impact-row">' + esc(scrub(e && e.message)) + '</div></div>' +
          '<p class="note ok" style="margin-top:10px">All ' + Object.keys(map).length +
          ' files travel in one commit and the branch pointer is moved once, at the very end. ' +
          'A failure before that point leaves the live feeds and the master database exactly as they ' +
          'were, so there is no half-published state to repair. Fix the cause and run Review and ' +
          'publish again - re-publishing identical content is harmless.</p>',
        actions: [{ label: 'Close', cls: 'btn-ghost' }]
      });
    });
  }

  /* ------------------------------------------------- one atomic commit */
  /* The contents API writes one file per request, which cannot keep six feeds
     and the master database in step - a mid-way failure would leave a feed
     carrying a SEQUENCE the database has never heard of. The git data API can
     do it properly: blobs and a tree are staged first, a commit object is
     built on top of the current head, and only the last call moves the branch
     pointer. Either every file lands or none of them do. */

  function ghApi(path, method, payload) {
    var o = {
      method: method,
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + S.token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (payload) { o.body = JSON.stringify(payload); }
    return fetch('https://api.github.com/repos/' + PUBLISH_REPO + path, o).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (tx) {
          throw new Error(r.status + ' ' + path + ' - ' + scrub(tx).slice(0, 160));
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  function commitFiles(map, message) {
    if (!S.publishEnabled) { return Promise.reject(new Error('live publishing is off')); }
    if (!S.token) { return Promise.reject(new Error('no token in this tab')); }

    var paths = Object.keys(map);
    if (!paths.length) { return Promise.reject(new Error('refused: nothing to write')); }
    for (var i = 0; i < paths.length; i++) {
      if (!writablePath(paths[i])) {
        return Promise.reject(new Error('refused: ' + paths[i] + ' is not a file this app may write'));
      }
      if (typeof map[paths[i]] !== 'string' || !map[paths[i]].length) {
        return Promise.reject(new Error('refused: empty content for ' + paths[i]));
      }
    }

    var head = '', baseTree = '', tree = [];

    return ghApi('/git/ref/heads/' + PUBLISH_BRANCH, 'GET')
      .then(function (r) {
        head = r.object.sha;
        return ghApi('/git/commits/' + head, 'GET');
      })
      .then(function (c) {
        baseTree = c.tree.sha;
        return paths.reduce(function (chain, p) {
          return chain.then(function () {
            return ghApi('/git/blobs', 'POST', { content: b64(map[p]), encoding: 'base64' })
              .then(function (b) { tree.push({ path: p, mode: '100644', type: 'blob', sha: b.sha }); });
          });
        }, Promise.resolve());
      })
      .then(function () {
        return ghApi('/git/trees', 'POST', { base_tree: baseTree, tree: tree });
      })
      .then(function (t) {
        return ghApi('/git/commits', 'POST', { message: message, tree: t.sha, parents: [head] });
      })
      .then(function (c) {
        /* The only call that changes anything a subscriber could see. */
        return ghApi('/git/refs/heads/' + PUBLISH_BRANCH, 'PATCH', { sha: c.sha, force: false })
          .then(function () { return { sha: c.sha }; });
      });
  }

  function b64(s) {
    var bytes = new TextEncoder().encode(s);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
    return btoa(bin);
  }

  /* ----------------------------------------------------------------- wiring */

  function wire() {
    installPubState();
    $$('.nav-item').forEach(function (b) {
      on(b, 'click', function () { gotoScreen(b.getAttribute('data-screen')); renderAll(); });
    });
    $$('#viewSeg button').forEach(function (b) {
      on(b, 'click', function () { setView(b.getAttribute('data-view')); });
    });
    $$('#fLang button').forEach(function (b) {
      on(b, 'click', function () { S.lang = b.getAttribute('data-lang'); savePrefs(); renderAll(); });
    });

    on($('#btnToday'), 'click', function () { S.cursor = todayKey(); S.miniCursor = startOfMonth(S.cursor); renderAll(); });
    on($('#btnPrev'), 'click', function () { step(-1); });
    on($('#btnNext'), 'click', function () { step(1); });

    var srch = $('#search');
    var tmr = null;
    on(srch, 'input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () { S.q = srch.value.trim().toLowerCase(); renderAll(); }, 140);
    });

    on($('#btnNew'), 'click', function () { createEvent(S.cursor, 14 * 60); });
    on($('#fab'), 'click', function () { createEvent(S.cursor, 14 * 60); });
    on($('#btnUndo'), 'click', undo);
    on($('#btnMenu'), 'click', function () { $('#sidebar').classList.toggle('open'); });
    on($('#btnFilter'), 'click', function () { $('#sidebar').classList.toggle('collapsed'); });

    on($('#soClose'), 'click', function () { closeEditor(); });
    on($('#soSave'), 'click', saveEditor);
    on($('#soDuplicate'), 'click', function () { if (S.editingId) { duplicateEvent(S.editingId); } });
    on($('#soArchive'), 'click', function () {
      if (!S.editingId) { return; }
      if (archived(byId(S.editingId))) { restoreEvent(S.editingId); renderEditor(); }
      else { archiveEvent(S.editingId); }
    });
        var soFoot = $('.so-foot');
    if (soFoot && !$('#soRemove')) {
      var rmBtn = el('button', 'btn btn-outline', 'Remove permanently');
      rmBtn.id = 'soRemove';
      rmBtn.style.borderColor = '#dc2626';
      rmBtn.style.color = '#dc2626';
      soFoot.appendChild(rmBtn);
    }
    on($('#soRemove'), 'click', function () {
      if (!S.editingId) { return; }
      removeEventPermanently(S.editingId);
    });

    on($('#scrim'), 'click', function () { closeEditor(); $('#sidebar').classList.remove('open'); });

    on($('#btnSelAll'), 'click', function () {
      visible().forEach(function (ev) { S.selected[ev.id] = true; });
      renderList();
    });
    on($('#btnSelNone'), 'click', function () { S.selected = {}; renderList(); });
    on($('#btnMerge'), 'click', mergeSelected);

    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointermove', pointerMove, true);
    document.addEventListener('pointerup', pointerUp, true);
    document.addEventListener('pointercancel', pointerUp, true);

    document.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.editingId) { saveEditor(); }
        return;
      }
      if (e.key === 'Escape') {
        if (!$('#modalRoot').hidden) { closeModal(); }
        else if (S.editingId) { closeEditor(); }
        return;
      }
      if (typing) { return; }
      if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
      if (e.key === 'm') { setView('month'); }
      if (e.key === 'w') { setView('week'); }
      if (e.key === 'd') { setView('day'); }
      if (e.key === 'a') { setView('agenda'); }
      if (e.key === 't') { S.cursor = todayKey(); S.miniCursor = startOfMonth(S.cursor); renderAll(); }
      if (e.key === 'n') { e.preventDefault(); createEvent(S.cursor, 14 * 60); }
      if (e.key === 'ArrowLeft') { step(-1); }
      if (e.key === 'ArrowRight') { step(1); }
    });

    window.addEventListener('beforeunload', function (e) {
      if (!S.leaving && dirtyCount()) { e.preventDefault(); e.returnValue = ''; }
    });
    window.addEventListener('resize', function () {
      if (S.screen === 'calendar' && S.view === 'month') {
        var g = $('.month-grid');
        if (g) { collapseOverflow(g); }
      }
    });
  }

  /* -------------------------------------------------------------- integrity */

  function audit() {
    var problems = [];
    var seen = {};
    (S.db.events || []).forEach(function (ev) {
      Object.keys(ev.uids || {}).forEach(function (k) {
        var u = ev.uids[k];
        if (seen[u]) { problems.push('duplicate UID ' + u); }
        seen[u] = 1;
      });
      pubScheds(ev).forEach(function (s) {
        if (!(ev.uids || {})[s.key]) { problems.push(ev.id + ' publishes to ' + s.key + ' with no UID'); }
      });
      if (!ev.allDay && ev.end <= ev.start) { problems.push(ev.id + ' ends before it starts'); }
    });
    return problems;
  }

  /* ------------------------------------------------------------------ boot */

  function applyPrefs() {
    var p = readPrefs();
    var narrow = window.innerWidth <= 860;
    if (p && p.view) { S.view = p.view; } else if (narrow) { S.view = 'agenda'; }
    if (narrow && S.view === 'week') { S.view = 'agenda'; }
    if (!p) { return; }
    if (p.lang) { S.lang = p.lang; }
    if (p.sched) { S.sched = p.sched; }
    if (p.flags) { S.flags = p.flags; }
  }

  function boot() {
    fetch(DATA_URL + '?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) { throw new Error('events.json ' + r.status); }
        return r.json();
      })
      .then(function (db) {
        S.db = db;
        applyPrefs();

        var d = readDraft();
        var start = function () {
          computeSolo();
          gotoScreen('calendar');
          wire();
          renderAll();
          $('#boot').classList.add('gone');
          $('#app').hidden = false;
          setTimeout(function () { var b = $('#boot'); if (b) { b.remove(); } }, 400);
          var probs = audit();
          if (probs.length) {
            toast(probs.length + ' data integrity warnings - see console', 'err', 6000);
            if (window.console) { console.warn('[admin] integrity', probs); }
          }
        };

        if (d && d.events && d.dirty && Object.keys(d.dirty).length) {
          S.db.events = d.events;
          S.dirty = d.dirty;
          start();
          toast('Restored ' + Object.keys(d.dirty).length + ' unpublished change' +
            (Object.keys(d.dirty).length > 1 ? 's' : '') + ' from this browser', 'ok', 4200);
        } else {
          start();
        }
      })
      .catch(function (e) {
        var b = $('#boot');
        if (b) {
          b.innerHTML = '<div class="warn" style="max-width:420px">Could not load the master database.<br>' +
            esc(e.message) + '</div>';
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

}());
