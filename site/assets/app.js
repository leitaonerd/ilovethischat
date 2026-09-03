/* =============================================================
   PAPINHO — vanilla JS viewer for the WhatsApp archive.
   Virtualized timeline (absolute-positioned window) + client-side
   search, built for a static GitHub Pages deployment.
   ============================================================= */
"use strict";

/* ---------------- DOM refs ---------------- */
const $ = (sel) => document.querySelector(sel);
const els = {
  months: $("#months"),
  timeline: $("#timeline"),
  window: $("#window"),
  loadState: $("#load-state"),
  searchPanel: $("#search-panel"),
  searchForm: $("#search-form"),
  searchInput: $("#search-input"),
  searchStatus: $("#search-status"),
  searchResults: $("#search-results"),
  searchBack: $("#search-back"),
};

/* ---------------- State ---------------- */
const state = {
  index: null,          // index.json
  months: [],           // ordered list of "YYYY-MM"
  media: {},            // media manifest map: filename -> {type, src, transcoded}
  rows: [],             // one entry per message in the loaded window
  heights: [],          // measured/estimated pixel height per row
  mounted: new Set(),   // global rows currently in the DOM
  loadedThrough: -1,    // index (into months) of the last loaded month
  startMonth: 0,        // first month index in the current window
  loading: false,
  scrollRaf: 0,
  searchActive: false,
  pendingJump: null,    // row index to keep aimed at while layout settles
  pendingJumpTimer: 0,
};

/* Default pixel heights before measurement. Media varies a lot, so we
   over-estimate and correct after real measurement. */
const EST_MSG_TEXT = 84;
const EST_MSG_MEDIA = 240;
const DAY_RULE_EXTRA = 64;

const OVERSIMPLE = 8; // extra rows rendered above/below the viewport
const MONTH_LOADED_PRE = 0; // no upward loading; jumps restart the window
/* ---------------- Small utilities ---------------- */
const MONTH_NAMES = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];
const WEEKDAYS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

function fmtMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return MONTH_NAMES[m - 1] + " " + y;
}

function fmtDayRule(iso) {
  const d = new Date(iso);
  return (
    WEEKDAYS[d.getDay()] + ", " +
    String(d.getDate()).padStart(2, "0") + " " +
    MONTH_NAMES[d.getMonth()] + " " + d.getFullYear()
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0");
}

/* Day key (YYYY-MM-DD) to detect day boundaries */
function dayKey(iso) {
  return iso ? iso.slice(0, 10) : null;
}

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Resolve a media filename to its served src (honouring transcodes). */
function resolveMedia(name) {
  const entry = state.media[name];
  return entry && entry.src ? entry.src : "media/" + name;
}
/* ---------------- Init ---------------- */
async function init() {
  try {
    state.index = await fetchJSON("data/index.json");
    state.months = state.index.months || [];
    state.media = state.index.media_manifest || {};
  } catch (e) {
    els.months.textContent = "ERRO AO CARREGAR DADOS — " + e.message;
    return;
  }
  renderMonthsNav();
  bindEvents();

  // Load the first month (or the deepest requested by hash)
  const target = parseHashMonth();
  state.startMonth = target >= 0 ? target : 0;
  await loadWindow();
  requestRender();
  window.addEventListener("resize", onResize);
}

function parseHashMonth() {
  const m = location.hash.match(/m=(\d{4}-\d{2})/);
  if (!m) return -1;
  const i = state.months.indexOf(m[1]);
  return i;
}

function renderMonthsNav() {
  const c = els.months;
  c.innerHTML = "";
  state.months.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = fmtMonth(m).replace(" ", " ’");
    b.dataset.month = m;
    b.addEventListener("click", () => jumpToMonth(m));
    c.appendChild(b);
  });
}

/* ---------------- Month loading ---------------- */
async function loadWindow() {
  els.loadState.hidden = false;
  // Wipe everything: rows, heights, mounted set AND any leftover DOM so a
  // month switch never stacks new rows on top of the previous render.
  state.rows = [];
  state.heights = [];
  state.mounted.clear();
  state.loadedThrough = state.startMonth - 1;
  els.window.innerHTML = "";

  let prevDay = null;
  // Load a few months at once to start with a full screen.
  const num = Math.min(state.months.length, 3);
  for (let k = 0; k < num; k++) {
    const mi = state.startMonth + k;
    if (mi >= state.months.length) break;
    prevDay = await appendMonth(mi, prevDay);
  }
  els.loadState.hidden = true;
}

