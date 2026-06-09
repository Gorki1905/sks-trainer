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

/* ================= LERNEN ================= */
let learnMode = 'due';   // 'due' | 'wichtig' | 'schwach'
let learnQueue = [], learnCur = null, learnRevealed = false;
function buildQueue() {
  let pool;
  if (learnMode === 'wichtig') {
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
  view.append(el(`<div class="card">
    <div class="qmeta">Lernmodus</div>
    <div class="row">
      <button class="${learnMode === 'due' ? 'btn-primary' : ''}" onclick="setLearnMode('due')">Fällig</button>
      <button class="${learnMode === 'wichtig' ? 'btn-primary' : ''}" onclick="setLearnMode('wichtig')">Wichtigste</button>
      <button class="${learnMode === 'schwach' ? 'btn-primary' : ''}" onclick="setLearnMode('schwach')">Schwächen</button>
    </div></div>`));
  if (!learnQueue.length) {
    view.append(el(`<div class="card center"><div class="big">🎉</div>
      <div class="verdict v-good">Nichts offen in diesem Modus!</div>
      <p class="muted">Wechsle den Modus oder mach eine Prüfungssimulation.</p></div>`));
    return;
  }
  learnCur = learnQueue[0]; learnRevealed = false;
  const q = learnCur, c = card(q.id);
  view.append(el(`
    <div class="progress"><i style="width:${100 * DATA.filter(x => mastered(x.id)).length / TOTAL}%"></i></div>
    <div class="card">
      <div class="qmeta">Bogen ${q.bogen} · Frage ${q.num} · Box ${c.box}/5 ${q.wichtigkeit >= 3 ? '· ⭐ wichtig' : ''} · noch ${learnQueue.length}</div>
      <div class="qtext">${esc(q.frage)}</div>
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
    <div class="kbd">Leertaste = aufdecken · 1 nicht · 2 fast · 3 gewusst</div>`));
  renderLearnCtl();
}
function setLearnMode(m) { learnMode = m; learnQueue = []; renderLearn(); }
function toggleMuster() { document.getElementById('muster').classList.toggle('hidden'); }
function toggleErkl() { document.getElementById('erkl').classList.toggle('hidden'); }
function renderLearnCtl() {
  const ctl = document.getElementById('learnCtl'); ctl.innerHTML = '';
  if (!learnRevealed) ctl.append(el(`<button class="btn-primary" onclick="revealLearn()">Antwort zeigen</button>`));
  else {
    document.getElementById('ansArea').classList.remove('hidden');
    ctl.append(el(`<div class="btn-row">
      <button class="btn-bad" onclick="rate('bad')">Nicht&nbsp;gewusst</button>
      <button class="btn-warn" onclick="rate('fast')">Fast</button>
      <button class="btn-good" onclick="rate('good')">Gewusst</button></div>`));
  }
}
function revealLearn() { learnRevealed = true; renderLearnCtl(); }
function rate(r) {
  applyRating(learnCur.id, r);
  learnQueue.shift();
  if (r === 'bad') learnQueue.push(learnCur);
  updateHeader(); renderLearn();
}

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

/* ================= Navigation ================= */
function setTab(t) { document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t)); }
document.querySelectorAll('.nav button').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.tab;
    if (t === 'learn') { learnQueue = []; renderLearn(); }
    else if (t === 'exam') renderExamSetup();
    else if (t === 'browse') renderBrowse();
    else if (t === 'stats') renderStats();
    else renderSettings();
  };
});
document.addEventListener('keydown', e => {
  if (!document.querySelector('.nav button[data-tab="learn"]').classList.contains('active')) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.code === 'Enter') { if (!learnRevealed) { e.preventDefault(); revealLearn(); } }
  else if (learnRevealed && ['1', '2', '3'].includes(e.key)) rate({ '1': 'bad', '2': 'fast', '3': 'good' }[e.key]);
});

// Service Worker (nur über http/https)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

// expose für inline-onclick
Object.assign(window, { setLearnMode, revealLearn, rate, toggleMuster, toggleErkl, renderExamSetup, startExam, checkChunk, setScore, renderExamResult, reviewExam, renderBrowse, syncPush, syncPull, saveSettings, resetProg, chunkQs, totalChunks, checkAnswer, exam: null });

// Start
if (!TOTAL) view.innerHTML = '<div class="card">⚠️ Keine Daten geladen (data.js fehlt).</div>';
else { updateHeader(); renderLearn(); }
