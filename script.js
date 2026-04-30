"use strict";

// ═══════════════════════════════════════════════════════════
//  MBA Vocabulary — script.js  (v2.1 — UX fixes)
// ═══════════════════════════════════════════════════════════

const API = window.APPS_SCRIPT_URL;

if (!API) {
  alert("API URL missing. Set window.APPS_SCRIPT_URL in index.html");
}

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

let state = {
  words: [],
  queue: JSON.parse(localStorage.getItem("queue") || "[]"),
  editMode:    false,
  editWordId:  null,
  editEntryId: null,
  search: "",
  sort: "newest",
  view: "table",          // "table" | "cards"
  expandedCells: {},      // key: "wordId-entryId-field" → true
  expandedDefs: {},       // key: wordId → true
};

// ═══════════════════════════════════════════════════════════
//  QUEUE PERSISTENCE
// ═══════════════════════════════════════════════════════════

function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
  updateQueueBadge();
}

function updateQueueBadge() {
  const badge = document.getElementById("queueBadge");
  if (!badge) return;
  if (state.queue.length > 0) {
    badge.textContent = state.queue.length + " queued";
    badge.classList.add("visible");
  } else {
    badge.classList.remove("visible");
  }
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════

function toast(msg, type = "info", duration = 3200) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("removing");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, duration);
}

// ═══════════════════════════════════════════════════════════
//  ONLINE / OFFLINE STATUS
// ═══════════════════════════════════════════════════════════

function updateOnlineStatus() {
  const badge  = document.getElementById("statusBadge");
  const banner = document.getElementById("offlineBanner");
  if (!badge) return;
  if (navigator.onLine) {
    badge.className = "status-badge online";
    badge.querySelector(".label").textContent = "Online";
    if (banner) banner.classList.remove("visible");
    syncQueue();
  } else {
    badge.className = "status-badge offline";
    badge.querySelector(".label").textContent = "Offline";
    if (banner) banner.classList.add("visible");
  }
  updateQueueBadge();
}