async function appendMonth(mi, prevDay) {
  const key = state.months[mi];
  let records;
  try {
    records = await fetchJSON("data/" + key + ".json");
  } catch (e) {
    console.warn("failed to load month", key, e);
    return prevDay;
  }
  state.loadedThrough = mi;
  for (const rec of records) {
    const newDay = prevDay !== dayKey(rec.ts);
    state.rows.push({ rec: rec, newDay: newDay });
    state.heights.push(0);
    prevDay = dayKey(rec.ts);
  }
  return prevDay;
}
/* ---------------- Virtualization ---------------- */
function estimate(i) {
  const rec = state.rows[i].rec;
  if (rec.kind === "system") return 64;
  if (rec.kind === "media") {
    const m = rec.media;
    // media rows can be tall (images) but not always (sticker, audio, doc)
    return m === "image" || m === "video" ? 300 : 140;
  }
  return EST_MSG_TEXT;
}

/* Recompute cumulative top offsets from (measured|estimated) heights. */
function computeTops() {
  let total = 0;
  for (let i = 0; i < state.heights.length; i++) {
    total += state.heights[i] || estimate(i);
  }
  return { total: total };
}

function totalHeight() {
  let total = 0;
  for (let i = 0; i < state.heights.length; i++) {
    total += state.heights[i] || estimate(i);
  }
  return total;
}

function rowTop(i) {
  let total = 0;
  for (let k = 0; k < i; k++) total += state.heights[k] || estimate(k);
  return total;
}

/* Which row indices should be mounted for the current scroll position. */
function visibleRange() {
  const top = window.scrollY - OVERSIMPLE * 40;
  const bottom = window.scrollY + window.innerHeight + OVERSIMPLE * 40;
  let i = 0, acc = 0;
  // find first index whose top >= top
  while (i < state.heights.length && acc < top) {
    acc += state.heights[i] || estimate(i);
    i++;
  }
  let start = Math.max(0, i - 1);
  let j = start, acc2 = 0;
  for (let k = 0; k < start; k++) acc2 += state.heights[k] || estimate(k);
  while (j < state.heights.length && acc2 < bottom) {
    acc2 += state.heights[j] || estimate(j);
    j++;
  }
  return { start: start, end: Math.min(j, state.heights.length) - 1 };
}

function requestRender() {
  if (state.scrollRaf) return;
  state.scrollRaf = requestAnimationFrame(render);
}

function render() {
  state.scrollRaf = 0;
  // Only render within a loaded window; search uses its own list.
  if (state.searchActive) return;

  // Reset spacer to total height
  els.window.style.height = totalHeight() + "px";

  const { start, end } = visibleRange();

  // unmount rows outside viewport
  for (const i of Array.from(state.mounted)) {
    if (i < start || i > end) {
      const el = document.getElementById("row-" + i);
      if (el) el.remove();
      state.mounted.delete(i);
    }
  }

  // mount rows inside viewport
  for (let i = start; i <= end; i++) {
    if (state.mounted.has(i)) continue;
    const el = document.createElement("div");
    el.id = "row-" + i;
    el.className = "row";
    el.style.top = rowTop(i) + "px";
    buildRowDom(el, state.rows[i]);
    els.window.appendChild(el);
    state.mounted.add(i);
    measureRow(i, el);
    // Media loads asynchronously: once an image/video has real dimensions,
    // re-measure the row and re-flow everything below it.
    el.querySelectorAll("img").forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", () => measureRow(i, el), { once: true });
        img.addEventListener("error", () => measureRow(i, el), { once: true });
      }
    });
    el.querySelectorAll("video").forEach((v) => {
      if (v.readyState < 1) {
        v.addEventListener("loadedmetadata", () => measureRow(i, el), { once: true });
      }
    });
  }
  maybeLoadNextMonth();
}

/* Measure a row and, if its height changed, re-flow the layout. */
function measureRow(i, el) {
  const h = el.offsetHeight;
  if (h > 0 && h !== state.heights[i]) {
    state.heights[i] = h;
    relayout();
    requestRender();
  }
}

