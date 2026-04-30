"use strict";

// ═══════════════════════════════════════════════════════════
//  MBA Vocabulary — script.js
//  Compatible with: index.html v2, Code.gs (fixed), style.css
// ═══════════════════════════════════════════════════════════

const API = window.APPS_SCRIPT_URL;

// ── DOM refs ────────────────────────────────────────────────
const wordInput        = document.getElementById("wordInput");
const defInput         = document.getElementById("defInput");
const exInput          = document.getElementById("exInput");
const addBtn           = document.getElementById("addBtn");
const searchInput      = document.getElementById("searchInput");
const sortSelect       = document.getElementById("sortSelect");
const tableBody        = document.getElementById("tableBody");
const cardsGrid        = document.getElementById("cardsGrid");
const tableViewWrapper = document.getElementById("tableViewWrapper");
const cardsViewWrapper = document.getElementById("cardsViewWrapper");
const statWords        = document.getElementById("statWords");
const statDefs         = document.getElementById("statDefs");
const statShown        = document.getElementById("statShown");
const statusBadge      = document.getElementById("statusBadge");
const statusLabel      = statusBadge.querySelector(".label");
const offlineBanner    = document.getElementById("offlineBanner");
const queueBadge       = document.getElementById("queueBadge");
const toastContainer   = document.getElementById("toastContainer");
const exportBtn        = document.getElementById("exportBtn");
const importBtn        = document.getElementById("importBtn");
const csvFileInput     = document.getElementById("csvFileInput");

// Edit modal
const editModal        = document.getElementById("editModal");
const editWordId       = document.getElementById("editWordId");
const editEntryId      = document.getElementById("editEntryId");
const editDef          = document.getElementById("editDef");
const editEx           = document.getElementById("editEx");
const editSaveBtn      = document.getElementById("editSaveBtn");
const editCancelBtn    = document.getElementById("editCancelBtn");

// Merge modal
const mergeModal       = document.getElementById("mergeModal");
const mergeWord        = document.getElementById("mergeWord");
const mergeDefCount    = document.getElementById("mergeDefCount");
const mergeConfirmBtn  = document.getElementById("mergeConfirmBtn");
const mergeCancelBtn   = document.getElementById("mergeCancelBtn");

// ── State ───────────────────────────────────────────────────
const state = {
  words:    [],
  filtered: [],
  query:    "",
  sort:     "newest",
  view:     "table",
  queue:    JSON.parse(localStorage.getItem("offlineQueue") || "[]"),
  // Pending merge (filled when duplicate detected before user confirms)
  pendingMerge: null,
};

// ═══════════════════════════════════════════════════════════
//  API
// ═══════════════════════════════════════════════════════════

async function api(action, payload = {}) {
  const url = API + "?" + new URLSearchParams({
    action,
    payload: JSON.stringify(payload),
    t: Date.now(),           // cache-bust
  });
  const res  = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Unknown API error");
  return json.data;
}

// ═══════════════════════════════════════════════════════════
//  OFFLINE QUEUE
// ═══════════════════════════════════════════════════════════

function saveQueue() {
  localStorage.setItem("offlineQueue", JSON.stringify(state.queue));
  renderQueueBadge();
}

function renderQueueBadge() {
  if (state.queue.length > 0) {
    queueBadge.textContent = `${state.queue.length} queued`;
    queueBadge.classList.add("visible");
  } else {
    queueBadge.classList.remove("visible");
  }
}