window.addEventListener("online",  updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

// ═══════════════════════════════════════════════════════════
//  API  (GET-tunneling)
// ═══════════════════════════════════════════════════════════

async function api(action, payload = {}) {
  const params = new URLSearchParams({
    action:  action.toUpperCase(),
    payload: JSON.stringify(payload),
    t:       Date.now(),
  });
  const url = API + "?" + params.toString();
  const res  = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error");
  return json.data;
}

// ═══════════════════════════════════════════════════════════
//  FETCH
// ═══════════════════════════════════════════════════════════

async function fetchWords() {
  try {
    const data  = await api("GET");
    state.words = data.reverse();
    render();
    updateStats();
  } catch (err) {
    console.error("Fetch failed:", err);
    document.getElementById("tableBody").innerHTML =
      `<tr><td colspan="3" class="error-cell">Failed to load. Check your connection.</td></tr>`;
    toast("Failed to load words. Check your connection.", "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  ADD
// ═══════════════════════════════════════════════════════════

async function addWord() {
  const wordEl = document.getElementById("wordInput");
  const defEl  = document.getElementById("defInput");
  const exEl   = document.getElementById("exInput");
  const addBtn = document.getElementById("addBtn");

  const word = wordEl.value.trim();
  const def  = defEl.value.trim();
  const ex   = exEl.value.trim();

  if (!word || !def) {
    toast("Please fill in Word and Definition.", "warning");
    return;
  }

  if (state.editMode) {
    await updateWord(word, def, ex);
    return;
  }

  // Check for existing word — offer merge via modal
  const normalized = word.trim().toLowerCase().replace(/\s+/g, " ");
  const existing   = state.words.find(w => w.word === normalized || w.displayWord.toLowerCase() === normalized);
  if (existing) {
    openMergeModal(existing, word, def, ex);
    return;
  }

  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  try {
    const result = await api("ADD", { displayWord: word, def, ex });
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    else          state.words.unshift(result);
    toast("Word added!", "success");
  } catch (err) {
    state.queue.push({ displayWord: word, def, ex });
    saveQueue();
    toast("Offline — word queued for sync.", "warning");
  }

  wordEl.value = defEl.value = exEl.value = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  render();
  updateStats();
}

// ─── Merge Modal ─────────────────────────────────────────

let _pendingMerge = null;

function openMergeModal(existingWord, displayWord, def, ex) {
  _pendingMerge = { existingWord, displayWord, def, ex };
  document.getElementById("mergeWord").textContent     = existingWord.displayWord;
  document.getElementById("mergeDefCount").textContent = existingWord.entries.length;
  document.getElementById("mergeModal").classList.add("open");
}

async function confirmMerge() {
  closeMergeModal();
  if (!_pendingMerge) return;
  const { displayWord, def, ex } = _pendingMerge;
  _pendingMerge = null;

  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  try {
    const result = await api("ADD", { displayWord, def, ex });
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    else          state.words.unshift(result);
    toast("Definition added!", "success");
  } catch (err) {
    state.queue.push({ displayWord, def, ex });
    saveQueue();
    toast("Offline — word queued.", "warning");
  }

  document.getElementById("wordInput").value = "";
  document.getElementById("defInput").value  = "";
  document.getElementById("exInput").value   = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  render();
  updateStats();
}

function closeMergeModal() {
  document.getElementById("mergeModal").classList.remove("open");
  _pendingMerge = null;
}

// ═══════════════════════════════════════════════════════════
//  EDIT MODAL
// ═══════════════════════════════════════════════════════════

function openEditModal(wordId, entryId) {
  const word  = state.words.find(w => w.id === wordId);
  const entry = word?.entries.find(e => e.id === entryId);
  if (!word || !entry) return;

  document.getElementById("editWordId").value  = wordId;
  document.getElementById("editEntryId").value = entryId;
  document.getElementById("editDef").value     = entry.def;
  document.getElementById("editEx").value      = entry.ex || "";
  document.getElementById("editModal").classList.add("open");
}

function closeEditModal() {
  document.getElementById("editModal").classList.remove("open");
}

async function saveEdit() {
  const wordId  = document.getElementById("editWordId").value;
  const entryId = document.getElementById("editEntryId").value;
  const def     = document.getElementById("editDef").value.trim();
  const ex      = document.getElementById("editEx").value.trim();

  if (!def) {
    toast("Definition cannot be empty.", "warning");
    return;
  }

  const saveBtn = document.getElementById("editSaveBtn");
  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving…";

  try {
    const result = await api("UPDATE", { id: wordId, entryId, def, ex });
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    closeEditModal();
    render();
    updateStats();
    toast("Updated!", "success");
  } catch (err) {
    console.error("Update failed:", err);
    toast("Update failed: " + err.message, "error");
  }

  saveBtn.disabled    = false;
  saveBtn.textContent = "Save Changes";
}

// ─── Legacy inline edit (startEdit) — kept for backward compat ─
function startEdit(wordId, entryId) {
  openEditModal(wordId, entryId);
}

function cancelEdit() {
  state.editMode    = false;
  state.editWordId  = null;
  state.editEntryId = null;
  document.getElementById("wordInput").value = "";
  document.getElementById("defInput").value  = "";
  document.getElementById("exInput").value   = "";
  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  addBtn.style.background  = "";
  addBtn.style.borderColor = "";
  const cancelBtn = document.getElementById("cancelEditBtn");
  if (cancelBtn) cancelBtn.style.display = "none";
  render();
}

// ═══════════════════════════════════════════════════════════
//  UPDATE
// ═══════════════════════════════════════════════════════════

async function updateWord(displayWord, def, ex) {
  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Updating…";

  try {
    const result = await api("UPDATE", {
      id:      state.editWordId,
      entryId: state.editEntryId,
      def,
      ex,
    });
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    toast("Updated!", "success");
  } catch (err) {
    console.error("Update failed:", err);
    toast("Update failed: " + err.message, "error");
  }

  cancelEdit();
}

// ═══════════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════════

async function deleteWord(id) {
  if (!confirm("Delete this word and all its definitions?")) return;
  try {
    await api("DELETE", { id: String(id) });
    state.words = state.words.filter(w => String(w.id) !== String(id));
    if (state.editWordId === id) cancelEdit();
    render();
    updateStats();
    toast("Word deleted.", "info");
  } catch (err) {
    console.error("Delete failed:", err);
    toast("Delete failed: " + err.message, "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  OFFLINE SYNC
// ═══════════════════════════════════════════════════════════

async function syncQueue() {
  if (!state.queue.length || !navigator.onLine) return;

  const badge = document.getElementById("statusBadge");
  if (badge) { badge.className = "status-badge syncing"; badge.querySelector(".label").textContent = "Syncing…"; }

  const pending  = [...state.queue];
  state.queue    = [];

  for (const item of pending) {
    try {
      const result = await api("ADD", item);
      const idx    = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) state.words[idx] = result;
      else          state.words.unshift(result);
    } catch {
      state.queue.push(item);
    }
  }

  saveQueue();
  if (badge) { badge.className = "status-badge online"; badge.querySelector(".label").textContent = "Online"; }
  render();
  updateStats();
}

// ═══════════════════════════════════════════════════════════
//  SPEECH
// ═══════════════════════════════════════════════════════════

function speak(text) {
  if (!("speechSynthesis" in window)) {
    toast("Speech not supported in this browser.", "warning");
    return;
  }
  speechSynthesis.cancel();
  const u  = new SpeechSynthesisUtterance(text);
  u.lang   = "en-US";
  speechSynthesis.speak(u);
}

// ═══════════════════════════════════════════════════════════
//  SEARCH + SORT + FILTER
// ═══════════════════════════════════════════════════════════

function getFilteredWords() {
  let words = [...state.words];

  // Search
  const q = state.search.trim().toLowerCase();
  if (q) {
    words = words.filter(w => {
      if (w.displayWord.toLowerCase().includes(q)) return true;
      return w.entries.some(e =>
        (e.def || "").toLowerCase().includes(q) ||
        (e.ex  || "").toLowerCase().includes(q)
      );
    });
  }

  // Sort
  if (state.sort === "oldest") {
    words = words.slice().reverse();
  } else if (state.sort === "az") {
    words = words.slice().sort((a, b) =>
      a.displayWord.localeCompare(b.displayWord)
    );
  }
  // "newest" is already newest-first from fetchWords

  return words;
}

function highlight(text, query) {
  if (!query) return escHtml(text);
  const escaped = escHtml(text);
  const qEsc    = escHtml(query);
  const re      = new RegExp("(" + qEsc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return escaped.replace(re, "<mark>$1</mark>");
}

// ═══════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════

function updateStats() {
  const filtered = getFilteredWords();
  const totalDefs = state.words.reduce((s, w) => s + w.entries.length, 0);
  const el = (id) => document.getElementById(id);
  if (el("statWords"))  el("statWords").textContent  = state.words.length;
  if (el("statDefs"))   el("statDefs").textContent   = totalDefs;
  if (el("statShown"))  el("statShown").textContent  = filtered.length;
}

// ═══════════════════════════════════════════════════════════
//  READ-MORE: state-aware toggle  (Fix #5)
//  key format: "wordId-entryId-field"
// ═══════════════════════════════════════════════════════════

function toggleReadMore(btn) {
  const cell = btn.closest(".clamp-cell");
  if (!cell) return;

  const key = cell.dataset.clampKey;
  const expanded = cell.classList.toggle("expanded");
  btn.textContent = expanded ? "Show less ▲" : "Read more ▼";

  // Persist state if key exists
  if (key) {
    if (expanded) {
      state.expandedCells[key] = true;
    } else {
      delete state.expandedCells[key];
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  OVERFLOW DETECTION  (Fix #1, #2)
//  Called after every render to show/hide read-more buttons
// ═══════════════════════════════════════════════════════════

function detectOverflow() {
  // Use requestAnimationFrame to ensure layout is complete
  requestAnimationFrame(() => {
    document.querySelectorAll(".clamp-cell").forEach(cell => {
      const text = cell.querySelector(".clamp-text");
      const btn  = cell.querySelector(".read-more-btn");
      if (!text || !btn) return;

      // If already expanded, always show the "Show less" button
      if (cell.classList.contains("expanded")) {
        btn.style.display = "inline-block";
        return;
      }

      // Check for overflow: scrollWidth > clientWidth (single-line clamp)
      const overflows = text.scrollWidth > text.clientWidth + 1;
      btn.style.display = overflows ? "inline-block" : "none";
    });
  });
}

// Restore expanded state from state.expandedCells after render
function restoreExpandedCells() {
  Object.keys(state.expandedCells).forEach(key => {
    const cell = document.querySelector(`.clamp-cell[data-clamp-key="${CSS.escape(key)}"]`);
    if (!cell) return;
    cell.classList.add("expanded");
    const btn = cell.querySelector(".read-more-btn");
    if (btn) btn.textContent = "Show less ▲";
  });
}

// ═══════════════════════════════════════════════════════════
//  SHOW-MORE DEFS TOGGLE
// ═══════════════════════════════════════════════════════════

function toggleShowMoreDefs(wordId) {
  state.expandedDefs[wordId] = !state.expandedDefs[wordId];
  // Patch only the def cell for this row — no full re-render
  const row = document.querySelector(`tr[data-word-id="${wordId}"]`);
  if (!row) { render(); return; }
  const defCell = row.querySelector(".def-cell");
  if (!defCell) return;
  const word = state.words.find(w => w.id === wordId);
  if (!word) return;
  defCell.innerHTML = buildDefCellHtml(word, state.search);
  // Re-run restore + overflow detection on patched cell only
  restoreExpandedCells();
  detectOverflow();
}

// ═══════════════════════════════════════════════════════════
//  BUILD TABLE HTML HELPERS
// ═══════════════════════════════════════════════════════════

function buildDefCellHtml(w, q) {
  const expanded = !!state.expandedDefs[w.id];
  const entries  = expanded ? w.entries : w.entries.slice(0, 1);
  const hasMore  = w.entries.length > 1;

  const entriesHtml = entries.map((e, i) => {
    const defKey = `${w.id}-${e.id}-def`;
    const exKey  = `${w.id}-${e.id}-ex`;
    return `
    <div class="entry-block">
      ${w.entries.length > 1 && (expanded || i === 0)
        ? `<div class="entry-num">Def. ${w.entries.indexOf(e) + 1}</div>`
        : ""}
      <div class="entry-actions-row">
        <div class="clamp-cell" data-clamp-key="${escAttr(defKey)}">
          <div class="entry-def clamp-text">${highlight(e.def, q)}</div>
          <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
        </div>
        <button class="btn btn-icon edit entry-edit-btn" onclick="openEditModal('${escAttr(w.id)}','${escAttr(e.id)}')" title="Edit this definition">✏️</button>
      </div>
      ${e.ex ? `
        <div class="clamp-cell" data-clamp-key="${escAttr(exKey)}">
          <div class="entry-ex clamp-text">${highlight(e.ex, q)}</div>
          <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
        </div>` : ""}
    </div>
  `}).join('<div class="entry-divider"></div>');

  const moreBtn = hasMore
    ? `<button class="show-more-btn" onclick="toggleShowMoreDefs('${escAttr(w.id)}')">
         ${expanded
           ? "Collapse ▲"
           : `Show ${w.entries.length - 1} more definition${w.entries.length - 1 > 1 ? "s" : ""}`}
       </button>`
    : "";

  return entriesHtml + moreBtn;
}

function buildTableRow(w, q) {
  return `
    <tr data-word-id="${escAttr(w.id)}">
      <td class="word-cell">
        <span class="word-text word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</span>
        ${w.entries.length > 1 ? `<span class="entry-count-badge">${w.entries.length}</span>` : ""}
      </td>
      <td class="def-cell">${buildDefCellHtml(w, q)}</td>
      <td class="actions-cell">
        <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Pronounce">🔊</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(w.id)}')" title="Delete word">🗑</button>
      </td>
    </tr>`;
}

// ── Card HTML  (Fix #3: clamp system, no inline styles, per-entry edit) ──

function buildCardHtml(w, q) {
  const entriesHtml = w.entries.map((e, i) => {
    const defKey = `${w.id}-${e.id}-card-def`;
    const exKey  = `${w.id}-${e.id}-card-ex`;
    return `
      <div class="card-entry">
        ${w.entries.length > 1
          ? `<div class="card-def-num">Definition ${i + 1}</div>`
          : ""}
        <div class="card-entry-row">
          <div class="card-entry-content">
            <div class="clamp-cell" data-clamp-key="${escAttr(defKey)}">
              <div class="entry-def clamp-text">${highlight(e.def, q)}</div>
              <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
            </div>
            ${e.ex ? `
              <div class="clamp-cell" data-clamp-key="${escAttr(exKey)}">
                <div class="entry-ex clamp-text">${highlight(e.ex, q)}</div>
                <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
              </div>` : ""}
          </div>
          <button class="btn btn-icon edit card-entry-edit-btn" onclick="openEditModal('${escAttr(w.id)}','${escAttr(e.id)}')" title="Edit this definition">✏️</button>
        </div>
      </div>`;
  }).join('<div class="entry-divider"></div>');

  return `
    <div class="vocab-card" data-word-id="${escAttr(w.id)}">
      <div class="card-header">
        <div class="card-word word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</div>
        ${w.createdAt ? `<div class="card-date">${fmtDate(w.createdAt)}</div>` : ""}
      </div>
      <div class="card-entries">${entriesHtml}</div>
      <div class="card-actions">
        <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Pronounce">🔊 Speak</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(w.id)}')" title="Delete">🗑 Delete</button>
      </div>
    </div>`;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════

function render() {
  const filtered = getFilteredWords();
  const q        = state.search.trim().toLowerCase();

  updateStats();

  if (state.view === "table") {
    renderTable(filtered, q);
  } else {
    renderCards(filtered, q);
  }

  // Restore expanded cells from state, then detect overflow
  restoreExpandedCells();
  detectOverflow();
}

function renderTable(words, q) {
  const tbody = document.getElementById("tableBody");
  if (!tbody) return;

  if (!words.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3">
          <div class="empty-state">
            <div class="empty-icon">📖</div>
            <p>${state.search ? "No words match your search." : "No words yet. Add your first one above."}</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = words.map(w => buildTableRow(w, q)).join("");
}

function renderCards(words, q) {
  const grid = document.getElementById("cardsGrid");
  if (!grid) return;

  if (!words.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📖</div>
        <p>${state.search ? "No words match your search." : "No words yet. Add your first one above."}</p>
      </div>`;
    return;
  }

  grid.innerHTML = words.map(w => buildCardHtml(w, q)).join("");
}

// ═══════════════════════════════════════════════════════════
//  VIEW TOGGLE
// ═══════════════════════════════════════════════════════════

function setView(view) {
  state.view = view;

  const tableWrapper = document.getElementById("tableViewWrapper");
  const cardsWrapper = document.getElementById("cardsViewWrapper");
  const btns         = document.querySelectorAll(".view-toggle .vbtn");

  if (view === "table") {
    tableWrapper.classList.remove("hidden");
    cardsWrapper.classList.add("hidden");
  } else {
    tableWrapper.classList.add("hidden");
    cardsWrapper.classList.remove("hidden");
  }

  btns.forEach(b => b.classList.toggle("active", b.dataset.view === view));
  render();
}

// ═══════════════════════════════════════════════════════════
//  CSV EXPORT
// ═══════════════════════════════════════════════════════════

function exportCSV() {
  if (!state.words.length) {
    toast("Nothing to export.", "warning");
    return;
  }

  const rows = [["word", "definition", "example"]];
  state.words.forEach(w => {
    w.entries.forEach(e => {
      rows.push([csvEsc(w.displayWord), csvEsc(e.def), csvEsc(e.ex || "")]);
    });
  });

  const csv  = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "mba-vocabulary.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("CSV exported!", "success");
}

function csvEsc(val) {
  const s = String(val || "").replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// ═══════════════════════════════════════════════════════════
//  CSV IMPORT
// ═══════════════════════════════════════════════════════════

function importCSV(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const text  = e.target.result;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) { toast("Empty file.", "warning"); return; }

    // Skip header row if present
    const start = lines[0].toLowerCase().includes("word") ? 1 : 0;
    const rows  = lines.slice(start).map(parseCSVRow).filter(r => r.length >= 2 && r[0] && r[1]);

    if (!rows.length) { toast("No valid rows found.", "warning"); return; }

    toast(`Importing ${rows.length} rows…`, "info");
    let ok = 0, fail = 0;

    for (const row of rows) {
      const [word, def, ex = ""] = row;
      try {
        const result = await api("ADD", { displayWord: word.trim(), def: def.trim(), ex: ex.trim() });
        const idx = state.words.findIndex(w => w.id === result.id);
        if (idx >= 0) state.words[idx] = result;
        else          state.words.unshift(result);
        ok++;
      } catch {
        state.queue.push({ displayWord: word.trim(), def: def.trim(), ex: ex.trim() });
        fail++;
      }
    }

    saveQueue();
    render();
    updateStats();
    toast(`Import done: ${ok} added${fail ? ", " + fail + " queued." : "."}`, ok ? "success" : "warning");
  };
  reader.readAsText(file);
}

function parseCSVRow(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      result.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ═══════════════════════════════════════════════════════════
//  HTML ESCAPING
// ═══════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════
//  EXPOSE GLOBALS  (for onclick= attributes)
// ═══════════════════════════════════════════════════════════

window.cancelEdit         = cancelEdit;
window.startEdit          = startEdit;
window.openEditModal      = openEditModal;
window.deleteWord         = deleteWord;
window.speak              = speak;
window.toggleReadMore     = toggleReadMore;
window.toggleShowMoreDefs = toggleShowMoreDefs;

// ═══════════════════════════════════════════════════════════
//  EVENT WIRING
// ═══════════════════════════════════════════════════════════

// Add Word button
document.getElementById("addBtn").addEventListener("click", addWord);

// Enter key on inputs
["wordInput", "defInput", "exInput"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") addWord();
  });
});

// Cancel edit button (hidden by default)
const inputActions = document.querySelector(".input-actions");
const cancelBtn    = document.createElement("button");
cancelBtn.id        = "cancelEditBtn";
cancelBtn.className = "btn btn-ghost";
cancelBtn.textContent = "Cancel";
cancelBtn.style.display = "none";
cancelBtn.addEventListener("click", cancelEdit);
inputActions.appendChild(cancelBtn);

// Edit modal buttons
document.getElementById("editSaveBtn").addEventListener("click", saveEdit);
document.getElementById("editCancelBtn").addEventListener("click", closeEditModal);

// Merge modal buttons
document.getElementById("mergeConfirmBtn").addEventListener("click", confirmMerge);
document.getElementById("mergeCancelBtn").addEventListener("click", closeMergeModal);

// Close modals on backdrop click
document.getElementById("editModal").addEventListener("click", function(e) {
  if (e.target === this) closeEditModal();
});
document.getElementById("mergeModal").addEventListener("click", function(e) {
  if (e.target === this) closeMergeModal();
});

// Search
document.getElementById("searchInput").addEventListener("input", function() {
  state.search = this.value;
  render();
});

// Sort
document.getElementById("sortSelect").addEventListener("change", function() {
  state.sort = this.value;
  render();
});

// View toggle
document.querySelectorAll(".view-toggle .vbtn").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

// Export CSV
document.getElementById("exportBtn").addEventListener("click", exportCSV);

// Import CSV
document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("csvFileInput").click();
});
document.getElementById("csvFileInput").addEventListener("change", function() {
  importCSV(this.files[0]);
  this.value = ""; // reset so same file can be re-imported
});

// Re-run overflow detection on window resize (layout changes affect overflow)
window.addEventListener("resize", () => {
  detectOverflow();
});

// ═══════════════════════════════════════════════════════════
//  SERVICE WORKER
// ═══════════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js")
    .catch(err => console.warn("SW registration failed:", err));
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

updateOnlineStatus();
fetchWords();
