"use strict";
/* SKS Trainer – Logik (offline, PWA). Daten aus window.SKS_DATA (data.js). */

const DATA = (window.SKS_DATA || []).slice();
const TOTAL = DATA.length;
const PASS = 39, ORAL = 33;            // Schwellen pro Bogen (60 P)
const BOXES = [0, 1, 2, 4, 7];          // Leitner-Intervalle (Tage) für Box 1..5
const DAY = 86400000;
const boegen = [...new Set(DATA.map(q => q.bogen))].sort((a, b) => a - b);
const byId = Object.fromEntries(DATA.map(q => [q.id, q]));

/* ---------- Persistenz ---------- */
const PKEY = "sks_v2";
function loadState() {
  try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { return {}; }
}
let S = loadState();
S.cards = S.cards || {};            // id -> {box,seen,correct,last}
S.stats = S.stats || {};            // 'YYYY-MM-DD' -> {answered,correct,points:[...]}
S.settings = S.settings || {};      // {token,gistId}
function save() { localStorage.setItem(PKEY, JSON.stringify(S)); }
function card(id) { return S.cards[id] || { box: 1, seen: 0, correct: 0, last: 0 }; }
function isDue(id) { const c = S.cards[id]; if (!c) return true; return Date.now() - c.last >= BOXES[c.box - 1] * DAY; }
function mastered(id) { const c = S.cards[id]; return c && c.box >= 4; }
function today() { return new Date().toISOString().slice(0, 10); }
function logAnswer(correct) {
  const d = today(); const s = S.stats[d] || { answered: 0, correct: 0, points: [] };
  s.answered++; if (correct) s.correct++; S.stats[d] = s;
}
function logExam(points) {
  const d = today(); const s = S.stats[d] || { answered: 0, correct: 0, points: [] };
  s.points.push(points); S.stats[d] = s;
}
function applyRating(id, r) { // r: 0/1/2 (Punkte) oder 'good'/'fast'/'bad'
  const c = card(id); c.seen++;
  let correct = false;
  if (r === 'good' || r === 2) { c.box = Math.min(5, c.box + 1); c.correct++; correct = true; }
  else if (r === 'fast' || r === 1) { /* Box bleibt */ correct = true; }
  else { c.box = 1; }
  c.last = Date.now(); S.cards[id] = c; logAnswer(correct); save();
}