async function syncQueue() {
  if (!state.queue.length || !navigator.onLine) return;

  setStatus("syncing", "Syncing…");
  const pending = [...state.queue];
  state.queue   = [];
  saveQueue();

  let failed = 0;
  for (const item of pending) {
    try {
      const result = await api("ADD", item);
      // Upsert into local state
      const idx = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) state.words[idx] = result;
      else state.words.unshift(result);
    } catch {
      state.queue.push(item);
      failed++;
    }
  }

  saveQueue();
  applyFilters();

  if (failed === 0) {
    setStatus("online", "Online");
    toast("Queue synced successfully", "success");
  } else {
    setStatus("failed", "Sync failed");
    toast(`${failed} item(s) failed to sync`, "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  FETCH
// ═══════════════════════════════════════════════════════════

async function fetchWords() {
  try {
    const data = await api("GET");
    // Backend returns oldest-first (sheet order); we sort in applyFilters
    state.words = data;
    applyFilters();
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Failed to load. Check connection.</p></div></td></tr>`;
    toast("Failed to load vocabulary", "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  ADD
// ═══════════════════════════════════════════════════════════

async function addWord(forceAdd = false) {
  const word = wordInput.value.trim();
  const def  = defInput.value.trim();
  const ex   = exInput.value.trim();

  if (!word || !def) {
    toast("Word and definition are required", "warning");
    return;
  }

  // Client-side duplicate detection (merge modal)
  if (!forceAdd) {
    const norm     = word.toLowerCase().replace(/\s+/g, " ");
    const existing = state.words.find(w => w.word === norm);
    if (existing) {
      // Show merge modal — do NOT submit yet
      mergeWord.textContent     = existing.displayWord;
      mergeDefCount.textContent = existing.entries.length;
      state.pendingMerge = { displayWord: word, def, ex };
      openModal(mergeModal);
      return;
    }
  }

  setAdding(true);
  try {
    const result = await api("ADD", { displayWord: word, def, ex });

    // Upsert: update if the backend merged into an existing word
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    else state.words.unshift(result);

    wordInput.value = defInput.value = exInput.value = "";
    wordInput.focus();
    applyFilters();
    toast(`"${result.displayWord}" saved`, "success");
  } catch {
    // Offline — queue it
    state.queue.push({ displayWord: word, def, ex });
    saveQueue();
    wordInput.value = defInput.value = exInput.value = "";
    applyFilters();
    toast("Saved to offline queue", "warning");
  } finally {
    setAdding(false);
  }
}

function setAdding(loading) {
  addBtn.disabled    = loading;
  addBtn.textContent = loading ? "Saving…" : "Add Word";
}

// ═══════════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════════

async function deleteWord(id) {
  const word = state.words.find(w => w.id === id);
  if (!word) return;

  try {
    await api("DELETE", { id });
    state.words = state.words.filter(w => w.id !== id);
    applyFilters();
    toast(`"${word.displayWord}" deleted`, "info");
  } catch {
    toast("Delete failed. Try again.", "error");
  }
}

// ═══════════════════════════════════════════════════════════
//  UPDATE (via edit modal)
// ═══════════════════════════════════════════════════════════

function openEditModal(wordId, entryId) {
  const word  = state.words.find(w => w.id === wordId);
  const entry = word?.entries.find(e => e.id === entryId);
  if (!word || !entry) return;

  editWordId.value  = wordId;
  editEntryId.value = entryId;
  editDef.value     = entry.def;
  editEx.value      = entry.ex || "";
  openModal(editModal);
}

async function saveEdit() {
  const id      = editWordId.value;
  const entryId = editEntryId.value;
  const def     = editDef.value.trim();
  const ex      = editEx.value.trim();

  if (!def) { toast("Definition cannot be empty", "warning"); return; }

  editSaveBtn.disabled    = true;
  editSaveBtn.textContent = "Saving…";

  try {
    const result = await api("UPDATE", { id, entryId, def, ex });
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    closeModal(editModal);
    applyFilters();
    toast("Definition updated", "success");
  } catch {
    toast("Update failed. Try again.", "error");
  } finally {
    editSaveBtn.disabled    = false;
    editSaveBtn.textContent = "Save Changes";
  }
}

// ═══════════════════════════════════════════════════════════
//  FILTER + SORT + RENDER PIPELINE
// ═══════════════════════════════════════════════════════════

function applyFilters() {
  let data = [...state.words];

  // Sort
  if (state.sort === "newest") {
    data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (state.sort === "oldest") {
    data.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (state.sort === "az") {
    data.sort((a, b) => a.displayWord.localeCompare(b.displayWord));
  }

  // Search filter
  if (state.query) {
    const q = state.query.toLowerCase();
    data = data.filter(w =>
      w.displayWord.toLowerCase().includes(q) ||
      w.entries.some(e => e.def.toLowerCase().includes(q) || (e.ex || "").toLowerCase().includes(q))
    );
  }

  state.filtered = data;
  updateStats();
  render();
}

function updateStats() {
  const totalDefs = state.words.reduce((n, w) => n + w.entries.length, 0);
  statWords.textContent = state.words.length;
  statDefs.textContent  = totalDefs;
  statShown.textContent = state.filtered.length;
}

// ── Highlight search term inside text ───────────────────────
function highlight(text, query) {
  if (!query) return escHtml(text);
  const safe  = escHtml(text);
  const safeQ = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${safeQ})`, "gi"), "<mark>$1</mark>");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════

function render() {
  if (state.view === "table") renderTable();
  else renderCards();
}

// ── Table ────────────────────────────────────────────────────
function renderTable() {
  if (!state.filtered.length) {
    tableBody.innerHTML = `
      <tr><td colspan="3">
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <p>${state.query ? "No matches found." : "No words yet. Add your first one above."}</p>
        </div>
      </td></tr>`;
    return;
  }

  tableBody.innerHTML = state.filtered.map(w => `
    <tr>
      <td class="word-cell">
        <span class="word-text">${highlight(w.displayWord, state.query)}</span>
        ${w.entries.length > 1
          ? `<span class="entry-count-badge">${w.entries.length}</span>`
          : ""}
      </td>
      <td class="def-cell">
        ${w.entries.map((e, i) => `
          <div class="entry-block" data-entry-id="${escHtml(e.id)}">
            ${w.entries.length > 1
              ? `<div class="entry-num">Def. ${i + 1}</div>`
              : ""}
            <div class="entry-def">${highlight(e.def, state.query)}</div>
            ${e.ex
              ? `<div class="entry-ex">${highlight(e.ex, state.query)}</div>`
              : ""}
          </div>
        `).join("")}
      </td>
      <td class="actions-cell">
        <button class="btn btn-icon speak"  onclick="speak('${escHtml(w.displayWord)}')"               title="Pronounce">🔊</button>
        <button class="btn btn-icon prompt" onclick="copyPrompt('${escHtml(w.displayWord)}')"          title="Copy AI prompt">🧠</button>
        <button class="btn btn-icon edit"   onclick="openEditModal('${w.id}','${w.entries[0].id}')"    title="Edit first definition">✏️</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${w.id}')"                            title="Delete word">🗑</button>
      </td>
    </tr>
  `).join("");
}

// ── Cards ────────────────────────────────────────────────────
function renderCards() {
  if (!state.filtered.length) {
    cardsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📚</div>
        <p>${state.query ? "No matches found." : "No words yet. Add your first one above."}</p>
      </div>`;
    return;
  }

  cardsGrid.innerHTML = state.filtered.map(w => `
    <div class="vocab-card">
      <div class="card-header">
        <div class="card-word">${highlight(w.displayWord, state.query)}</div>
        <div class="card-date">${formatDate(w.createdAt)}</div>
      </div>
      <div class="card-entries">
        ${w.entries.map((e, i) => `
          <div class="card-entry">
            ${w.entries.length > 1
              ? `<div class="card-def-num">Definition ${i + 1}</div>`
              : ""}
            <div class="entry-def">${highlight(e.def, state.query)}</div>
            ${e.ex
              ? `<div class="entry-ex">${highlight(e.ex, state.query)}</div>`
              : ""}
          </div>
        `).join("")}
      </div>
      <div class="card-actions">
        <button class="btn btn-icon speak"  onclick="speak('${escHtml(w.displayWord)}')"               title="Pronounce">🔊</button>
        <button class="btn btn-icon prompt" onclick="copyPrompt('${escHtml(w.displayWord)}')"          title="Copy AI prompt">🧠</button>
        <button class="btn btn-icon edit"   onclick="openEditModal('${w.id}','${w.entries[0].id}')"    title="Edit">✏️</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${w.id}')"                            title="Delete">🗑</button>
      </div>
    </div>
  `).join("");
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.cancel();   // stop any current speech first
  speechSynthesis.speak(u);
}

function copyPrompt(word) {
  const p = `Give me the definition and a real MBA/business example of: "${word}"`;
  navigator.clipboard.writeText(p)
    .then(() => toast("Prompt copied to clipboard", "info"))
    .catch(() => toast("Copy failed", "error"));
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════

function toast(message, type = "info", duration = 3000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add("removing");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}

// ═══════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════

function openModal(el)  { el.classList.add("open"); }
function closeModal(el) { el.classList.remove("open"); }

// Close on backdrop click
[editModal, mergeModal].forEach(modal => {
  modal.addEventListener("click", e => {
    if (e.target === modal) closeModal(modal);
  });
});

// Edit modal actions
editSaveBtn.addEventListener("click", saveEdit);
editCancelBtn.addEventListener("click", () => closeModal(editModal));

// Merge modal actions
mergeConfirmBtn.addEventListener("click", async () => {
  closeModal(mergeModal);
  if (state.pendingMerge) {
    const { displayWord, def, ex } = state.pendingMerge;
    // Restore inputs so addWord() picks them up
    wordInput.value = displayWord;
    defInput.value  = def;
    exInput.value   = ex;
    state.pendingMerge = null;
    await addWord(true);   // forceAdd = true skips duplicate check
  }
});

mergeCancelBtn.addEventListener("click", () => {
  state.pendingMerge = null;
  closeModal(mergeModal);
});

// ═══════════════════════════════════════════════════════════
//  VIEW TOGGLE
// ═══════════════════════════════════════════════════════════

document.querySelectorAll(".vbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    state.view = view;

    document.querySelectorAll(".vbtn").forEach(b => b.classList.toggle("active", b === btn));

    tableViewWrapper.classList.toggle("hidden", view !== "table");
    cardsViewWrapper.classList.toggle("hidden", view !== "cards");

    render();
  });
});

// ═══════════════════════════════════════════════════════════
//  SEARCH + SORT
// ═══════════════════════════════════════════════════════════

searchInput.addEventListener("input", e => {
  state.query = e.target.value.trim();
  applyFilters();
});

sortSelect.addEventListener("change", e => {
  state.sort = e.target.value;
  applyFilters();
});

// ═══════════════════════════════════════════════════════════
//  ADD BUTTON + ENTER KEY
// ═══════════════════════════════════════════════════════════

addBtn.addEventListener("click", () => addWord());

[wordInput, defInput, exInput].forEach(input => {
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") addWord();
  });
});

// ═══════════════════════════════════════════════════════════
//  CSV EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════

exportBtn.addEventListener("click", () => {
  if (!state.words.length) { toast("Nothing to export", "warning"); return; }

  const rows = [["Word", "Definition", "Example", "Created"]];
  state.words.forEach(w => {
    w.entries.forEach(e => {
      rows.push([
        csvCell(w.displayWord),
        csvCell(e.def),
        csvCell(e.ex || ""),
        csvCell(w.createdAt),
      ]);
    });
  });

  const csv  = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `mba-vocab-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV exported", "success");
});

importBtn.addEventListener("click", () => csvFileInput.click());

csvFileInput.addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  const text  = await file.text();
  const lines = text.trim().split("\n").slice(1); // skip header row
  let imported = 0;

  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (!cols[0] || !cols[1]) continue;

    try {
      const result = await api("ADD", {
        displayWord: cols[0].trim(),
        def:         cols[1].trim(),
        ex:          (cols[2] || "").trim(),
      });
      const idx = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) state.words[idx] = result;
      else state.words.unshift(result);
      imported++;
    } catch {
      // skip failed rows silently; they can try again
    }
  }

  csvFileInput.value = "";
  applyFilters();
  toast(`Imported ${imported} entry(s)`, "success");
});

function csvCell(val) {
  const s = String(val).replace(/"/g, '""');
  return /[,"\n]/.test(s) ? `"${s}"` : s;
}

function parseCsvLine(line) {
  // Simple CSV parser (handles quoted fields with commas)
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
//  ONLINE / OFFLINE STATUS
// ═══════════════════════════════════════════════════════════

function setStatus(type, label) {
  statusBadge.className = `status-badge ${type}`;
  statusLabel.textContent = label;
}

window.addEventListener("online", () => {
  setStatus("online", "Online");
  offlineBanner.classList.remove("visible");
  syncQueue();
});

window.addEventListener("offline", () => {
  setStatus("offline", "Offline");
  offlineBanner.classList.add("visible");
});

// ═══════════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION
// ═══════════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js")
    .catch(err => console.warn("SW registration failed:", err));
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

(function init() {
  // Set initial online/offline state
  if (!navigator.onLine) {
    setStatus("offline", "Offline");
    offlineBanner.classList.add("visible");
  }
  renderQueueBadge();
  fetchWords();
  syncQueue();
})();