/* Recompute the window height and the top offset of every mounted row. */
function relayout() {
  els.window.style.height = totalHeight() + "px";
  for (const i of state.mounted) {
    const el = document.getElementById("row-" + i);
    if (el) el.style.top = rowTop(i) + "px";
  }
  // While a jump is settling, media loading above the target keeps pushing
  // it down — re-aim on every reflow until the settle window expires.
  if (state.pendingJump != null) aimAt(state.pendingJump);
}

/* Aim the viewport so row `i` sits ~90px from the top. Instant scrolling —
   smooth behavior would make repeated re-aims lag behind the layout. */
function aimAt(i) {
  const el = document.getElementById("row-" + i);
  if (el) {
    const delta = el.getBoundingClientRect().top - 90;
    if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: "instant" });
  } else {
    window.scrollTo({ top: Math.max(0, rowTop(i) - 80), behavior: "instant" });
  }
}

/* ---------------- Row DOM building ---------------- */
function buildRowDom(el, row) {
  const rec = row.rec;

  if (rec.kind === "system") {
    const sys = document.createElement("div");
    sys.className = "sys";
    sys.textContent = rec.body || "MENSAGEM DO SISTEMA";
    el.appendChild(sys);
    return;
  }

  const isRight = rec.sender === "AMOR 💖";

  // Day rule is a direct child of the row (NOT inside the flex .msg):
  // inside .msg it gets flexed to the right column and its margins
  // collapse, breaking the row height measurement.
  if (row.newDay && rec.ts) {
    const rule = document.createElement("div");
    rule.className = "day-rule";
    const bar = document.createElement("span");
    bar.className = "label-bar";
    bar.textContent = "DIA";
    const date = document.createElement("span");
    date.className = "day-date";
    date.textContent = fmtDayRule(rec.ts);
    rule.appendChild(bar);
    rule.appendChild(date);
    el.appendChild(rule);
  }

  const msg = document.createElement("article");
  msg.className = "msg " + (isRight ? "right" : "left");

  const inner = document.createElement("div");
  inner.className = "msg-inner";

  // author label
  if (rec.sender) {
    const author = document.createElement("div");
    author.className = "author";
    author.textContent = rec.sender;
    inner.appendChild(author);
  }

  // message content
  if (rec.kind === "media") {
    const wrap = document.createElement("div");
    wrap.className = "media";
    wrap.appendChild(buildMedia(rec));
    inner.appendChild(wrap);
    if (rec.body) {
      const cap = document.createElement("div");
      cap.className = "caption";
      cap.textContent = rec.body;
      inner.appendChild(cap);
    }
  } else if (rec.body) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = rec.body;
    inner.appendChild(bubble);
  }

  // timestamp
  if (rec.ts) {
    const t = document.createElement("div");
    t.className = "msg-time";
    t.textContent = fmtTime(rec.ts);
    inner.appendChild(t);
  }

  msg.appendChild(inner);
  el.appendChild(msg);
}