/* ---------- Helpers ---------- */
const el = h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.childElementCount > 1 ? t.content : t.content.firstChild; };
const esc = s => (s || "").replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const view = document.getElementById('view');
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('<div class="toast"></div>'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function updateHeader() {
  const m = DATA.filter(q => mastered(q.id)).length;
  const due = DATA.filter(q => isDue(q.id)).length;
  document.getElementById('hdrStat').innerHTML = `Gemeistert <b>${m}</b>/${TOTAL} · fällig <b>${due}</b>`;
}

/* ---------- Antwort-Prüfung (offline, Kernpunkte) ---------- */
function norm(s) {
  return (s || "").toLowerCase()
    .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function matchKernpunkt(answerNorm, kp) {
  const cands = [kp.punkt, ...(kp.synonyme || [])];
  for (const c of cands) {
    const n = norm(c);
    if (!n) continue;
    // ganze Phrase enthalten?
    if (n.length >= 4 && answerNorm.includes(n)) return true;
    // einzelne aussagekräftige Wörter (>=4 Zeichen) – mind. eines enthalten
    const words = n.split(" ").filter(w => w.length >= 4);
    if (words.length && words.some(w => answerNorm.includes(w))) return true;
  }
  return false;
}
function checkAnswer(q, answer) {
  const an = norm(answer);
  const kps = q.kernpunkte && q.kernpunkte.length ? q.kernpunkte : [{ punkt: q.kurzantwort || q.antwort, synonyme: [] }];
  const results = kps.map(kp => ({ kp, hit: an.length > 1 && matchKernpunkt(an, kp) }));
  const hits = results.filter(r => r.hit).length;
  const total = results.length;
  const ratio = total ? hits / total : 0;
  let points = 0;
  if (an.length < 2) points = 0;
  else if (ratio >= 0.7) points = 2;
  else if (ratio >= 0.34) points = 1;
  else points = 0;
  return { results, hits, total, points };
}

/* ================= STRATEGIE (minimaler Lernpfad) =================
   Idee: In der Prüfung kommt EIN Bogen (30 Fragen, 60 Punkte). Für 39 Punkte
   genügen 20 sicher gewusste Fragen (20×2=40). Pro Bogen dürfen also die 10
   schwersten/längsten wegfallen. Manche Fragen wiederholen sich über Bögen –
   die lernt man nur einmal. Greedy-Multi-Cover wählt die minimale Menge an
   einfachsten + am häufigsten vorkommenden Fragen, die JEDEN Bogen ≥39 sichert. */
const STRAT_NEED = 20;                 // Fragen je Bogen für ≥39 Punkte
function effortOf(q) { return ((q.kurzantwort || q.antwort) || "").length; }
// Gruppen identischer Fragen (eine Frage = eine Lern-Einheit, egal in wie vielen Bögen)
const stratGroups = (() => {
  const m = new Map();
  for (const q of DATA) { const k = norm(q.frage); if (!m.has(k)) m.set(k, []); m.get(k).push(q); }
  return m;
})();
const groupRep = {};      // key -> Frage mit kürzester Antwort (die lernen wir)
const groupBoegen = {};   // key -> Liste der Bögen, die diese Frage abdeckt
for (const [k, arr] of stratGroups) {
  groupRep[k] = arr.slice().sort((a, b) => effortOf(a) - effortOf(b))[0];
  groupBoegen[k] = [...new Set(arr.map(q => q.bogen))];
}
function groupMastered(k) { return stratGroups.get(k).some(q => mastered(q.id)); }
function groupDue(k) { return isDue(groupRep[k].id); }
// Greedy: wähle Gruppen, bis jeder Bogen STRAT_NEED erreicht – Reihenfolge = Lern-Priorität
const strategyKeys = (() => {
  const need = {}; for (const b of boegen) need[b] = STRAT_NEED;
  const chosen = [], remaining = new Set(stratGroups.keys());
  while (boegen.some(b => need[b] > 0)) {
    let best = null, bestScore = -1;
    for (const k of remaining) {
      const benefit = groupBoegen[k].reduce((a, b) => a + (need[b] > 0 ? 1 : 0), 0);
      if (benefit <= 0) continue;
      const score = benefit / (effortOf(groupRep[k]) + 1);   // viel Nutzen, wenig Aufwand
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best == null) break;
    remaining.delete(best); chosen.push(best);
    for (const b of groupBoegen[best]) if (need[b] > 0) need[b]--;
  }
  return chosen;
})();
const STRAT_TOTAL = strategyKeys.length;
function strategyMastered() { return strategyKeys.filter(groupMastered).length; }
function safeBoegenCount() {
  const cnt = {}; for (const b of boegen) cnt[b] = 0;
  for (const k of strategyKeys) if (groupMastered(k)) for (const b of groupBoegen[k]) cnt[b]++;
  return boegen.filter(b => cnt[b] >= STRAT_NEED).length;
}

/* ================= LERNEN ================= */
let learnMode = 'strategie';   // 'strategie' | 'due' | 'wichtig' | 'schwach'
let learnQueue = [], learnCur = null, learnRevealed = false, learnCheck = null, learnRating = null;
function buildQueue() {
  let pool;
  if (learnMode === 'strategie') {
    // Erst neue Pflicht-Fragen in optimaler Reihenfolge, dann fällige zur Wiederholung
    const neu = strategyKeys.filter(k => !groupMastered(k)).map(k => groupRep[k]);
    const wdh = strategyKeys.filter(k => groupMastered(k) && groupDue(k)).map(k => groupRep[k]);
    return neu.concat(wdh);
  } else if (learnMode === 'wichtig') {
    pool = DATA.filter(q => !mastered(q.id));
    pool.sort((a, b) => (b.wichtigkeit - a.wichtigkeit) || ((a.kurzantwort || a.antwort).length - (b.kurzantwort || b.antwort).length));
  } else if (learnMode === 'schwach') {
    pool = DATA.filter(q => { const c = S.cards[q.id]; return c && c.box <= 2; });
    if (!pool.length) pool = DATA.filter(q => !mastered(q.id));
    pool.sort((a, b) => card(a.id).box - card(b.id).box);
  } else {
    pool = DATA.filter(q => isDue(q.id));
    pool.sort((a, b) => card(a.id).box - card(b.id).box || card(a.id).seen - card(b.id).seen);
  }
  return pool;
}
function renderLearn() {
  setTab('learn');
  if (!learnQueue.length) learnQueue = buildQueue();
  view.innerHTML = '';
  if (learnMode === 'strategie') view.append(strategyDashboard());
  view.append(el(`<div class="card">
    <div class="qmeta">Lernmodus</div>
    <div class="row">
      <button class="${learnMode === 'strategie' ? 'btn-primary' : ''}" onclick="setLearnMode('strategie')">🎯 Strategie</button>
      <button class="${learnMode === 'due' ? 'btn-primary' : ''}" onclick="setLearnMode('due')">Fällig</button>
      <button class="${learnMode === 'wichtig' ? 'btn-primary' : ''}" onclick="setLearnMode('wichtig')">Wichtigste</button>
      <button class="${learnMode === 'schwach' ? 'btn-primary' : ''}" onclick="setLearnMode('schwach')">Schwächen</button>
    </div></div>`));
  if (!learnQueue.length) {
    const allDone = learnMode === 'strategie' && strategyMastered() >= STRAT_TOTAL;
    view.append(el(`<div class="card center"><div class="big">${allDone ? '🏆' : '🎉'}</div>
      <div class="verdict v-good">${allDone ? 'Strategie komplett – du bestehst jeden Bogen!' : 'Nichts offen in diesem Modus!'}</div>
      <p class="muted">${allDone ? 'Mach eine Prüfungssimulation zur Bestätigung.' : 'Wechsle den Modus oder mach eine Prüfungssimulation.'}</p></div>`));
    return;
  }
  learnCur = learnQueue[0]; learnRevealed = false; learnCheck = null; learnRating = null;
  const q = learnCur, c = card(q.id);
  const nBoegen = (groupBoegen[norm(q.frage)] || [q.bogen]).length;
  const hebel = learnMode === 'strategie' && nBoegen > 1 ? ` · 🔗 zählt in ${nBoegen} Bögen` : '';
  view.append(el(`
    <div class="progress"><i style="width:${100 * DATA.filter(x => mastered(x.id)).length / TOTAL}%"></i></div>
    <div class="card">
      <div class="qmeta">Bogen ${q.bogen} · Frage ${q.num} · Box ${c.box}/5 ${q.wichtigkeit >= 3 ? '· ⭐ wichtig' : ''}${hebel} · noch ${learnQueue.length}</div>
      <div class="qtext">${esc(q.frage)}</div>
      <textarea id="learnInput" placeholder="Deine Antwort eintippen (optional)…"></textarea>
      <div id="learnResult"></div>
      <div id="ansArea" class="hidden">
        <div class="label">Kurzantwort (das Wichtigste)</div>
        <div class="kurz">${esc(q.kurzantwort || q.antwort)}</div>
        <button class="btn-ghost" style="margin-top:10px" onclick="toggleMuster()">Vollständige Musterantwort</button>
        <div id="muster" class="muster hidden">${esc(q.antwort)}</div>
        <button class="btn-ghost" style="margin-top:8px" onclick="toggleErkl()">💡 Erklärung</button>
        <div id="erkl" class="erkl hidden">${esc(q.erklaerung || 'Keine Erklärung hinterlegt.')}</div>
      </div>
    </div>
    <div id="learnCtl"></div>
    <div class="kbd">Tippen ist optional · Leertaste = nur aufdecken · 1/2/3 = bewerten &amp; weiter · (Return tut nichts)</div>`));
  renderLearnCtl();
}
function strategyDashboard() {
  const done = strategyMastered(), safe = safeBoegenCount();
  const pct = STRAT_TOTAL ? Math.round(100 * done / STRAT_TOTAL) : 0;
  const safePct = Math.round(100 * safe / boegen.length);
  return el(`<div class="card">
    <div class="qmeta">🎯 Strategie – minimaler Weg zum Bestehen</div>
    <p class="muted" style="margin:4px 0 12px">Lerne nur <b>${STRAT_TOTAL}</b> statt ${TOTAL} Fragen (einfachste + häufigste zuerst) → ≥39 Punkte in <b>jedem</b> Bogen.</p>
    <div class="label">Strategie-Fragen beherrscht</div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div style="margin:4px 0 12px"><b>${done}</b> / ${STRAT_TOTAL} &nbsp;(${pct}%)</div>
    <div class="label">Bögen schon sicher bestanden (≥39 P)</div>
    <div class="progress"><i style="width:${safePct}%;background:#3ecf8e"></i></div>
    <div style="margin-top:4px"><b>${safe}</b> / ${boegen.length} Bögen</div>
  </div>`);
}
function setLearnMode(m) { learnMode = m; learnQueue = []; renderLearn(); }
function toggleMuster() { document.getElementById('muster').classList.toggle('hidden'); }
function toggleErkl() { document.getElementById('erkl').classList.toggle('hidden'); }
const PTS2RATE = { 0: 'bad', 1: 'fast', 2: 'good' };
function renderLearnCtl() {
  const ctl = document.getElementById('learnCtl'); ctl.innerHTML = '';
  if (!learnRevealed) {
    ctl.append(el(`<div class="btn-row">
      <button class="btn-primary" onclick="checkLearn()">Antwort prüfen</button>
      <button class="btn-ghost" onclick="revealLearn()">Nur aufdecken</button></div>`));
    return;
  }
  document.getElementById('ansArea').classList.remove('hidden');
  // Auto-Bewertung anzeigen (falls getippt + geprüft)
  const res = document.getElementById('learnResult'); res.innerHTML = '';
  if (learnCheck) {
    res.append(el(`<div class="result">
      <div class="label">Auto-Bewertung – Vorschlag: <b>${learnCheck.points} P</b> (${learnCheck.hits}/${learnCheck.total} Kernpunkte)</div>
      ${learnCheck.results.map(x => `<div class="kp ${x.hit ? 'hit' : 'miss'}"><span class="dot">${x.hit ? '✓' : '✗'}</span><span>${esc(x.kp.punkt)}</span></div>`).join('')}
    </div>`));
  }
  const sel = r => learnRating === r ? ' sel' : '';
  ctl.append(el(`<div class="label">Wie gut wusstest du es?</div>
    <div class="btn-row">
      <button class="btn-bad${sel('bad')}" onclick="setLearnRating('bad')">Nicht&nbsp;gewusst</button>
      <button class="btn-warn${sel('fast')}" onclick="setLearnRating('fast')">Fast</button>
      <button class="btn-good${sel('good')}" onclick="setLearnRating('good')">Gewusst</button>
    </div>`));
  const next = el(`<button class="btn-primary" style="margin-top:10px" ${learnRating ? '' : 'disabled'}>Weiter&nbsp;▶</button>`);
  next.onclick = () => { if (learnRating) confirmLearn(); };
  ctl.append(next);
  if (!learnRating) ctl.append(el(`<p class="muted center" style="margin-top:6px">Bewertung wählen (oder Taste 1/2/3), dann „Weiter".</p>`));
}
function checkLearn() {
  const ta = document.getElementById('learnInput');
  learnCheck = checkAnswer(learnCur, ta ? ta.value : '');
  learnRating = PTS2RATE[learnCheck.points];   // Vorschlag – überschreibbar
  learnRevealed = true; renderLearnCtl();
}
function revealLearn() { learnCheck = null; learnRating = null; learnRevealed = true; renderLearnCtl(); }
function setLearnRating(r) { learnRating = r; renderLearnCtl(); }
function confirmLearn() {
  applyRating(learnCur.id, learnRating);
  learnQueue.shift();
  if (learnRating === 'bad') learnQueue.push(learnCur);
  updateHeader(); renderLearn();
}
// Tastatur: 1/2/3 = bewerten + direkt weiter
function rate(r) { learnRating = r; confirmLearn(); }

/* ================= PRÜFUNG ================= */
let exam = null;
function renderExamSetup() {
  setTab('exam'); view.innerHTML = '';
  const opts = boegen.map(b => `<option value="${b}">Bogen ${b}</option>`).join('');
  view.append(el(`
    <div class="card"><h2 style="margin-top:0">Voller Prüfungsbogen</h2>
      <p class="muted">30 Fragen in 6 Runden à 5. Antwort tippen → automatische Prüfung (Kernpunkte) → /60 mit Bestehens-Check.</p>
      <select id="bogenSel">${opts}<option value="rand">🎲 Zufälliger Bogen</option></select>
      <div style="height:10px"></div>
      <button class="btn-primary" onclick="startExam('bogen')">Bogen starten</button></div>
    <div class="card"><h2 style="margin-top:0">Schnelltest</h2>
      <p class="muted">5 zufällige Fragen für zwischendurch.</p>
      <button class="btn-primary" onclick="startExam('quick')">5 zufällige Fragen</button></div>
    <div class="card"><h2 style="margin-top:0">Schwächen-Test</h2>
      <p class="muted">5 Fragen aus deinen schwachen Karten (Box 1–2).</p>
      <button class="btn-primary" onclick="startExam('weak')">Schwächen üben</button></div>`));
}
function startExam(mode) {
  let qs;
  if (mode === 'bogen') {
    const sel = document.getElementById('bogenSel');
    let b = sel ? sel.value : 'rand';
    if (b === 'rand') b = boegen[Math.random() * boegen.length | 0];
    b = +b; qs = shuffle(DATA.filter(q => q.bogen === b)); exam = { bogen: b };
  } else if (mode === 'quick') { qs = shuffle(DATA).slice(0, 5); exam = {}; }
  else {
    let weak = DATA.filter(q => { const c = S.cards[q.id]; return c && c.box <= 2; });
    if (weak.length < 5) weak = DATA.filter(q => !mastered(q.id));
    qs = shuffle(weak).slice(0, 5); exam = {};
  }
  exam.mode = mode; exam.questions = qs; exam.chunk = 0; exam.scores = {}; exam.checked = false; exam.inputs = {};
  renderExamChunk();
}
function chunkQs() { return exam.questions.slice(exam.chunk * 5, exam.chunk * 5 + 5); }
function totalChunks() { return Math.ceil(exam.questions.length / 5); }
function renderExamChunk() {
  setTab('exam'); const qs = chunkQs(); view.innerHTML = '';
  const head = exam.mode === 'bogen' ? `Bogen ${exam.bogen} · Runde ${exam.chunk + 1}/${totalChunks()}` : `Runde ${exam.chunk + 1}/${totalChunks()}`;
  const cont = el(`<div></div>`);
  cont.append(el(`<div class="qmeta">${head} · ${exam.questions.length} Fragen gesamt</div>`));
  const c = el(`<div class="card"></div>`);
  qs.forEach((q, i) => {
    const n = exam.chunk * 5 + i + 1;
    const block = el(`<div class="exq" data-id="${q.id}">
      <div class="qtext" style="font-size:18px">${n}. ${esc(q.frage)}</div>
      <textarea placeholder="Deine Antwort…">${esc(exam.inputs[q.id] || '')}</textarea>
      <div class="result hidden"></div>
    </div>`);
    block.querySelector('textarea').addEventListener('input', e => { exam.inputs[q.id] = e.target.value; });
    c.append(block);
  });
  cont.append(c); cont.append(el(`<div id="examCtl"></div>`)); view.append(cont);
  renderExamCtl();
}
function renderExamCtl() {
  const ctl = document.getElementById('examCtl'); ctl.innerHTML = '';
  if (!exam.checked) { ctl.append(el(`<button class="btn-primary" onclick="checkChunk()">Antworten prüfen</button>`)); return; }
  const qs = chunkQs();
  const scored = qs.every(q => exam.scores[q.id] !== undefined);
  const last = exam.chunk + 1 >= totalChunks();
  const b = el(`<button class="btn-primary" ${scored ? '' : 'disabled'}>${last ? 'Ergebnis anzeigen' : 'Weiter'}</button>`);
  b.onclick = () => { if (!scored) return; if (last) renderExamResult(); else { exam.chunk++; exam.checked = false; renderExamChunk(); } };
  ctl.append(b);
  if (!scored) ctl.append(el(`<p class="muted center" style="margin-top:8px">Bitte alle Bewertungen bestätigen.</p>`));
}
function checkChunk() {
  exam.checked = true;
  chunkQs().forEach(q => {
    const block = view.querySelector(`.exq[data-id="${q.id}"]`);
    const res = checkAnswer(q, exam.inputs[q.id] || '');
    exam.scores[q.id] = res.points;
    const correct = res.points === 2;
    // Lerneffekt
    const c = card(q.id); c.seen++; c.last = Date.now();
    if (res.points === 2) { c.box = Math.min(5, c.box + 1); c.correct++; } else if (res.points === 0) c.box = 1;
    S.cards[q.id] = c; logAnswer(correct);
    const r = block.querySelector('.result'); r.classList.remove('hidden');
    r.innerHTML = `
      <div class="label">Auswertung – Vorschlag: <b>${res.points} P</b></div>
      ${res.results.map(x => `<div class="kp ${x.hit ? 'hit' : 'miss'}"><span class="dot">${x.hit ? '✓' : '✗'}</span><span>${esc(x.kp.punkt)}</span></div>`).join('')}
      <div class="label">Musterantwort</div><div class="muster">${esc(q.antwort)}</div>
      <button class="btn-ghost" style="margin-top:8px" onclick="this.nextElementSibling.classList.toggle('hidden')">💡 Erklärung</button>
      <div class="erkl hidden">${esc(q.erklaerung || '')}</div>
      <div class="label">Deine Punkte</div>
      <div class="scorebtns" data-id="${q.id}">
        <button onclick="setScore('${q.id}',0,this)">0 P</button>
        <button onclick="setScore('${q.id}',1,this)">1 P</button>
        <button onclick="setScore('${q.id}',2,this)">2 P</button></div>`;
    const btns = r.querySelectorAll('.scorebtns button'); btns[res.points].classList.add('sel');
  });
  save(); updateHeader(); renderExamCtl();
  const ctl = document.getElementById('examCtl');
  if (ctl.scrollIntoView) ctl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function setScore(id, pts, btn) {
  exam.scores[id] = pts;
  [...btn.parentNode.children].forEach(c => c.classList.remove('sel'));
  btn.classList.add('sel'); renderExamCtl();
}
function renderExamResult() {
  const got = Object.values(exam.scores).reduce((a, b) => a + b, 0);
  const max = exam.questions.length * 2;
  let verdict, cls;
  if (exam.mode === 'bogen') {
    logExam(got);
    if (got >= PASS) { verdict = 'Bestanden ✅'; cls = 'v-good'; }
    else if (got >= ORAL) { verdict = 'Mündliche Prüfung 🟡'; cls = 'v-warn'; }
    else { verdict = 'Nicht bestanden ❌'; cls = 'v-bad'; }
  } else { const pct = Math.round(100 * got / max); cls = pct >= 65 ? 'v-good' : pct >= 55 ? 'v-warn' : 'v-bad'; verdict = `${pct}% richtig`; }
  save();
  view.innerHTML = '';
  view.append(el(`<div class="card center">
    <div class="qmeta">${exam.mode === 'bogen' ? 'Bogen ' + exam.bogen : (exam.mode === 'weak' ? 'Schwächen-Test' : 'Schnelltest')}</div>
    <div class="big">${got} / ${max}</div>
    <div class="verdict ${cls}">${verdict}</div>
    ${exam.mode === 'bogen' ? `<p class="muted">Bestehen ab <b>${PASS}</b> · mündlich ab <b>${ORAL}</b> · max 60</p>` : ''}
    <div style="height:8px"></div>
    <button class="btn-primary" onclick="renderExamSetup()">Neue Prüfung</button>
    <div style="height:10px"></div>
    <button onclick="reviewExam()">Falsche Antworten ansehen</button></div>`));
}
function reviewExam() {
  const wrong = exam.questions.filter(q => (exam.scores[q.id] || 0) < 2);
  view.innerHTML = '';
  view.append(el(`<div class="qmeta">${wrong.length} Fragen zum Nacharbeiten</div>`));
  const c = el(`<div class="card"></div>`);
  if (!wrong.length) c.append(el(`<p class="center v-good">Alles richtig! 🎉</p>`));
  wrong.forEach(q => c.append(el(`<div class="exq"><div class="qtext" style="font-size:17px">${esc(q.frage)}</div>
    <div class="label">Kurzantwort</div><div class="kurz">${esc(q.kurzantwort || q.antwort)}</div>
    <div class="erkl">${esc(q.erklaerung || '')}</div></div>`)));
  view.append(c);
  view.append(el(`<button class="btn-primary" onclick="renderExamSetup()">Zurück</button>`));
}

/* ================= BÖGEN ================= */
function renderBrowse() {
  setTab('browse'); view.innerHTML = '';
  const sel = el(`<div class="card"><h2 style="margin-top:0">Bogen wählen</h2><div class="grid2" id="bgrid"></div></div>`);
  view.append(sel); const g = sel.querySelector('#bgrid');
  boegen.forEach(b => {
    const done = DATA.filter(q => q.bogen === b && mastered(q.id)).length;
    const btn = el(`<button>Bogen ${b}<br><small>${done}/30 gemeistert</small></button>`);
    btn.onclick = () => showBogen(b); g.append(btn);
  });
}
function showBogen(b) {
  view.innerHTML = '';
  view.append(el(`<div class="qmeta">Bogen ${b} · 30 Fragen (60 Punkte)</div>`));
  const c = el(`<div class="card"></div>`);
  DATA.filter(q => q.bogen === b).sort((a, b) => a.num - b.num).forEach(q => {
    const block = el(`<div class="exq"><div class="qtext" style="font-size:16px">${q.num}. ${esc(q.frage)} ${q.wichtigkeit >= 3 ? '⭐' : ''}</div>
      <div class="sol hidden"><div class="label">Kurzantwort</div><div class="kurz">${esc(q.kurzantwort || q.antwort)}</div>
        <div class="label">Musterantwort</div><div class="muster">${esc(q.antwort)}</div>
        <div class="erkl">${esc(q.erklaerung || '')}</div></div>
      <button class="btn-ghost" style="margin-top:8px">Antwort & Erklärung</button></div>`);
    const sol = block.querySelector('.sol'), bb = block.querySelector('button');
    bb.onclick = () => { const v = sol.classList.toggle('hidden'); bb.textContent = v ? 'Antwort & Erklärung' : 'Verbergen'; };
    c.append(block);
  });
  view.append(c);
  view.append(el(`<button class="btn-primary" onclick="renderBrowse()">Zurück</button>`));
}

/* ================= STATUS / LERNKURVE ================= */
function renderStats() {
  setTab('stats');
  const m = DATA.filter(q => mastered(q.id)).length;
  const seen = DATA.filter(q => S.cards[q.id]).length;
  const boxCounts = [1, 2, 3, 4, 5].map(bx => DATA.filter(q => card(q.id).box === bx && S.cards[q.id]).length);
  view.innerHTML = '';
  view.append(el(`
    <div class="card center"><div class="qmeta">Fortschritt</div>
      <div class="big">${m} / ${TOTAL}</div><div class="muted">Fragen gemeistert (Box 4–5)</div>
      <div class="progress" style="margin-top:14px"><i style="width:${100 * m / TOTAL}%"></i></div></div>
    <div class="card"><h2 style="margin-top:0">Lernkurve (14 Tage)</h2>
      <canvas id="chart" width="700" height="240"></canvas>
      <p class="muted" style="font-size:13px">Linie = % richtig pro Tag · Balken = beantwortete Fragen</p></div>
    <div class="card">
      <div>${[1, 2, 3, 4, 5].map((bx, i) => `<span class="pill ${bx <= 2 ? 'w3' : ''}">Box ${bx}: ${boxCounts[i]}</span>`).join('')}</div>
      <div class="label">Gesehen</div>${seen}/${TOTAL}
    </div>`));
  drawChart();
}
function drawChart() {
  const cv = document.getElementById('chart'); if (!cv) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, pad = 30;
  ctx.clearRect(0, 0, W, H);
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); days.push(d); }
  const maxAns = Math.max(5, ...days.map(d => (S.stats[d] && S.stats[d].answered) || 0));
  const bw = (W - pad * 2) / days.length;
  // Balken
  ctx.fillStyle = '#2c3a48';
  days.forEach((d, i) => {
    const a = (S.stats[d] && S.stats[d].answered) || 0;
    const h = (H - pad * 2) * a / maxAns;
    ctx.fillRect(pad + i * bw + 4, H - pad - h, bw - 8, h);
  });
  // Linie %richtig
  ctx.strokeStyle = '#3ecf8e'; ctx.lineWidth = 2; ctx.beginPath(); let started = false;
  days.forEach((d, i) => {
    const s = S.stats[d]; if (!s || !s.answered) return;
    const pct = s.correct / s.answered;
    const x = pad + i * bw + bw / 2, y = H - pad - (H - pad * 2) * pct;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    ctx.fillStyle = '#3ecf8e';
  });
  ctx.stroke();
  ctx.fillStyle = '#90a2b4'; ctx.font = '11px sans-serif';
  ctx.fillText('0%', 2, H - pad); ctx.fillText('100%', 2, pad + 6);
}

/* ================= SYNC (GitHub Gist) ================= */
function renderSettings() {
  setTab('settings'); view.innerHTML = '';
  view.append(el(`
    <div class="card"><h2 style="margin-top:0">Sync (GitHub)</h2>
      <p class="muted">Fortschritt manuell zwischen Geräten synchronisieren – über einen privaten Gist. Token & Gist-ID bleiben nur auf diesem Gerät.</p>
      <div class="label">GitHub Token (Scope: gist)</div>
      <input id="ghtoken" type="password" placeholder="ghp_…" value="${esc(S.settings.token || '')}">
      <div class="label">Gist-ID (leer = beim ersten Hochladen neu anlegen)</div>
      <input id="ghgist" placeholder="(optional)" value="${esc(S.settings.gistId || '')}">
      <div style="height:12px"></div>
      <div class="row">
        <button class="btn-primary" onclick="syncPush()">⬆︎ Hochladen</button>
        <button class="btn-primary" onclick="syncPull()">⬇︎ Herunterladen</button>
      </div>
      <button class="btn-ghost" style="margin-top:10px" onclick="saveSettings()">Token/Gist speichern</button>
    </div>
    <div class="card center">
      <p class="muted" style="margin:0 0 10px">Fortschritt liegt lokal im Browser.</p>
      <a href="#" onclick="resetProg();return false">Fortschritt zurücksetzen</a>
    </div>`));
}
function saveSettings() {
  S.settings.token = document.getElementById('ghtoken').value.trim();
  S.settings.gistId = document.getElementById('ghgist').value.trim();
  save(); toast('Gespeichert');
}
function progressPayload() { return JSON.stringify({ cards: S.cards, stats: S.stats, savedAt: Date.now() }, null, 2); }
async function syncPush() {
  saveSettings();
  const token = S.settings.token; if (!token) return toast('Bitte Token eintragen');
  const body = { description: 'SKS Trainer Fortschritt', files: { 'sks-progress.json': { content: progressPayload() } } };
  try {
    let url = 'https://api.github.com/gists', method = 'POST';
    if (S.settings.gistId) { url += '/' + S.settings.gistId; method = 'PATCH'; }
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 120));
    const j = await res.json(); S.settings.gistId = j.id; save();
    document.getElementById('ghgist').value = j.id; toast('Hochgeladen ✓');
  } catch (e) { toast('Fehler: ' + e.message); }
}
async function syncPull() {
  saveSettings();
  const token = S.settings.token, gid = S.settings.gistId;
  if (!token || !gid) return toast('Token + Gist-ID nötig');
  try {
    const res = await fetch('https://api.github.com/gists/' + gid, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status);
    const j = await res.json(); const remote = JSON.parse(j.files['sks-progress.json'].content);
    // Merge: pro Karte neueren 'last' behalten
    for (const id in (remote.cards || {})) {
      const r = remote.cards[id], l = S.cards[id];
      if (!l || (r.last || 0) > (l.last || 0)) S.cards[id] = r;
    }
    for (const d in (remote.stats || {})) {
      const r = remote.stats[d], l = S.stats[d];
      if (!l || (r.answered || 0) > (l.answered || 0)) S.stats[d] = r;
    }
    save(); updateHeader(); toast('Heruntergeladen ✓'); renderStats();
  } catch (e) { toast('Fehler: ' + e.message); }
}
function resetProg() {
  if (confirm('Gesamten Lernfortschritt löschen?')) { S.cards = {}; S.stats = {}; save(); learnQueue = []; updateHeader(); renderSettings(); toast('Zurückgesetzt'); }
}

