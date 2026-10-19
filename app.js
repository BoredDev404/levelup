'use strict';
/* LEVEL//UP — vanilla JS, IndexedDB, no network. State in S is loaded from the DB;
   every calculation reads S only (single source of truth), every write goes DB-first. */
const VER = '1.1.0', DBV = 1;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- Dates: local YYYY-MM-DD strings only; never UTC conversion ---------- */
const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addD = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parse(s)) === s;
const dow = s => parse(s).getDay();
const weekStart = s => addD(s, -((dow(s) + 6) % 7)); // weeks start Monday
const fmtLong = s => parse(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = s => parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const pctTxt = p => p == null ? '—' : (Math.round(p * 10) / 10) + '%';
const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];

/* ---------- IndexedDB helper layer ---------- */
const STORES = { habits: 'id', completions: 'id', dopamine: 'id', quests: 'id', questProgress: 'id', settings: 'key' };
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('levelup', DBV);
    // Migrations: add `if (e.oldVersion < 2) {...}` blocks here for future schema changes.
    r.onupgradeneeded = e => {
      const d = r.result, t = r.transaction;
      if (e.oldVersion < 1) {
        for (const [n, k] of Object.entries(STORES)) d.createObjectStore(n, { keyPath: k });
        t.objectStore('completions').createIndex('habitId', 'habitId');
        t.objectStore('completions').createIndex('date', 'date');
        t.objectStore('dopamine').createIndex('date', 'date');
        t.objectStore('questProgress').createIndex('questId', 'questId');
        t.objectStore('questProgress').createIndex('date', 'date');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (names, fn) => new Promise((res, rej) => {
  const t = db.transaction(names, 'readwrite');
  t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('Transaction failed'));
  fn(t);
});
const getAll = n => new Promise((res, rej) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const put = (n, v) => tx(n, t => t.objectStore(n).put(v));
const del = (n, k) => tx(n, t => t.objectStore(n).delete(k));

/* ---------- State ---------- */
const S = { habits: [], done: new Set(), fails: new Set(), quests: [], qp: [], set: {} };
async function loadAll() {
  const [h, c, d, q, qp, st] = await Promise.all(Object.keys(STORES).map(getAll));
  S.habits = h; S.done = new Set(c.map(x => x.id)); S.fails = new Set(d.map(x => x.id));
  S.quests = q; S.qp = qp; S.set = {}; st.forEach(x => S.set[x.key] = x.value);
}
// Habit order: h.order is a unique 0..n-1 position; list order = checklist order everywhere.
async function normOrder() {
  const hs = S.habits.map((h, i) => [h, i]).sort((a, b) => ((a[0].order ?? 1e9) - (b[0].order ?? 1e9)) || a[1] - b[1]).map(x => x[0]), ch = [];
  hs.forEach((h, i) => { if (h.order !== i) { h.order = i; ch.push(h); } });
  S.habits = hs; if (ch.length) await tx('habits', t => ch.forEach(h => t.objectStore('habits').put(h)));
}
async function moveHabit(id, dir) {
  const me = S.habits.find(h => h.id === id), list = S.habits.filter(h => isArchived(h) === isArchived(me));
  const a = me, b = list[list.indexOf(me) + dir]; if (!b) return;
  [a.order, b.order] = [b.order, a.order];
  await tx('habits', t => { t.objectStore('habits').put(a); t.objectStore('habits').put(b); });
  S.habits.sort((x, y) => x.order - y.order);
}
const setSet = async (k, v) => { await put('settings', { key: k, value: v }); S.set[k] = v; };

/* ---------- Habit rules ----------
   A habit counts on date d only if: d >= its own start date, it was not archived on d,
   and the schedule version in force on d includes that weekday. Adding habits later,
   renaming, archiving or re-scheduling therefore never alters older days.
   h.schedules = [{from, mode:'daily'|'days'|'weekly', days:[], n}] sorted by `from`.
   h.off = [[fromDate, toDate|null)] archive periods.
   'weekly' (N times per week) habits are flexible: they are checkable any active day and
   show weekly progress, but are NOT part of the daily percentage (no fixed day to miss). */
const activeOn = (h, d) => d >= h.start && !(h.off || []).some(p => d >= p[0] && (!p[1] || d < p[1]));
const schedAt = (h, d) => { let s = h.schedules[0]; for (const x of h.schedules) if (x.from <= d) s = x; return s; };
const fixedOn = (h, d) => { if (!activeOn(h, d)) return false; const s = schedAt(h, d); return s.mode === 'daily' || (s.mode === 'days' && s.days.includes(dow(d))); };
const weeklyOn = (h, d) => activeOn(h, d) && schedAt(h, d).mode === 'weekly';
const isDone = (h, d) => S.done.has(h.id + '|' + d);
const isCollapsed = id => (S.set.collapsed || []).includes(id);
const isArchived = h => (h.off || []).some(p => !p[1]);
const weekCount = (h, d) => { const w = weekStart(d); let n = 0; for (let i = 0; i < 7; i++) if (isDone(h, addD(w, i))) n++; return n; };
function dayStats(d) {
  const hs = S.habits.filter(h => fixedOn(h, d)), done = hs.filter(h => isDone(h, d));
  return { hs, total: hs.length, n: done.length, pct: hs.length ? done.length / hs.length * 100 : null };
}
function habitStats(h) {
  const t = today(); let run = 0, best = 0, sched = 0, done = 0, all = 0;
  for (const k of S.done) if (k.startsWith(h.id + '|')) all++;
  for (let d = h.start; d <= t; d = addD(d, 1)) {
    if (!fixedOn(h, d)) continue; sched++;
    if (isDone(h, d)) { done++; run++; best = Math.max(best, run); } else if (d !== t) run = 0; // today unticked doesn't break streak yet
  }
  return { cur: run, best, sched, done, all, rate: sched ? done / sched * 100 : null };
}
const schedText = s => s.mode === 'daily' ? 'Every day' : s.mode === 'weekly' ? `${s.n}× per week (flexible)` : DAYS.filter(x => s.days.includes(x[1])).map(x => x[0]).join(', ');

/* ---------- Dopamine rules: only failures are stored; elapsed days default to success ---------- */
const dopStart = () => S.set.dopStart || today();
const dopFail = d => S.fails.has(d);
function dopStats(y, m) {
  const t = today(), st = dopStart(); let run = 0, best = 0, succ = 0, fail = 0, num = 0, den = 0;
  for (let d = st; d <= t; d = addD(d, 1)) { if (dopFail(d)) { fail++; run = 0; } else { succ++; run++; if (run > best) best = run; } }
  if (y != null) {
    const f = `${y}-${p2(m + 1)}-01`, l = `${y}-${p2(m + 1)}-${p2(new Date(y, m + 1, 0).getDate())}`;
    for (let d = f < st ? st : f; d <= l && d <= t; d = addD(d, 1)) { den++; if (!dopFail(d)) num++; }
  }
  return { cur: run, best, succ, fail, num, den, rate: den ? num / den * 100 : null };
}

/* ---------- Quest rules ---------- */
const qEntries = q => S.qp.filter(e => e.questId === q.id);
function qProg(q) {
  const es = qEntries(q), t = today();
  if (q.type === 'milestones') {
    const has = m => es.some(e => e.type === 'milestone' && e.ref === m.id);
    const done = q.milestones.filter(has).length, next = q.milestones.find(m => !has(m));
    const vals = es.filter(e => e.type === 'milestone' && e.value != null).map(e => e.value);
    const meas = vals.length ? Math.max(...vals) : null;
    return { pct: q.milestones.length ? done / q.milestones.length * 100 : 0, next: next && next.label,
      label: `${done}/${q.milestones.length} milestones` + (q.targetValue ? ` · best ${meas == null ? '—' : meas}/${q.targetValue} ${q.unit || ''}` : '') };
  }
  const ses = es.filter(e => e.type === 'session'), wk = ses.filter(e => e.date >= weekStart(t)).length;
  return { pct: Math.min(100, ses.length / q.totalTarget * 100), wk, n: ses.length,
    label: `${ses.length}/${q.totalTarget} sessions · week ${wk}/${q.perWeek}` };
}

/* ---------- UI state & helpers ---------- */
const nowD = new Date();
const mo0 = () => ({ y: nowD.getFullYear(), m: nowD.getMonth() });
const ui = { tab: 'dash', sel: today(), mo: { dash: mo0(), dop: mo0(), hd: mo0() }, hab: null, quest: null, sheet: null };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }
const mnav = k => `<div class="mnav"><button data-act="mprev" data-k="${k}" aria-label="Previous month">‹</button><strong>${new Date(ui.mo[k].y, ui.mo[k].m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong><button data-act="mnext" data-k="${k}" aria-label="Next month">›</button><button data-act="mtoday" data-k="${k}">Today</button></div>`;
function cal(y, m, cellFn, act, x = '') {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate(), t = today();
  let h = '<div class="cal">' + 'MTWTFSS'.split('').map(x => `<b class="dn" aria-hidden="true">${x}</b>`).join('');
  for (let i = 0; i < lead; i++) h += '<i></i>';
  for (let d = 1; d <= n; d++) {
    const s = `${y}-${p2(m + 1)}-${p2(d)}`, c = cellFn(s);
    h += `<button class="cell ${c.cls}${s === t ? ' today' : ''}" data-act="${act}" data-d="${s}" ${x} aria-label="${fmtShort(s)}: ${esc(c.aria)}"><span>${d}</span><small>${c.txt}</small></button>`;
  }
  return h + '</div>';
}
const bar = p => `<div class="bar" role="progressbar" aria-valuenow="${Math.round(p)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>`;

/* ---------- Views ---------- */
function checklist(d, noSum) {
  const fut = d > today(), st = dayStats(d), wk = S.habits.filter(h => weeklyOn(h, d));
  const row = (h, x) => `<label class="tile${isDone(h, d) ? ' on' : ''}"><input type="checkbox" data-act="tog" data-h="${h.id}" data-d="${d}" ${isDone(h, d) ? 'checked' : ''} ${fut ? 'disabled' : ''}><span>${esc(h.name)}${x || ''}</span></label>`;
  return (noSum ? '' : `<div class="sum"><b>${pctTxt(st.pct)}</b>${st.n}/${st.total} completed · ${st.total - st.n} remaining${fut ? ' · future date' : ''}</div>`)
    + (st.hs.map(h => row(h)).join('') || '<p class="empty">No habits scheduled for this day.</p>')
    + (wk.length ? '<h3>Flexible weekly habits (not in daily %)</h3>' + wk.map(h => row(h, ` <small>${weekCount(h, d)}/${schedAt(h, d).n} this week</small>`)).join('') : '');
}
function vDash() {
  const t = today(), st = dayStats(t), d = dopStats(), aq = S.quests.filter(q => q.status === 'active');
  const avg = aq.length ? aq.reduce((a, q) => a + qProg(q).pct, 0) / aq.length : null, { y, m } = ui.mo.dash;
  const dashCell = s => {
    if (s > t) return { cls: 'fut', txt: '', aria: 'future' };
    const x = dayStats(s); if (x.pct == null) return { cls: 'fut', txt: '—', aria: 'no habits' };
    const cls = x.pct >= 100 ? 'ok' : (s === t || x.n) ? 'part' : 'bad'; // today stays neutral until the day is over
    return { cls, txt: Math.round(x.pct) + '%', aria: `${x.n} of ${x.total} done` };
  };
  return `<header class="top"><div><h1>LEVEL//UP</h1><p>${fmtLong(t)}</p></div><button class="btn sm alt" data-act="settings">Settings</button></header>
<section class="card hero"><span class="lbl">Today's habits</span><div class="big">${pctTxt(st.pct)}</div>${bar(st.pct || 0)}
<p>${st.total ? `${st.n} done · ${st.total - st.n} remaining` : 'No habits scheduled today. Add one in Habits.'}</p></section>
<div class="grid2"><div class="card"><span class="lbl">Dopamine streak</span><div class="big m">${d.cur}d</div><p>best ${d.best}d</p></div>
<div class="card"><span class="lbl">Active quests</span><div class="big m">${aq.length}</div><p>${avg == null ? 'none yet' : Math.round(avg) + '% avg progress'}</p></div></div>
<section class="card"><h2>Habit calendar</h2>${mnav('dash')}${cal(y, m, dashCell, 'dday')}<p class="legend">Lime = all done · Yellow = partial/today · Red = missed (0 done) · Grey = future or none. Tap a day to view or fix it.</p></section>
<section class="card"><h2>Active quests</h2>${aq.length ? aq.map(q => qCard(q, true)).join('') : '<p class="empty">No active quests. Start one in Quests.</p>'}</section>`;
}
function vDop() {
  const { y, m } = ui.mo.dop, s = dopStats(y, m), t = today(), st = dopStart();
  const c = d => d > t ? { cls: 'fut', txt: '', aria: 'future' } : d < st ? { cls: 'off', txt: '', aria: 'before tracking' } : dopFail(d) ? { cls: 'bad', txt: '✗', aria: 'unsuccessful' } : { cls: 'ok', txt: '✓', aria: 'successful' };
  return `<header class="top"><div><h1>Dopamine</h1><p>Private tracker. Unmarked past days count as successful.</p></div></header>
<div class="grid2"><div class="card hero"><span class="lbl">Current streak</span><div class="big m">${s.cur}d</div></div><div class="card"><span class="lbl">Best streak</span><div class="big m">${s.best}d</div></div></div>
<div class="grid2"><div class="card"><span class="lbl">Successes</span><div class="big m">${s.succ}</div></div><div class="card"><span class="lbl">Failures</span><div class="big m">${s.fail}</div></div></div>
<section class="card"><span class="lbl">This month</span><div class="big m">${pctTxt(s.rate)}</div><p>${s.den ? `${s.num}/${s.den} successful days` : 'No elapsed days yet this month'}</p></section>
<section class="card">${mnav('dop')}${cal(y, m, c, 'dopday')}<p class="legend">✓ Green = successful · ✗ Red = unsuccessful · Grey = future. Tap a past day to change it.</p>
<label class="f" for="ds">Tracking since</label><input id="ds" type="date" value="${st}" max="${t}" data-act="dopstart"></section>`;
}
const hCell = h => d => {
  const t = today();
  if (d > t) return { cls: 'fut', txt: '', aria: 'future' };
  if (!activeOn(h, d)) return { cls: 'off', txt: '·', aria: 'not active' };
  if (isDone(h, d)) return { cls: 'ok', txt: '✓', aria: 'done' };
  if (fixedOn(h, d)) return d === t ? { cls: 'part', txt: '', aria: 'today, not done' } : { cls: 'bad', txt: '✗', aria: 'missed' };
  return { cls: 'off', txt: '·', aria: 'not scheduled' };
};
function hCard(h, y, m) {
  const t = today(), s = habitStats(h), arch = isArchived(h), col = isCollapsed(h.id);
  const list = S.habits.filter(x => isArchived(x) === arch), i = list.indexOf(h), nm = esc(h.name);
  return `<article class="hcard${arch ? ' arch' : ''}"><div class="hh"><div class="hmeta"><button class="lnk" data-act="hopen" data-h="${h.id}"><b>${nm}</b></button><small>${esc(schedText(schedAt(h, t)))}${h.cat ? ' · ' + esc(h.cat) : ''}</small></div>
<div class="chips">${s.sched ? `<span class="chip">${s.cur}d streak</span><span class="chip">${pctTxt(s.rate)}</span>` : `<span class="chip">${s.all} done</span>`}${arch ? '<span class="chip">archived</span>' : ''}</div></div>
<div class="hctl"><button class="ib" data-act="hmove" data-h="${h.id}" data-dir="-1" aria-label="Move ${nm} up" ${i === 0 ? 'disabled' : ''}>▲</button><button class="ib" data-act="hmove" data-h="${h.id}" data-dir="1" aria-label="Move ${nm} down" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
${arch ? '<button class="btn sm alt grow" data-act="hopen" data-h="' + h.id + '">History</button>' : `<button class="btn sm alt grow" data-act="hcol" data-h="${h.id}" aria-expanded="${!col}">${col ? '▸ Show month' : '▾ Hide month'}</button>`}<button class="btn sm alt" data-act="edithab" data-h="${h.id}">Edit</button></div>
${arch || col ? '' : `<div class="mini">${cal(y, m, hCell(h), 'hday', `data-h="${h.id}"`)}</div>`}</article>`;
}
function vHab() {
  const d = ui.sel, t = today(), st = dayStats(d), act = S.habits.filter(h => !isArchived(h)), arc = S.habits.filter(isArchived), { y, m } = ui.mo.hd;
  return `<header class="top"><div><h1>Habits</h1><p>${act.length} active</p></div><button class="btn sm" data-act="newhab">+ New habit</button></header>
<div class="mnav"><button data-act="dprev" aria-label="Previous day">‹</button><strong>${d === t ? 'Today · ' : ''}${fmtShort(d)}</strong><button data-act="dnext" aria-label="Next day">›</button><button data-act="dtoday">Today</button></div>
<section class="card hero"><span class="lbl">${d === t ? 'Today' : fmtShort(d)}</span><div class="big">${pctTxt(st.pct)}</div>${bar(st.pct || 0)}<p>${st.total ? `${st.n}/${st.total} done · ${st.total - st.n} remaining` : 'Nothing scheduled this day'}</p></section>
<section class="checks">${checklist(d, true)}</section>
<div class="sech"><h2>All habits</h2><div class="btns tight"><button class="btn sm alt" data-act="hall" data-v="0">Expand</button><button class="btn sm alt" data-act="hall" data-v="1">Collapse</button></div></div>
${act.length ? mnav('hd') : '<p class="empty">No habits yet. Tap “+ New habit” to start.</p>'}
${act.map(h => hCard(h, y, m)).join('')}${arc.length ? '<div class="sech"><h2>Archived</h2></div>' + arc.map(h => hCard(h, y, m)).join('') : ''}`;
}
const qCard = (q, mini) => {
  const p = qProg(q), quick = q.type === 'milestones' ? (p.next ? `<button class="btn sm" data-act="qnext" data-q="${q.id}">✓ Complete: ${esc(p.next)}</button>` : '') : `<button class="btn sm" data-act="qsess" data-q="${q.id}">+ Session today</button>`;
  return `<article class="card q ${q.status}"><div class="qh"><button class="lnk" data-act="qopen" data-q="${q.id}"><b>${esc(q.name)}</b></button><span class="tag">${q.status}</span></div>${bar(p.pct)}
<div class="qm"><b>${Math.round(p.pct)}%</b><span>${esc(p.label)}</span></div>${p.next ? `<p>Next: ${esc(p.next)}</p>` : ''}${!mini && q.status === 'active' ? `<div class="btns">${quick}</div>` : ''}</article>`;
};
function vQuest() {
  const g = s => S.quests.filter(q => q.status === s);
  return `<header class="top"><div><h1>Side Quests</h1></div></header><button class="btn wide" data-act="qnew">+ New quest</button>
${S.quests.length ? '' : '<p class="empty">No quests yet. Try “20 push-ups” (milestones) or “Handstand practice” (sessions).</p>'}
${['active', 'paused', 'completed', 'archived'].map(s => g(s).length ? `<h2>${s[0].toUpperCase() + s.slice(1)}</h2>` + g(s).map(q => qCard(q)).join('') : '').join('')}`;
}
function vHD() {
  const h = S.habits.find(x => x.id === ui.hab); if (!h) return '';
  const s = habitStats(h), { y, m } = ui.mo.hd, t = today();
  const c = hCell(h);
  return `<h2>${esc(h.name)}</h2><p>${esc(schedText(schedAt(h, t)))}${isArchived(h) ? ' · ARCHIVED' : ''}<br>Since ${fmtShort(h.start)}${h.desc ? '<br>' + esc(h.desc) : ''}</p>
<div class="grid3"><div class="stat"><b>${s.cur}</b><span>streak</span></div><div class="stat"><b>${s.best}</b><span>best</span></div><div class="stat"><b>${s.sched ? pctTxt(s.rate) : '—'}</b><span>${s.done}/${s.sched} scheduled</span></div></div>
<p class="note">Total completions: ${s.all}</p>${mnav('hd')}${cal(y, m, c, 'hday')}<p class="legend">✓ done · ✗ missed · · not scheduled/inactive. Tap an active past day to correct it.</p>
<div class="btns"><button class="btn alt" data-act="edithab" data-h="${h.id}">Edit</button><button class="btn ${isArchived(h) ? '' : 'red'}" data-act="harch" data-h="${h.id}">${isArchived(h) ? 'Restore' : 'Archive'}</button></div>`;
}
function habitForm(h) {
  const s = h ? schedAt(h, today()) : { mode: 'daily', days: [], n: 3 };
  return `<h2>${h ? 'Edit habit' : 'New habit'}</h2><form data-form="habit"><input type="hidden" name="id" value="${h ? h.id : ''}">
<label class="f" for="hn">Name</label><input id="hn" name="name" required maxlength="60" value="${esc(h && h.name)}">
<label class="f" for="hdsc">Description (optional)</label><input id="hdsc" name="desc" maxlength="120" value="${esc(h && h.desc)}">
<label class="f" for="hc">Category (optional)</label><input id="hc" name="cat" maxlength="30" value="${esc(h && h.cat)}">
${h ? '' : `<label class="f" for="hs">Start date</label><input id="hs" type="date" name="start" value="${today()}" required>`}
<label class="f" for="hm">Schedule</label><select id="hm" name="mode"><option value="daily"${s.mode === 'daily' ? ' selected' : ''}>Every day</option><option value="days"${s.mode === 'days' ? ' selected' : ''}>Specific weekdays</option><option value="weekly"${s.mode === 'weekly' ? ' selected' : ''}>N times per week (flexible)</option></select>
<label class="f">Weekdays (for “specific weekdays”)</label><div class="days">${DAYS.map(([n, i]) => `<label><input type="checkbox" name="days" value="${i}"${s.days.includes(i) ? ' checked' : ''}>${n}</label>`).join('')}</div>
<label class="f" for="hnn">Times per week (for “N times per week”)</label><input id="hnn" type="number" name="n" min="1" max="7" value="${s.n || 3}">
${h ? '<p class="note">Schedule changes apply from today. Past days keep their original schedule.</p>' : ''}
<div class="btns"><button class="btn" type="submit">Save habit</button></div></form>`;
}
function questForm(q) {
  const ty = q ? q.type : 'milestones';
  return `<h2>${q ? 'Edit quest' : 'New quest'}</h2><form data-form="quest"><input type="hidden" name="id" value="${q ? q.id : ''}">
<label class="f" for="qn">Name</label><input id="qn" name="name" required maxlength="80" value="${esc(q && q.name)}">
<label class="f" for="qd">Description (optional)</label><input id="qd" name="desc" maxlength="200" value="${esc(q && q.desc)}">
<label class="f" for="qc">Category (optional)</label><input id="qc" name="cat" maxlength="30" value="${esc(q && q.cat)}">
<label class="f" for="qs">Start date</label><input id="qs" type="date" name="start" required value="${q ? q.start : today()}">
<label class="f" for="qt">Target date (optional)</label><input id="qt" type="date" name="target" value="${esc(q && q.target)}">
<label class="f" for="qty">Quest type</label><select id="qty" name="type"><option value="milestones"${ty === 'milestones' ? ' selected' : ''}>Milestones</option><option value="sessions"${ty === 'sessions' ? ' selected' : ''}>Repeated sessions</option></select>
<h3>Milestones type</h3><label class="f" for="qm">Milestones (one per line)</label><textarea id="qm" name="ms">${esc(q && q.milestones ? q.milestones.map(m => m.label).join('\n') : '')}</textarea>
<label class="f" for="qu">Measured unit (optional, e.g. push-ups)</label><input id="qu" name="unit" maxlength="20" value="${esc(q && q.unit)}">
<label class="f" for="qv">Target value (optional)</label><input id="qv" type="number" name="tv" min="0" step="any" value="${q && q.targetValue ? q.targetValue : ''}">
<h3>Sessions type</h3><label class="f" for="qw">Sessions per week</label><input id="qw" type="number" name="pw" min="1" max="21" value="${q && q.perWeek ? q.perWeek : 3}">
<label class="f" for="qtt">Total sessions goal</label><input id="qtt" type="number" name="tt" min="1" max="1000" value="${q && q.totalTarget ? q.totalTarget : 36}">
<div class="btns"><button class="btn" type="submit">Save quest</button></div></form>`;
}
function vQD() {
  const q = S.quests.find(x => x.id === ui.quest); if (!q) return '';
  const p = qProg(q), es = qEntries(q), t = today();
  let body = '';
  if (q.type === 'milestones') {
    body = q.milestones.map(m => { const e = es.find(x => x.type === 'milestone' && x.ref === m.id);
      return `<div class="row"><input type="checkbox" data-act="mstone" data-q="${q.id}" data-m="${m.id}" aria-label="${esc(m.label)}" ${e ? 'checked' : ''}><span>${esc(m.label)}${e ? ` <small>${e.date}</small>` : ''}</span><input class="mv" id="mv-${m.id}" type="number" step="any" placeholder="${esc(q.unit || 'value')}" aria-label="Measured value for ${esc(m.label)}" value="${e && e.value != null ? e.value : ''}" data-act="mval" data-q="${q.id}" data-m="${m.id}"></div>`; }).join('');
  } else {
    body = `<p><b>This week:</b> ${p.wk}/${q.perWeek} sessions</p><div class="btns"><button class="btn" data-act="qsess" data-q="${q.id}">+ Session today</button><button class="btn alt" data-act="qundo" data-q="${q.id}">Undo last</button></div>`;
  }
  const st = q.status;
  return `<h2>${esc(q.name)}</h2><p>${esc(q.desc || '')}${q.cat ? ' · ' + esc(q.cat) : ''}<br>Since ${fmtShort(q.start)}${q.target ? ' · target ' + fmtShort(q.target) : ''} · ${st}</p>
${bar(p.pct)}<div class="qm"><b>${Math.round(p.pct)}%</b><span>${esc(p.label)}</span></div>${body}
<div class="btns"><button class="btn alt" data-act="qedit" data-q="${q.id}">Edit</button>
${st === 'active' ? `<button class="btn alt" data-act="qstat" data-q="${q.id}" data-s="paused">Pause</button><button class="btn" data-act="qstat" data-q="${q.id}" data-s="completed">Complete</button>` : `<button class="btn" data-act="qstat" data-q="${q.id}" data-s="active">Reactivate</button>`}
${st !== 'archived' ? `<button class="btn alt" data-act="qstat" data-q="${q.id}" data-s="archived">Archive</button>` : ''}
<button class="btn red" data-act="qdel" data-q="${q.id}">Delete</button></div>`;
}

/* ---------- Rendering ---------- */
function render() {
  const v = { dash: vDash, dop: vDop, hab: vHab, quest: vQuest }[ui.tab];
  $('#app').innerHTML = (ui.fatal ? `<div class="banner">${esc(ui.fatal)}</div>` : '') + v();
  document.querySelectorAll('#nav button').forEach(b => b.dataset.t === ui.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
}
const openSheet = fn => { ui.sheet = fn; renderSheet(); };
function renderSheet() { if (!ui.sheet) return; $('#sbody').innerHTML = ui.sheet(); $('#sheet').hidden = false; }
function closeSheet() { ui.sheet = null; $('#sheet').hidden = true; }
const refresh = () => { render(); renderSheet(); };

/* ---------- Actions ---------- */
async function toggleHabit(hid, d) {
  const h = S.habits.find(x => x.id === hid), id = hid + '|' + d;
  if (!h || d > today() || !validDate(d) || !activeOn(h, d)) return toast('Not editable on that date');
  if (S.done.has(id)) { await del('completions', id); S.done.delete(id); }
  else { await put('completions', { id, habitId: hid, date: d }); S.done.add(id); }
}
async function saveHabit(f) {
  const fd = new FormData(f), name = fd.get('name').trim(); if (!name) return toast('Enter a name');
  const mode = fd.get('mode'), days = fd.getAll('days').map(Number), n = Math.min(7, Math.max(1, +fd.get('n') || 3));
  if (mode === 'days' && !days.length) return toast('Pick at least one weekday');
  const sch = { mode, days: mode === 'days' ? days : [], n: mode === 'weekly' ? n : 0 };
  const fields = { name, desc: fd.get('desc').trim(), cat: fd.get('cat').trim() }, id = fd.get('id');
  let h = id && S.habits.find(x => x.id === id);
  if (h) {
    const cur = schedAt(h, today());
    if (JSON.stringify([cur.mode, cur.days, cur.n]) !== JSON.stringify([sch.mode, sch.days, sch.n])) {
      const from = today() > h.start ? today() : h.start; // effective-dated: history keeps old version
      h.schedules = h.schedules.filter(x => x.from < from).concat({ from, ...sch });
    }
    Object.assign(h, fields);
  } else {
    const start = fd.get('start'); if (!validDate(start)) return toast('Invalid start date');
    h = { id: uid(), ...fields, start, schedules: [{ from: start, ...sch }], off: [], order: S.habits.length };
    if (S.habits.some(x => x.name.toLowerCase() === name.toLowerCase() && !isArchived(x))) return toast('A habit with that name already exists');
    S.habits.push(h);
  }
  await put('habits', h); closeSheet(); refresh(); toast('Habit saved');
}
async function saveQuest(f) {
  const fd = new FormData(f), name = fd.get('name').trim(), start = fd.get('start'), target = fd.get('target'), type = fd.get('type');
  if (!name) return toast('Enter a name'); if (!validDate(start)) return toast('Invalid start date');
  if (target && (!validDate(target) || target < start)) return toast('Target date must be on/after start');
  const id = fd.get('id'); let q = id && S.quests.find(x => x.id === id);
  const old = q && q.milestones || [], labels = fd.get('ms').split('\n').map(x => x.trim()).filter(Boolean);
  const o = { name, desc: fd.get('desc').trim(), cat: fd.get('cat').trim(), start, target: target || '', type, unit: fd.get('unit').trim(), targetValue: +fd.get('tv') || 0 };
  if (type === 'milestones') {
    if (!labels.length) return toast('Add at least one milestone');
    o.milestones = labels.map(l => { const m = old.find(x => x.label === l); return m || { id: uid(), label: l }; }); // keep ids so progress survives edits
  } else {
    o.perWeek = Math.max(1, +fd.get('pw') || 1); o.totalTarget = Math.max(1, +fd.get('tt') || 1); o.milestones = old;
  }
  if (q) Object.assign(q, o); else { q = { id: uid(), status: 'active', ...o }; S.quests.push(q); }
  await put('quests', q); closeSheet(); refresh(); toast('Quest saved');
}
const addEntry = async e => { e.id = uid(); await put('questProgress', e); S.qp.push(e); };
const dl = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
async function exportData() {
  const data = {}; for (const n of Object.keys(STORES)) data[n] = await getAll(n);
  dl(`levelup-backup-${today()}.json`, JSON.stringify({ app: 'levelup', schema: DBV, version: VER, exported: new Date().toISOString(), data }, null, 1));
  await setSet('lastExport', today()); toast('Backup downloaded'); refresh();
}
function validateImport(o) {
  const bad = m => { throw new Error(m); }, A = k => Array.isArray(o.data && o.data[k]) ? o.data[k] : bad('Missing ' + k);
  if (!o || o.app !== 'levelup') bad('Not a LEVEL//UP backup'); if (typeof o.schema !== 'number' || o.schema > DBV) bad('Unsupported schema version');
  const d = {};
  d.habits = A('habits').map(h => { if (!h.id || !h.name || !validDate(h.start) || !Array.isArray(h.schedules) || !h.schedules.length || !h.schedules.every(s => validDate(s.from) && ['daily', 'days', 'weekly'].includes(s.mode))) bad('Invalid habit'); h.schedules.sort((a, b) => a.from < b.from ? -1 : 1); h.off = Array.isArray(h.off) ? h.off : []; return h; });
  d.completions = A('completions').map(c => { if (!c.habitId || !validDate(c.date)) bad('Invalid completion'); return { id: c.habitId + '|' + c.date, habitId: c.habitId, date: c.date }; });
  d.dopamine = A('dopamine').map(x => { if (!validDate(x.id || x.date)) bad('Invalid dopamine entry'); const k = x.id || x.date; return { id: k, date: k, status: 'fail' }; });
  d.quests = A('quests').map(q => { if (!q.id || !q.name || !validDate(q.start) || !['milestones', 'sessions'].includes(q.type) || !['active', 'paused', 'completed', 'archived'].includes(q.status) || !Array.isArray(q.milestones || [])) bad('Invalid quest'); q.milestones = q.milestones || []; return q; });
  d.questProgress = A('questProgress').map(e => { if (!e.id || !e.questId || !validDate(e.date) || !['session', 'milestone'].includes(e.type)) bad('Invalid quest progress'); return e; });
  d.settings = A('settings').map(s => { if (typeof s.key !== 'string') bad('Invalid setting'); return s; });
  return d;
}
async function importData(file) {
  try {
    const d = validateImport(JSON.parse(await file.text()));
    const msg = `Replace ALL current data with this backup?\n${d.habits.length} habits, ${d.completions.length} check-ins, ${d.dopamine.length} dopamine entries, ${d.quests.length} quests.\nThis cannot be undone (export a backup first if unsure).`;
    if (!confirm(msg)) return toast('Import cancelled');
    await tx(Object.keys(STORES), t => { for (const n of Object.keys(STORES)) { const s = t.objectStore(n); s.clear(); d[n].forEach(v => s.put(v)); } });
    await loadAll(); await normOrder(); closeSheet(); refresh(); toast('Backup imported');
  } catch (e) { toast('Import failed: ' + e.message); }
}
async function settingsSheet() {
  let per = false; try { per = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) {}
  openSheet(() => `<h2>Settings</h2><h3>Backup</h3><p class="note">Last export: ${S.set.lastExport || 'never'}. Export a backup regularly — clearing browser data or uninstalling can erase everything.</p>
<div class="btns"><button class="btn" data-act="export">Export JSON</button><label class="btn alt" style="display:inline-flex;align-items:center">Import JSON<input type="file" accept="application/json,.json" data-act="import" hidden></label></div>
<h3>Storage</h3><p class="note">Data lives only on this device in IndexedDB (not synced to any cloud). Persistent storage: ${per ? 'granted' : 'not granted'}.</p>
<h3>Privacy</h3><p class="note">No accounts, analytics or network requests for your data. Nothing leaves your device unless you export a file yourself.</p>
<h3>About</h3><p class="note">LEVEL//UP v${VER} · schema ${DBV}</p>`);
}

const A = {
  tab: el => { ui.tab = el.dataset.t; render(); scrollTo(0, 0); },
  close: closeSheet,
  mprev: el => { const o = ui.mo[el.dataset.k]; if (--o.m < 0) { o.m = 11; o.y--; } refresh(); },
  mnext: el => { const o = ui.mo[el.dataset.k]; if (++o.m > 11) { o.m = 0; o.y++; } refresh(); },
  mtoday: el => { ui.mo[el.dataset.k] = mo0(); refresh(); },
  dprev: () => { ui.sel = addD(ui.sel, -1); render(); }, dnext: () => { ui.sel = addD(ui.sel, 1); render(); }, dtoday: () => { ui.sel = today(); render(); },
  dday: el => { const d = el.dataset.d; openSheet(() => `<h2>${fmtLong(d)}</h2>` + checklist(d)); },
  tog: async el => { await toggleHabit(el.dataset.h, el.dataset.d); refresh(); },
  newhab: () => openSheet(() => habitForm(null)),
  edithab: el => { const h = S.habits.find(x => x.id === el.dataset.h); openSheet(() => habitForm(h)); },
  hopen: el => { ui.hab = el.dataset.h; ui.mo.hd = mo0(); openSheet(vHD); },
  hday: async el => { await toggleHabit(el.dataset.h || ui.hab, el.dataset.d); refresh(); },
  hmove: async el => { await moveHabit(el.dataset.h, +el.dataset.dir); refresh(); },
  hcol: async el => { const id = el.dataset.h, c = new Set(S.set.collapsed || []); c.has(id) ? c.delete(id) : c.add(id); await setSet('collapsed', [...c]); refresh(); },
  hall: async el => { await setSet('collapsed', el.dataset.v === '1' ? S.habits.map(h => h.id) : []); refresh(); },
  harch: async el => {
    const h = S.habits.find(x => x.id === el.dataset.h), t = today(); h.off = h.off || [];
    if (isArchived(h)) h.off[h.off.length - 1][1] = t; // restore: history gap stays inactive
    else { if (!confirm('Archive this habit? Its history is kept.')) return; h.off.push([t, null]); }
    await put('habits', h); refresh(); toast(isArchived(h) ? 'Archived' : 'Restored');
  },
  dopday: el => {
    const d = el.dataset.d; if (d > today()) return toast('Future dates can’t be marked');
    openSheet(() => `<h2>${fmtLong(d)}</h2><p>Currently: <b>${dopFail(d) ? 'Unsuccessful' : 'Successful'}</b></p><div class="btns"><button class="btn" data-act="dopset" data-d="${d}" data-v="ok">Successful</button><button class="btn red" data-act="dopset" data-d="${d}" data-v="fail">Unsuccessful</button></div>`);
  },
  dopset: async el => {
    const d = el.dataset.d;
    if (el.dataset.v === 'fail') { await put('dopamine', { id: d, date: d, status: 'fail' }); S.fails.add(d); } else { await del('dopamine', d); S.fails.delete(d); }
    if (d < dopStart()) await setSet('dopStart', d);
    closeSheet(); refresh(); toast('Saved');
  },
  dopstart: async el => { if (!validDate(el.value) || el.value > today()) return toast('Invalid date'); await setSet('dopStart', el.value); refresh(); toast('Start date saved'); },
  qnew: () => openSheet(() => questForm(null)),
  qedit: el => { const q = S.quests.find(x => x.id === el.dataset.q); openSheet(() => questForm(q)); },
  qopen: el => { ui.quest = el.dataset.q; openSheet(vQD); },
  qnext: async el => { const q = S.quests.find(x => x.id === el.dataset.q), n = qProg(q).next; if (!n) return; await addEntry({ questId: q.id, date: today(), type: 'milestone', ref: q.milestones.find(m => m.label === n).id, value: null }); refresh(); toast('Milestone complete'); },
  qsess: async el => { await addEntry({ questId: el.dataset.q, date: today(), type: 'session', ref: null, value: null }); refresh(); toast('Session logged'); },
  qundo: async el => { const l = qEntries({ id: el.dataset.q }).filter(e => e.type === 'session').sort((a, b) => a.date < b.date ? -1 : 1).pop(); if (!l) return toast('No sessions to undo'); await del('questProgress', l.id); S.qp = S.qp.filter(e => e.id !== l.id); refresh(); },
  mstone: async el => {
    const { q, m } = el.dataset, e = S.qp.find(x => x.questId === q && x.type === 'milestone' && x.ref === m);
    if (e) { await del('questProgress', e.id); S.qp = S.qp.filter(x => x !== e); }
    else { const v = parseFloat($('#mv-' + m).value); await addEntry({ questId: q, date: today(), type: 'milestone', ref: m, value: isNaN(v) ? null : v }); }
    refresh();
  },
  mval: async el => { const e = S.qp.find(x => x.questId === el.dataset.q && x.type === 'milestone' && x.ref === el.dataset.m), v = parseFloat(el.value); if (!e) return toast('Tick the milestone first'); e.value = isNaN(v) ? null : v; await put('questProgress', e); refresh(); },
  qstat: async el => { const q = S.quests.find(x => x.id === el.dataset.q); q.status = el.dataset.s; await put('quests', q); refresh(); toast('Quest ' + q.status); },
  qdel: async el => {
    const q = S.quests.find(x => x.id === el.dataset.q); if (!confirm(`Delete “${q.name}” and all its progress? This cannot be undone.`)) return;
    const ids = qEntries(q).map(e => e.id);
    await tx(['quests', 'questProgress'], t => { t.objectStore('quests').delete(q.id); ids.forEach(i => t.objectStore('questProgress').delete(i)); });
    S.quests = S.quests.filter(x => x !== q); S.qp = S.qp.filter(e => e.questId !== q.id); closeSheet(); refresh(); toast('Quest deleted');
  },
  settings: settingsSheet, export: exportData,
  import: el => { if (el.files[0]) importData(el.files[0]); el.value = ''; },
};
const run = async (el, ev) => {
  const f = A[el.dataset.act]; if (!f) return;
  try { await f(el, ev); } catch (e) { console.error(e); toast('Storage error: change may not be saved (' + (e && e.message || e) + ')'); }
};
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') run(el, e); });
document.addEventListener('change', e => { const el = e.target; if (el.dataset && el.dataset.act && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) run(el, e); });
document.addEventListener('submit', e => { const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); (f.dataset.form === 'habit' ? saveHabit : saveQuest)(f).catch(x => toast('Storage error: ' + x.message)); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

(async function init() {
  try {
    db = await openDB(); await loadAll(); await normOrder();
    if (!S.set.dopStart) await setSet('dopStart', today());
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { ui.fatal = 'Storage unavailable (private mode or blocked?). Nothing you enter will be saved. ' + (e && e.message || ''); }
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('service-worker.js').catch(() => {});
})();