function buildMedia(rec) {
  const src = resolveMedia(rec.file);

  if (rec.media === "image") {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = rec.file || "imagem";
    img.src = src;
    return img;
  }
  if (rec.media === "sticker") {
    const wrap = document.createElement("span");
    wrap.className = "sticker";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "sticker";
    img.src = src;
    wrap.appendChild(img);
    return wrap;
  }
  if (rec.media === "video") {
    const v = document.createElement("video");
    v.controls = true;
    v.preload = "metadata";
    v.src = src;
    return v;
  }
  if (rec.media === "audio") {
    const a = document.createElement("audio");
    a.controls = true;
    a.preload = "metadata";
    a.src = src;
    if ((src || "").toLowerCase().endsWith(".opus")) {
      a.title = ".opus — pode não tocar no iOS";
    }
    return a;
  }
  if (rec.media === "document") {
    const a = document.createElement("a");
    a.className = "doc";
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "↳ " + (rec.file || "DOCUMENTO");
    return a;
  }
  // fallback: unknown media type
  const a = document.createElement("a");
  a.className = "doc";
  a.href = src;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "↳ " + (rec.file || "ARQUIVO");
  return a;
}
async function maybeLoadNextMonth() {
  if (state.loading) return;
  const next = state.loadedThrough + 1;
  if (next >= state.months.length) return;
  // Only auto-load when near the bottom of the loaded rows.
  const total = totalHeight();
  const viewBottom = window.scrollY + window.innerHeight;
  if (viewBottom < total - window.innerHeight * 2) return;

  state.loading = true;
  els.loadState.hidden = false;
  const prevDay = state.rows.length
    ? dayKey(state.rows[state.rows.length - 1].rec.ts)
    : null;
  await appendMonth(next, prevDay);
  state.loading = false;
  els.loadState.hidden = true;
  requestRender();
}
/* ---------------- Search ---------------- */
function normWord(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenizeQuery(s) {
  const toks = s.match(/[\w\u00c0-\u024f']+/g) || [];
  return toks.map(normWord).filter((t) => t.length > 1);
}

const searchDataCache = {};

async function doSearch() {
  const q = els.searchInput.value.trim();
  state.searchActive = true;
  els.timeline.hidden = true;
  els.searchPanel.hidden = false;
  els.searchResults.hidden = false;
  els.searchBack.hidden = false;
  els.searchResults.innerHTML = "";
  els.searchStatus.textContent = "BUSCANDO…";
  els.loadState.hidden = false;

  if (!q) {
    els.searchStatus.textContent = "DIGITE ALGO PARA BUSCAR.";
    els.loadState.hidden = true;
    return;
  }
  const terms = tokenizeQuery(q);
  if (!terms.length) {
    els.searchStatus.textContent = "TERMOS MUITO CURTOS — TENTE OUTRO TERMO.";
    els.loadState.hidden = true;
    return;
  }

  try {
    // Load every month's index in parallel
    const idxs = await Promise.all(
      state.months.map((m) =>
        fetchJSON("search/" + m + ".json").catch(() => null)
      )
    );

    // per-month hit docids (intersection of all terms)
    const monthHits = state.months.map((m, mi) => {
      const idx = idxs[mi];
      if (!idx) return [];
      let ids = null;
      terms.forEach((t) => {
        const termDocs = termDocids(idx.terms[t]);
        const set = new Set(termDocs);
        ids = ids === null ? set : new Set([...ids].filter((d) => set.has(d)));
      });
      return ids ? Array.from(ids).sort((a, b) => a - b) : [];
    });

    const total = monthHits.reduce((a, b) => a + b.length, 0);
    els.searchStatus.textContent =
      total + " RESULTADO" + (total === 1 ? "" : "S") +
      " PARA \u201C" + terms.join(" ") + "\u201D";

    if (total === 0) {
      els.loadState.hidden = true;
      return;
    }

    // Render up to a generous cap, fetching month data lazily
    let shown = 0;
    const MAX = 300;
    outer:
    for (let mi = 0; mi < state.months.length; mi++) {
      const m = state.months[mi];
      if (monthHits[mi].length === 0) continue;
      const records = await getMonthRecords(m);
      for (const docid of monthHits[mi]) {
        const rec = records[docid];
        renderSearchResult(m, docid, rec, terms);
        shown++;
        if (shown >= MAX) break outer;
      }
    }
  } catch (e) {
    els.searchStatus.textContent = "ERRO NA BUSCA: " + e.message;
  }
  els.loadState.hidden = true;
}

function termDocids(flat) {
  if (!flat) return [];
  const out = [];
  for (let k = 0; k < flat.length; k += 2) out.push(flat[k]);
  return out;
}

async function getMonthRecords(key) {
  if (!searchDataCache[key]) {
    searchDataCache[key] = await fetchJSON("data/" + key + ".json");
  }
  return searchDataCache[key];
}

function highlight(text, terms) {
  let escaped = escapeHTML(text);
  const re = new RegExp(
    "(" +
      terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
      ")",
    "gi"
  );
  return escaped.replace(re, "<mark>$1</mark>");
}

function snippet(body, terms, max = 220) {
  if (!body) return "";
  if (body.length <= max) return highlight(body, terms);
  return highlight(body.slice(0, max) + "…", terms);
}

function renderSearchResult(month, docid, rec, terms) {
  const el = document.createElement("div");
  el.className = "result jumpable";
  const src = document.createElement("div");
  src.className = "source";
  src.textContent =
    fmtMonth(month) + " · " + (rec.sender || "SISTEMA") +
    (rec.ts ? " · " + fmtTime(rec.ts) : "");
  el.appendChild(src);

  const body = document.createElement("div");
  body.className = "body";
  if (rec.kind === "media") {
    body.innerHTML = "<i>MÍDIA: " + escapeHTML(rec.file || "") + "</i>" +
      (rec.body ? " — " + snippet(rec.body, terms) : "");
  } else {
    body.innerHTML = rec.body ? snippet(rec.body, terms) : "<i>(vazio)</i>";
  }
  el.appendChild(body);
  el.addEventListener("click", () => jumpToMessage(month, docid));
  els.searchResults.appendChild(el);
}

function exitSearch() {
  state.searchActive = false;
  els.timeline.hidden = false;
  els.searchPanel.hidden = true;
  els.searchResults.hidden = true;
  els.searchResults.innerHTML = "";
  els.searchBack.hidden = true;
  els.searchStatus.textContent = "";
  requestRender();
}
/* ---------------- Navigation ---------------- */
async function jumpToMonth(key) {
  exitSearch();
  const mi = state.months.indexOf(key);
  if (mi < 0) return;
  state.startMonth = mi;
  await loadWindow();
  requestRender();
  window.scrollTo(0, 0);
  setActiveMonth(key);
  history.replaceState(null, "", "#m=" + key);
}

async function jumpToMessage(month, docid) {
  exitSearch();
  const mi = state.months.indexOf(month);
  if (mi < 0) return;
  state.startMonth = mi;
  await loadWindow();
  // rows[0] is the first message of `month`, so global index == docid
  const globalIdx = Math.min(docid, state.rows.length - 1);
  // Render synchronously so rows up to the viewport are measured before
  // we compute the target offset.
  render();
  setActiveMonth(month);
  // Keep aiming at the target while media loads and heights shift.
  // Any relayout (image load, font swap) re-aims until the settle window
  // expires or the user scrolls manually.
  state.pendingJump = globalIdx;
  clearTimeout(state.pendingJumpTimer);
  state.pendingJumpTimer = setTimeout(cancelPendingJump, 2500);
  aimAt(globalIdx);
  requestAnimationFrame(() => {
    render();
    aimAt(globalIdx);
    flashRow(globalIdx);
  });
}

function cancelPendingJump() {
  state.pendingJump = null;
  clearTimeout(state.pendingJumpTimer);
}

function flashRow(i) {
  setTimeout(() => {
    const el = document.getElementById("row-" + i);
    if (el) {
      el.style.background = "var(--color-highlighter-pink)";
      setTimeout(() => {
        if (el) el.style.background = "transparent";
      }, 1500);
    }
  }, 60);
}

function setActiveMonth(key) {
  els.months.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.month === key);
  });
}