/* ================= AUTO / FAHRT-MODUS (Audio) ================= */
let autoState = { list: [], idx: 0, playing: false, answerShown: false, seq: 0 };
let autoSettings = { source: 'wichtig', gap: 4000, voice: true, nextPause: 1600 };
let wakeLock = null, recog = null, voiceActive = false, autoTimer = null;

function renderAutoSetup() {
  setTab('auto'); view.innerHTML = '';
  const bopts = boegen.map(b => `<option value="b${b}">Nur Bogen ${b}</option>`).join('');
  view.append(el(`
    <div class="card"><h2 style="margin-top:0">🚗 Auto-Modus (Audio)</h2>
      <p class="muted">Hände frei lernen: Fragen &amp; Kurzantworten werden vorgelesen. Bitte Gerät ins <b>Querformat</b> drehen. Große Buttons, optional Sprachbefehle.</p>
      <div class="label">Was lernen?</div>
      <select id="autoSrc">
        <option value="wichtig">⭐ Wichtigste zuerst</option>
        <option value="schwach">Nur Schwächen (Box 1–2)</option>
        <option value="faellig">Fällige (Wiederholung)</option>
        <option value="alle">Alle 450 (zufällig)</option>
        ${bopts}
      </select>
      <div class="label">Denkpause nach der Frage (Zeit zum Selbstbeantworten)</div>
      <select id="autoGap"><option value="2500">kurz (2,5s)</option><option value="4000" selected>normal (4s)</option><option value="6500">lang (6,5s)</option></select>
      <div class="label">Pause nach der Antwort (bis zur nächsten Frage)</div>
      <select id="autoNextPause"><option value="800">kurz (0,8s)</option><option value="1600" selected>normal (1,6s)</option><option value="3000">lang (3s)</option></select>
      <label class="row" style="margin-top:12px;justify-content:flex-start;gap:8px">
        <input type="checkbox" id="autoVoice" style="width:auto" ${autoSettings.voice ? 'checked' : ''}>
        <span>Sprachbefehle versuchen („gewusst", „nicht", „weiter", „antwort")</span></label>
      <div style="height:14px"></div>
      <button class="btn-primary" onclick="startAuto()">▶︎ Losfahren</button>
      <p class="muted" style="font-size:13px;margin-top:10px">Hinweis: Sprachsteuerung &amp; Lenkrad-Tasten sind je nach iPhone eingeschränkt – die großen Buttons funktionieren immer. Fahr sicher: im Zweifel nur zuhören.</p>
    </div>`));
  // Stimme & Tempo
  loadVoices();
  const de = germanVoices();
  const cur = currentVoice();
  const vopts = de.length
    ? de.map(v => `<option value="${esc(v.name)}" ${cur && v.name === cur.name ? 'selected' : ''}>${esc(v.name)}${v.localService ? '' : ' (online)'}</option>`).join('')
    : '<option value="">Standard (Gerätestimme)</option>';
  const rate = S.settings.rate || 0.95;
  view.append(el(`
    <div class="card"><h2 style="margin-top:0">🔊 Stimme &amp; Tempo</h2>
      <div class="label">Stimme</div>
      <select id="voiceSel" onchange="saveAutoVoice()">${vopts}</select>
      <div class="label">Tempo: <span id="rateVal">${rate.toFixed(2)}×</span></div>
      <input id="rateSel" type="range" min="0.7" max="1.3" step="0.05" value="${rate}"
        oninput="document.getElementById('rateVal').textContent=(+this.value).toFixed(2)+'×'" onchange="saveAutoVoice()">
      <div style="height:10px"></div>
      <button class="btn-ghost" onclick="testVoice()">🔊 Stimme testen</button>
      <p class="muted" style="font-size:13px;margin-top:10px">Tipp fürs iPhone: Unter <b>Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch</b> eine <b>„Premium/Erweitert"-Stimme</b> (z. B. Anna oder eine Siri-Stimme) laden – die erscheint dann hier und klingt deutlich natürlicher.</p>
    </div>`));
}
function saveAutoVoice() {
  const vs = document.getElementById('voiceSel'), rs = document.getElementById('rateSel');
  if (vs) S.settings.voiceName = vs.value;
  if (rs) S.settings.rate = +rs.value;
  save();
}

function buildAutoList(src) {
  if (src && src[0] === 'b') { const b = +src.slice(1); return DATA.filter(q => q.bogen === b).sort((a, c) => a.num - c.num); }
  if (src === 'schwach') { let p = DATA.filter(q => { const c = S.cards[q.id]; return c && c.box <= 2; }); if (p.length < 5) p = DATA.filter(q => !mastered(q.id)); return shuffle(p); }
  if (src === 'faellig') return shuffle(DATA.filter(q => isDue(q.id)));
  if (src === 'alle') return shuffle(DATA.slice());
  // wichtig (default)
  return DATA.filter(q => !mastered(q.id)).sort((a, c) => (c.wichtigkeit - a.wichtigkeit) || ((a.kurzantwort || a.antwort).length - (c.kurzantwort || c.antwort).length));
}

function startAuto() {
  const srcEl = document.getElementById('autoSrc'), gapEl = document.getElementById('autoGap'), vEl = document.getElementById('autoVoice'), npEl = document.getElementById('autoNextPause');
  if (srcEl) autoSettings.source = srcEl.value;
  if (gapEl) autoSettings.gap = +gapEl.value;
  if (npEl) autoSettings.nextPause = +npEl.value;
  if (vEl) autoSettings.voice = vEl.checked;
  autoState.list = buildAutoList(autoSettings.source);
  if (!autoState.list.length) autoState.list = buildAutoList('alle');
  autoState.idx = 0; autoState.playing = true;
  buildAutoView();
  requestWake(); lockLandscape(); setupMediaSession();
  if (autoSettings.voice) setupRecog();
  playCurrent();
}
function buildAutoView() {
  let v = document.getElementById('autoView'); if (v) v.remove();
  v = el(`<div class="auto-view" id="autoView">
    <div class="auto-rotate"><div class="big">🔄</div><div>Bitte ins <b>Querformat</b> drehen</div></div>
    <div class="auto-top"><span id="autoMeta"></span><button class="x" onclick="stopAuto()">✕</button></div>
    <div class="auto-mid">
      <div class="auto-tag" id="autoTag">Frage</div>
      <div class="auto-q" id="autoQ"></div>
      <div class="auto-a hidden" id="autoA"></div>
      <div class="auto-listen" id="autoListen"></div>
    </div>
    <div class="auto-rate">
      <button class="nope" onclick="autoRate('bad')">👎 Nicht gewusst</button>
      <button class="yep" onclick="autoRate('good')">👍 Gewusst</button>
    </div>
    <div class="auto-ctl">
      <button onclick="autoPrev()">⏮</button>
      <button class="mid" id="autoPlayBtn" onclick="autoTogglePlay()">⏸</button>
      <button onclick="autoSpeakAnswer()">📜</button>
      <button onclick="autoNext()">⏭</button>
    </div>
    <div class="auto-hint" id="autoHint"></div></div>`);
  document.body.append(v);
}
/* --- Stimmen-Auswahl --- */
let voices = [];
function loadVoices() { try { voices = (speechSynthesis.getVoices() || []).slice(); } catch (e) { voices = []; } }
if (typeof speechSynthesis !== 'undefined') {
  loadVoices();
  try { speechSynthesis.onvoiceschanged = loadVoices; } catch (e) { }
}
function germanVoices() { return voices.filter(v => /^de/i.test(v.lang || '')); }
function voiceScore(v) {
  let s = 0;
  if (/(siri|enhanced|premium|natural|neural)/i.test(v.name)) s += 4;
  if (/google/i.test(v.name)) s += 3;
  if (v.localService) s += 1;
  if (/(anna|markus|petra|viktor|helena)/i.test(v.name)) s += 1;
  if (/eloquence|compact/i.test(v.name)) s -= 3; // alte Roboterstimmen abwerten
  return s;
}
function pickDefaultVoice() { const de = germanVoices(); return de.length ? de.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] : null; }
function currentVoice() {
  const de = germanVoices();
  return de.find(v => v.name === S.settings.voiceName) || pickDefaultVoice();
}
/* --- Abkürzungen für klareres Vorlesen ausschreiben --- */
const ABBR = [
  [/\bz\.\s?B\./gi, 'zum Beispiel'], [/\bu\.\s?a\./gi, 'unter anderem'], [/\bd\.\s?h\./gi, 'das heißt'],
  [/\bu\.\s?U\./gi, 'unter Umständen'], [/\bz\.\s?T\./gi, 'zum Teil'], [/\bbzw\./gi, 'beziehungsweise'],
  [/\bca\./gi, 'circa'], [/\busw\./gi, 'und so weiter'], [/\bggf\./gi, 'gegebenenfalls'],
  [/\bevtl\./gi, 'eventuell'], [/\binkl\./gi, 'inklusive'], [/\bmind\./gi, 'mindestens'],
  [/\bmax\./gi, 'maximal'], [/\bNr\./gi, 'Nummer'], [/\bggü\./gi, 'gegenüber'],
  [/\bm\/s\b/gi, 'Meter pro Sekunde'], [/\bkm\/h\b/gi, 'Kilometer pro Stunde'],
  [/\bhPa\b/g, 'Hektopascal'], [/(\d)\s?°/g, '$1 Grad'], [/\s?%/g, ' Prozent'],
  [/(\d)\s?kn\b/gi, '$1 Knoten'], [/(\d)\s?sm\b/g, '$1 Seemeilen'], [/(\d)\s?Ah\b/g, '$1 Amperestunden']
];
function expandForSpeech(text) {
  let t = ' ' + (text || '') + ' ';
  for (const [re, rep] of ABBR) t = t.replace(re, rep);
  return t.replace(/\s+/g, ' ').trim();
}
/* Geschätzte Lesedauer (ms) aus Textlänge + Tempo – nur als Fallback-Puffer. */
function estimateSpeechMs(text) {
  const t = expandForSpeech(text || '');
  const rate = S.settings.rate || 0.95;
  const cps = 13 * rate;            // ~13 Zeichen/Sek. bei Tempo 1
  return Math.max(1200, Math.round(t.length / cps * 1000));
}
/* Spricht den Text und ruft onDone() GENAU dann auf, wenn das Vorlesen
   wirklich fertig ist (onend). Watchdog fängt fehlendes onend (iOS) ab –
   großzügig gepuffert, damit nie mitten im Satz abgeschnitten wird. */