/* ---------------- Events ---------------- */
function bindEvents() {
  window.addEventListener("scroll", () => requestRender(), { passive: true });
  // Manual scrolling by the user cancels any jump still settling.
  window.addEventListener("wheel", cancelPendingJump, { passive: true });
  window.addEventListener("touchstart", cancelPendingJump, { passive: true });

  els.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch();
  });

  els.searchBack.addEventListener("click", () => {
    exitSearch();
    window.scrollTo(0, 0);
  });
}

function onResize() {
  requestRender();
}

/* ---------------- Boot ---------------- */
/* Password gate: SHA-256 of the site password. This is a courtesy
   barrier only — data files remain publicly fetchable on Pages. */
const GATE_HASH = "7fd14c16a104a7721ab0e303ea4dde030ba0533e4b49baba4cdf05402f0345a7";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function boot() {
  const gate = $("#gate");
  if (!gate) { init(); return; }

  if (sessionStorage.getItem("unlocked") === "1") {
    gate.remove();
    init();
    return;
  }

  const form = $("#gate-form");
  const input = $("#gate-input");
  const error = $("#gate-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const hex = await sha256Hex(input.value);
    if (hex === GATE_HASH) {
      sessionStorage.setItem("unlocked", "1");
      gate.remove();
      init();
    } else {
      error.hidden = false;
      input.value = "";
      input.focus();
    }
  });
  input.focus();
}

boot();