let speakWD = null;
function speak(text, onDone) {
  clearTimeout(speakWD);
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(speakWD); if (onDone) onDone(); };
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    speakWD = setTimeout(finish, 300); return;
  }
  try { speechSynthesis.cancel(); } catch (e) { }
  const u = new SpeechSynthesisUtterance(expandForSpeech(text));
  const v = currentVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'de-DE'; }
  u.rate = S.settings.rate || 0.95;
  u.pitch = S.settings.pitch || 1;
  u.onend = finish;
  u.onerror = finish;
  try { speechSynthesis.speak(u); } catch (e) { finish(); return; }
  // Watchdog: deutlich länger als die geschätzte Lesedauer -> nur Notnagel
  speakWD = setTimeout(finish, estimateSpeechMs(text) + 4000);
}
function testVoice() { speak('Dies ist ein Test der Sprachausgabe für deinen SKS Trainer. Frage: Was bedeutet die Backbordlaterne?'); }
function setHint() {
  const h = document.getElementById('autoHint'); if (!h) return;
  h.textContent = voiceActive ? 'Sprachbefehle aktiv · oder große Buttons' : 'Steuerung über die großen Buttons';
}
function playCurrent() {
  clearTimeout(autoTimer);
  const v = document.getElementById('autoView'); if (!v) return;
  const seq = ++autoState.seq;
  const q = autoState.list[autoState.idx]; if (!q) return;
  autoState.answerShown = false;
  document.getElementById('autoMeta').textContent = `Bogen ${q.bogen} · Frage ${q.num} · ${autoState.idx + 1}/${autoState.list.length}`;
  document.getElementById('autoTag').textContent = 'Frage';
  document.getElementById('autoQ').textContent = q.frage;
  const a = document.getElementById('autoA'); a.textContent = ''; a.classList.add('hidden');
  setHint();
  if (!autoState.playing) return;
  speak(q.frage, () => {
    if (seq !== autoState.seq || !autoState.playing) return;
    autoTimer = setTimeout(() => revealAnswer(seq), autoSettings.gap);
  });
}
function revealAnswer(seq) {
  if (seq !== autoState.seq || !autoState.playing) return;
  const q = autoState.list[autoState.idx]; autoState.answerShown = true;
  document.getElementById('autoTag').textContent = 'Kurzantwort';
  const a = document.getElementById('autoA'); a.textContent = q.kurzantwort || q.antwort; a.classList.remove('hidden');
  // als gehört markieren
  const c = card(q.id); c.seen++; c.last = Date.now(); S.cards[q.id] = c; save();
  speak(q.kurzantwort || q.antwort, () => {
    if (seq !== autoState.seq || !autoState.playing) return;
    // erst NACHDEM die Antwort fertig vorgelesen ist, kurze Pause -> nächste Frage
    if (voiceActive) {
      startListening();
      // bei Sprachbefehlen länger warten (Zeit für "gewusst"/"nicht"); sonst Sicherheits-Weiterschaltung
      autoTimer = setTimeout(() => { if (seq === autoState.seq && autoState.playing) autoNext(); }, 9000);
    } else {
      autoTimer = setTimeout(() => { if (seq === autoState.seq && autoState.playing) autoNext(); }, autoSettings.nextPause || 1600);
    }
  });
}
function autoNext() { clearTimeout(autoTimer); autoState.idx = (autoState.idx + 1) % autoState.list.length; playCurrent(); }
function autoPrev() { clearTimeout(autoTimer); autoState.idx = (autoState.idx - 1 + autoState.list.length) % autoState.list.length; playCurrent(); }
function autoTogglePlay() {
  autoState.playing = !autoState.playing;
  const btn = document.getElementById('autoPlayBtn'); if (btn) btn.textContent = autoState.playing ? '⏸' : '▶︎';
  if (!autoState.playing) { clearTimeout(autoTimer); try { speechSynthesis.cancel(); } catch (e) { } }
  else playCurrent();
}
function autoSpeakAnswer() {
  const q = autoState.list[autoState.idx]; if (!q) return;
  autoState.answerShown = true;
  document.getElementById('autoTag').textContent = 'Musterantwort';
  const a = document.getElementById('autoA'); a.textContent = q.antwort; a.classList.remove('hidden');
  speak(q.antwort);
}
function autoRate(r) {
  const q = autoState.list[autoState.idx]; if (!q) return;
  applyRating(q.id, r); updateHeader(); autoNext();
}
function stopAuto() {
  autoState.playing = false; clearTimeout(autoTimer);
  try { speechSynthesis.cancel(); } catch (e) { }
  stopListening(); releaseWake(); unlockOrientation();
  const v = document.getElementById('autoView'); if (v) v.remove();
  renderLearn();
}
/* Geräte-APIs (alle defensiv) */
async function requestWake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { } }
async function releaseWake() { try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) { } }
function lockLandscape() { try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => { }); } catch (e) { } }
function unlockOrientation() { try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { } }
function setupMediaSession() {
  try {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'SKS Auto-Lernen', artist: 'SKS Trainer' });
    navigator.mediaSession.setActionHandler('play', () => autoTogglePlay());
    navigator.mediaSession.setActionHandler('pause', () => autoTogglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => autoNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => autoPrev());
  } catch (e) { }
}
function setupRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { voiceActive = false; setHint(); return; }
  try {
    recog = new SR(); recog.lang = 'de-DE'; recog.continuous = true; recog.interimResults = false;
    recog.onresult = e => {
      const t = (e.results[e.results.length - 1][0].transcript || '').toLowerCase();
      if (/(gewusst|wusste|richtig|\bja\b|kann ich)/.test(t)) autoRate('good');
      else if (/(nicht|\bnein\b|falsch|keine ahnung|weiss nicht|weiß nicht)/.test(t)) autoRate('bad');
      else if (/(weiter|n(ä|ae)chste|skip|vor)/.test(t)) autoNext();
      else if (/(zur(ü|ue)ck|vorherige|davor)/.test(t)) autoPrev();
      else if (/(nochmal|wiederhol)/.test(t)) playCurrent();
      else if (/(antwort|muster|l(ö|oe)sung)/.test(t)) autoSpeakAnswer();
      else if (/(pause|stop|halt)/.test(t)) autoTogglePlay();
    };
    recog.onerror = () => { };
    recog.onend = () => { if (voiceActive && autoState.playing) { try { recog.start(); } catch (e) { } } };
    recog.start(); voiceActive = true; setHint();
  } catch (e) { voiceActive = false; setHint(); }
}
function startListening() { if (recog && voiceActive) { try { recog.start(); } catch (e) { } } }
function stopListening() { voiceActive = false; if (recog) { try { recog.stop(); } catch (e) { } recog = null; } }

/* ================= Navigation ================= */
function setTab(t) { document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t)); }
document.querySelectorAll('.nav button').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.tab;
    if (t === 'learn') { learnQueue = []; renderLearn(); }
    else if (t === 'exam') renderExamSetup();
    else if (t === 'auto') renderAutoSetup();
    else if (t === 'browse') renderBrowse();
    else if (t === 'stats') renderStats();
    else renderSettings();
  };
});
document.addEventListener('keydown', e => {
  if (!document.querySelector('.nav button[data-tab="learn"]').classList.contains('active')) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { if (!learnRevealed) { e.preventDefault(); revealLearn(); } }
  else if (learnRevealed && ['1', '2', '3'].includes(e.key)) rate({ '1': 'bad', '2': 'fast', '3': 'good' }[e.key]);
});

// Service Worker (nur über http/https) – mit Auto-Update + einmaligem Reload
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; reloaded = true; location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.update();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) nw.postMessage('skipWaiting');
      });
    });
  }).catch(() => { });
}

// expose für inline-onclick
Object.assign(window, { setLearnMode, revealLearn, checkLearn, setLearnRating, confirmLearn, rate, toggleMuster, toggleErkl, renderExamSetup, startExam, checkChunk, setScore, renderExamResult, reviewExam, renderBrowse, syncPush, syncPull, saveSettings, resetProg, chunkQs, totalChunks, checkAnswer,
  renderAutoSetup, startAuto, stopAuto, autoNext, autoPrev, autoTogglePlay, autoSpeakAnswer, autoRate, buildAutoList, testVoice, saveAutoVoice, expandForSpeech, estimateSpeechMs, speak });

// Start
if (!TOTAL) view.innerHTML = '<div class="card">⚠️ Keine Daten geladen (data.js fehlt).</div>';
else { updateHeader(); renderLearn(); }
