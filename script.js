/* ============================================================
   MBA Vocabulary — script.js
   ============================================================ */

"use strict";

// ── CONFIG ────────────────────────────────────────────────────
// ⚠️ Replace with your deployed Google Apps Script URL
const API_URL = window.APPS_SCRIPT_URL || "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";

const CACHE_KEY    = "vocab_words";
const QUEUE_KEY    = "vocab_queue";
const VIEW_KEY     = "vocab_view";

// ── STATE ─────────────────────────────────────────────────────
let state = {
  words:        [],
  queue:        [],          // offline add queue
  searchQuery:  "",
  sortMode:     "newest",
  viewMode:     "table",     // "table" | "cards"
  isOnline:     navigator.onLine,
  syncStatus:   "online",    // "online"|"offline"|"syncing"|"failed"
  expandedWords: new Set(),  // expanded definitions
  expandedText:  new Set(),  // expanded read-more text
  pendingDelete: null,       // { word, timer }
};

// ── NORMALIZE ─────────────────────────────────────────────────
function normalizeWord(w) {
  return String(w).trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizeDef(d) {
  return String(d).trim().toLowerCase().replace(/\s+/g, " ");
}

// ── CACHE ─────────────────────────────────────────────────────
function saveCache(words) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(words)); } catch(e) {}
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch(e) { return []; }
}
function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch(e) {}
}
function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch(e) { return []; }
}

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type = "info", duration = 3500, undoFn = null) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${msg}</span>`;
  if (undoFn) {
    const btn = document.createElement("button");
    btn.className = "toast-undo-btn";
    btn.textContent = "Undo";
    btn.onclick = () => { undoFn(); removeToast(toast); };
    toast.appendChild(btn);
  }
  container.appendChild(toast);
  const timer = setTimeout(() => removeToast(toast), duration);
  toast._timer = timer;
  return toast;
}

function removeToast(toast) {
  clearTimeout(toast._timer);
  toast.classList.add("removing");
  setTimeout(() => toast.remove(), 220);
}

// ── STATUS ────────────────────────────────────────────────────
function setStatus(s) {
  state.syncStatus = s;
  const badge = document.getElementById("statusBadge");
  const labels = { online:"Online", offline:"Offline", syncing:"Syncing…", failed:"Sync Failed" };
  badge.className = `status-badge ${s}`;
  badge.querySelector(".label").textContent = labels[s] || s;
}

function updateQueueBadge() {
  const el = document.getElementById("queueBadge");
  const n  = state.queue.length;
  el.textContent = `${n} queued`;
  el.classList.toggle("visible", n > 0);
}

function updateOfflineBanner() {
  document.getElementById("offlineBanner").classList.toggle("visible", !state.isOnline);
}

// ── API ───────────────────────────────────────────────────────
async function apiFetch(method, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(API_URL, opts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.status === "error") throw new Error(json.message || "Server error");
  return json.data;
}

async function apiGet()    { return apiFetch("GET"); }
async function apiPost(b)  { return apiFetch("POST", b); }

// ── FETCH WORDS ───────────────────────────────────────────────
async function fetchWords() {
  try {
    const data = await apiGet();
    state.words = data;
    saveCache(data);
    setStatus("online");
    render();
  } catch(e) {
    console.warn("Fetch failed, using cache", e);
    if (!state.words.length) state.words = loadCache();
    setStatus(state.isOnline ? "failed" : "offline");
    render();
    if (state.isOnline) showToast("Failed to load data from server. Showing cached.", "warning");
  }
}

// ── SYNC QUEUE ────────────────────────────────────────────────
async function syncQueue() {
  if (!state.isOnline || !state.queue.length) return;
  setStatus("syncing");

  const toSync = [...state.queue];
  state.queue  = [];
  saveQueue();
  updateQueueBadge();

  let failed = [];
  for (const item of toSync) {
    try {
      const normWord = normalizeWord(item.displayWord);
      const normDef  = normalizeDef(item.def);

      // Re-evaluate against state.words on every iteration.
      // Because state.words is updated after each successful call below,
      // items processed earlier in this loop are already visible here.
      const existing = state.words.find(w => w.word === normWord);
      if (existing) {
        const dupDef = existing.entries.some(e => normalizeDef(e.def) === normDef);
        if (dupDef) continue; // skip — already present in live local state
      }

      const result = await apiPost({ action: "ADD", displayWord: item.displayWord, def: item.def, ex: item.ex });

      // 🔥 FIX START
      // Update state.words immediately with the server's returned word object.
      // This ensures the next loop iteration sees the up-to-date entries array
      // for this word — preventing false "word not found" misses and duplicate
      // inserts when multiple offline items target the same word.
      const idx = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) {
        state.words[idx] = result;       // word existed — update with merged entries
      } else {
        state.words.unshift(result);     // new word — prepend so it's visible immediately
      }
      // 🔥 FIX END

    } catch(e) {
      failed.push(item);
    }
  }

  if (failed.length) {
    state.queue = [...state.queue, ...failed];
    saveQueue();
    updateQueueBadge();
    showToast(`${failed.length} item(s) failed to sync`, "error");
  }

  await fetchWords();
}

// ── ADD WORD ──────────────────────────────────────────────────
async function addWord(displayWord, def, ex) {
  const normWord = normalizeWord(displayWord);
  const normDef  = normalizeDef(def);

  if (!normWord || !normDef) {
    showToast("Word and definition are required", "error");
    return false;
  }

  const existing = state.words.find(w => w.word === normWord);

  // Duplicate definition check (optimistic)
  if (existing) {
    const isDup = existing.entries.some(e => normalizeDef(e.def) === normDef);
    if (isDup) { showToast("This definition already exists for this word", "warning"); return false; }
  }

  if (!state.isOnline) {
    // Queue for later
    const tempId = "temp_" + Date.now();
    state.queue.push({ tempId, displayWord, def, ex, queuedAt: new Date().toISOString() });
    saveQueue();
    updateQueueBadge();

    // Optimistic local add
    if (existing) {
      existing.entries.push({ def, ex: ex || "", id: tempId });
      existing.updatedAt = new Date().toISOString();
    } else {
      state.words.unshift({
        id: tempId, word: normWord, displayWord: displayWord.trim(),
        entries: [{ def, ex: ex || "", id: tempId }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    }
    saveCache(state.words);
    render();
    showToast("Saved offline — will sync when connected", "warning");
    return true;
  }

  // Existing word — ask user about merge
  if (existing) {
    const confirmed = await showMergeModal(displayWord.trim(), existing.entries.length);
    if (!confirmed) return false;
  }

  setStatus("syncing");
  try {
    const result = await apiPost({ action: "ADD", displayWord, def, ex });
    // Update local
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    else state.words.unshift(result);
    saveCache(state.words);
    render();
    setStatus("online");
    showToast(existing ? "Definition added to existing word ✓" : "Word added ✓", "success");
    return true;
  } catch(e) {
    setStatus("failed");
    showToast("Failed to save: " + e.message, "error");
    return false;
  }
}

// ── DELETE WORD ───────────────────────────────────────────────
function deleteWord(wordId) {
  if (!state.isOnline) { showToast("Delete requires an internet connection", "error"); return; }

  const word = state.words.find(w => w.id === wordId);
  if (!word) return;

  // Remove optimistically
  state.words = state.words.filter(w => w.id !== wordId);
  saveCache(state.words);
  render();

  // Undo timer
  let undone = false;
  const toast = showToast(`"${word.displayWord}" deleted`, "undo", 5500, () => {
    undone = true;
    state.words.unshift(word);
    sortWords();
    saveCache(state.words);
    render();
    showToast("Undo successful", "success");
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await apiPost({ action: "DELETE", wordId });
    } catch(e) {
      // Rollback
      state.words.unshift(word);
      sortWords();
      saveCache(state.words);
      render();
      showToast("Delete failed — word restored", "error");
    }
  }, 5500);
}

// ── UPDATE ENTRY ──────────────────────────────────────────────
async function updateEntry(wordId, entryId, def, ex) {
  if (!state.isOnline) { showToast("Edit requires an internet connection", "error"); return false; }
  setStatus("syncing");
  try {
    const result = await apiPost({ action: "UPDATE", wordId, entryId, def, ex });
    const idx = state.words.findIndex(w => w.id === wordId);
    if (idx >= 0) state.words[idx] = result;
    saveCache(state.words);
    render();
    setStatus("online");
    showToast("Definition updated ✓", "success");
    return true;
  } catch(e) {
    setStatus("failed");
    showToast("Update failed: " + e.message, "error");
    return false;
  }
}

// ── TTS ───────────────────────────────────────────────────────
function speak(text) {
  if (!("speechSynthesis" in window)) { showToast("TTS not supported in this browser", "error"); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = "en-US";
  utt.rate = 0.9;

  const voices = window.speechSynthesis.getVoices();
  const male   = voices.find(v =>
    v.lang.startsWith("en") &&
    /male|guy|daniel|david|mark|alex|fred|alex|thomas/i.test(v.name)
  );
  if (male) utt.voice = male;
  window.speechSynthesis.speak(utt);
}

// ── PROMPT COPY ───────────────────────────────────────────────
function copyPrompt(word) {
  const text = `Provide a clear, concise definition of the word "${word}" and one practical example, specifically in an MBA or business context. Use professional language and avoid generic explanations.`;
  navigator.clipboard.writeText(text)
    .then(() => showToast("Prompt copied to clipboard", "success"))
    .catch(() => showToast("Failed to copy prompt", "error"));
}

// ── CSV EXPORT ────────────────────────────────────────────────
function exportCSV() {
  const rows = [["Word", "Definition", "Example", "Created"]];
  state.words.forEach(w => {
    w.entries.forEach(e => {
      rows.push([
        `"${(w.displayWord||"").replace(/"/g,'""')}"`,
        `"${(e.def||"").replace(/"/g,'""')}"`,
        `"${(e.ex||"").replace(/"/g,'""')}"`,
        `"${w.createdAt||""}"`
      ]);
    });
  });
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "mba_vocabulary.csv";
  a.click(); URL.revokeObjectURL(url);
}

// ── CSV IMPORT ────────────────────────────────────────────────
function importCSV(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const lines  = e.target.result.split("\n").slice(1); // skip header
    let   added  = 0, skipped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const word = (cols[0]||"").replace(/^"|"$/g,"").trim();
      const def  = (cols[1]||"").replace(/^"|"$/g,"").trim();
      const ex   = (cols[2]||"").replace(/^"|"$/g,"").trim();
      if (word && def) {
        const ok = await addWord(word, def, ex);
        ok ? added++ : skipped++;
      }
    }
    showToast(`Import complete: ${added} added, ${skipped} skipped`, "success", 5000);
  };
  reader.readAsText(file);
}

function parseCSVLine(text) {
  const re = /("(?:[^"]|"")*"|[^,]*)/g;
  const cols = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) { re.lastIndex++; continue; }
    cols.push(m[1]);
  }
  return cols;
}

// ── SORT ──────────────────────────────────────────────────────
function sortWords() {
  const s = state.sortMode;
  state.words.sort((a, b) => {
    if (s === "newest") return new Date(b.createdAt) - new Date(a.createdAt);
    if (s === "oldest") return new Date(a.createdAt) - new Date(b.createdAt);
    if (s === "az")     return a.word.localeCompare(b.word);
    return 0;
  });
}

// ── SEARCH / FILTER ───────────────────────────────────────────
function filteredWords() {
  const q = state.searchQuery.toLowerCase().trim();
  if (!q) return state.words;
  return state.words.filter(w =>
    w.word.includes(q) ||
    (w.displayWord||"").toLowerCase().includes(q) ||
    w.entries.some(e => (e.def||"").toLowerCase().includes(q) || (e.ex||"").toLowerCase().includes(q))
  );
}

function highlight(text, q) {
  if (!q) return escHtml(text);
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escHtml(text).replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
}

function escHtml(s) {
  return String(s||"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

// ── TEXT COLLAPSE ─────────────────────────────────────────────
const TRUNC_LEN = 150;
function truncText(text, key) {
  if (!text || text.length <= TRUNC_LEN || state.expandedText.has(key)) return { text, hasMore: false };
  return { text: text.slice(0, TRUNC_LEN) + "…", hasMore: true };
}

function renderText(text, key, q, tag = "span") {
  const { text: t, hasMore } = truncText(text, key);
  const expanded = state.expandedText.has(key);
  const full     = text && text.length > TRUNC_LEN;
  let html = `<${tag} class="text-content">${highlight(t, q)}</${tag}>`;
  if (full) {
    html += `<button class="read-more-btn" onclick="toggleReadMore('${key}')">${expanded ? "Read less" : "Read more"}</button>`;
  }
  return html;
}

function toggleReadMore(key) {
  if (state.expandedText.has(key)) state.expandedText.delete(key);
  else state.expandedText.add(key);
  render();
}

// ── ENTRIES EXPAND ────────────────────────────────────────────
function toggleExpand(wordId) {
  if (state.expandedWords.has(wordId)) state.expandedWords.delete(wordId);
  else state.expandedWords.add(wordId);
  render();
}

// ── EDIT MODAL ────────────────────────────────────────────────
let activeEditId = null;

function openEditModal(wordId, entryId, currentDef, currentEx) {
  const modal = document.getElementById("editModal");
  document.getElementById("editWordId").value  = wordId;
  document.getElementById("editEntryId").value = entryId;
  document.getElementById("editDef").value = currentDef;
  document.getElementById("editEx").value  = currentEx;
  modal.classList.add("open");
  document.getElementById("editDef").focus();
}

function closeEditModal() {
  document.getElementById("editModal").classList.remove("open");
}

async function submitEdit() {
  const wordId  = document.getElementById("editWordId").value;
  const entryId = document.getElementById("editEntryId").value;
  const def     = document.getElementById("editDef").value.trim();
  const ex      = document.getElementById("editEx").value.trim();
  if (!def) { showToast("Definition cannot be empty", "error"); return; }
  const ok = await updateEntry(wordId, entryId, def, ex);
  if (ok) closeEditModal();
}

// ── MERGE MODAL ───────────────────────────────────────────────
function showMergeModal(word, existingCount) {
  return new Promise(resolve => {
    const modal = document.getElementById("mergeModal");
    document.getElementById("mergeWord").textContent      = word;
    document.getElementById("mergeDefCount").textContent  = existingCount;
    modal.classList.add("open");

    document.getElementById("mergeCancelBtn").onclick = () => {
      modal.classList.remove("open");
      resolve(false);
    };
    document.getElementById("mergeConfirmBtn").onclick = () => {
      modal.classList.remove("open");
      resolve(true);
    };
  });
}

// ── FORMAT DATE ───────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
  } catch(e) { return ""; }
}

// ── RENDER ENTRIES ─────────────────────────────────────────────
function renderEntries(word, q) {
  const { id: wordId, entries = [] } = word;
  const expanded = state.expandedWords.has(wordId);
  const toShow   = expanded ? entries : entries.slice(0, 1);

  let html = "";
  toShow.forEach((e, i) => {
    const defKey = `${wordId}_${e.id}_def`;
    const exKey  = `${wordId}_${e.id}_ex`;
    html += `<div class="entry-block">
      <div class="def-text">${renderText(e.def, defKey, q)}</div>
      ${e.ex ? `<div class="ex-text">${renderText(e.ex, exKey, q, "span")}</div>` : ""}
    </div>`;
  });

  if (entries.length > 1) {
    html += `<button class="show-more-btn" onclick="toggleExpand('${wordId}')">
      ${expanded ? "Show less" : `+${entries.length - 1} more definition${entries.length > 2 ? "s" : ""}`}
    </button>`;
  }

  return html;
}

function renderActionBtns(word) {
  const { id, displayWord, entries } = word;
  const firstEntry = entries[0] || {};
  return `
    <button class="btn btn-icon edit"   title="Edit"   onclick="openEditModal('${id}','${escHtml(firstEntry.id)}',${JSON.stringify(escHtml(firstEntry.def||""))},${JSON.stringify(escHtml(firstEntry.ex||""))})">✏️ Edit</button>
    <button class="btn btn-icon delete" title="Delete" onclick="deleteWord('${id}')">🗑 Delete</button>
    <button class="btn btn-icon speak"  title="Speak"  onclick="speak('${escHtml(displayWord)}')">🔊 Speak</button>
    <button class="btn btn-icon prompt" title="Copy Prompt" onclick="copyPrompt('${escHtml(displayWord)}')">🧠 Prompt</button>
  `;
}

// ── RENDER TABLE ──────────────────────────────────────────────
function renderTable(words, q) {
  const tbody = document.getElementById("tableBody");
  if (!words.length) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div class="empty-icon">📚</div><p>${q ? "No matches found" : "No words yet — add one above"}</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = words.map(w => `
    <tr>
      <td class="word-cell">
        <span class="word-text">${highlight(w.displayWord, q)}</span>
        ${w.entries.length > 1 ? `<span class="entry-count-badge">${w.entries.length}</span>` : ""}
        <div class="word-date">${fmtDate(w.createdAt)}</div>
      </td>
      <td>${renderEntries(w, q)}</td>
      <td class="actions-cell">${renderActionBtns(w)}</td>
    </tr>
  `).join("");
}

// ── RENDER CARDS ──────────────────────────────────────────────
function renderCards(words, q) {
  const grid = document.getElementById("cardsGrid");
  if (!words.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><p>${q ? "No matches found" : "No words yet — add one above"}</p></div>`;
    return;
  }
  grid.innerHTML = words.map(w => {
    const expanded = state.expandedWords.has(w.id);
    const toShow   = expanded ? w.entries : w.entries.slice(0, 1);

    const entriesHtml = toShow.map((e, i) => {
      const defKey = `${w.id}_${e.id}_def`;
      const exKey  = `${w.id}_${e.id}_ex`;
      return `<div class="card-entry">
        ${w.entries.length > 1 ? `<div class="card-def-num">Definition ${i+1}</div>` : ""}
        <div class="def-text">${renderText(e.def, defKey, q)}</div>
        ${e.ex ? `<div class="ex-text">${renderText(e.ex, exKey, q, "span")}</div>` : ""}
      </div>`;
    }).join("");

    const showMoreBtn = w.entries.length > 1
      ? `<button class="show-more-btn" onclick="toggleExpand('${w.id}')">${expanded ? "Show less" : `+${w.entries.length - 1} more`}</button>`
      : "";

    return `<div class="vocab-card">
      <div class="card-header">
        <div class="card-word">${highlight(w.displayWord, q)}</div>
        <div class="card-date">${fmtDate(w.createdAt)}</div>
      </div>
      <div class="card-entries">${entriesHtml}${showMoreBtn}</div>
      <div class="card-actions">${renderActionBtns(w)}</div>
    </div>`;
  }).join("");
}

// ── RENDER STATS ──────────────────────────────────────────────
function renderStats(filtered) {
  const totalDefs = state.words.reduce((n, w) => n + w.entries.length, 0);
  document.getElementById("statWords").textContent = state.words.length;
  document.getElementById("statDefs").textContent  = totalDefs;
  document.getElementById("statShown").textContent = filtered.length;
}

// ── MAIN RENDER ───────────────────────────────────────────────
function render() {
  sortWords();
  const words = filteredWords();
  const q     = state.searchQuery.trim().toLowerCase();
  renderStats(words);

  const tableWrap = document.getElementById("tableViewWrapper");
  const cardsWrap = document.getElementById("cardsViewWrapper");
  const isMobile  = window.innerWidth <= 700;

  const effectiveView = isMobile ? "cards" : state.viewMode;

  tableWrap.classList.toggle("hidden", effectiveView !== "table");
  cardsWrap.classList.toggle("hidden", effectiveView !== "cards");

  // Update toggle buttons
  document.querySelectorAll(".vbtn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === effectiveView)
  );

  if (effectiveView === "table") renderTable(words, q);
  else renderCards(words, q);
}

// ── INPUT HANDLING ────────────────────────────────────────────
let searchTimer = null;

function initInputs() {
  const wordInput = document.getElementById("wordInput");
  const defInput  = document.getElementById("defInput");
  const exInput   = document.getElementById("exInput");
  const addBtn    = document.getElementById("addBtn");
  const searchInput = document.getElementById("searchInput");

  async function doAdd() {
    const w = wordInput.value.trim();
    const d = defInput.value.trim();
    const e = exInput.value.trim();
    if (!w || !d) {
      showToast("Please fill in Word and Definition", "error");
      if (!w) wordInput.focus();
      else defInput.focus();
      return;
    }
    addBtn.disabled = true;
    addBtn.innerHTML = `<span class="spinner"></span> Adding…`;
    const ok = await addWord(w, d, e);
    addBtn.disabled = false;
    addBtn.innerHTML = `Add Word`;
    if (ok) {
      wordInput.value = "";
      defInput.value  = "";
      exInput.value   = "";
      wordInput.focus();
    }
  }

  addBtn.addEventListener("click", doAdd);

  [wordInput, defInput, exInput].forEach(el => {
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); doAdd(); }
    });
  });

  searchInput.addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.searchQuery = e.target.value;
      render();
    }, 300);
  });

  document.getElementById("sortSelect").addEventListener("change", e => {
    state.sortMode = e.target.value;
    render();
  });

  document.querySelectorAll(".vbtn").forEach(b => {
    b.addEventListener("click", () => {
      state.viewMode = b.dataset.view;
      localStorage.setItem(VIEW_KEY, state.viewMode);
      render();
    });
  });

  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("importBtn").addEventListener("click", () =>
    document.getElementById("csvFileInput").click()
  );
  document.getElementById("csvFileInput").addEventListener("change", e => {
    if (e.target.files[0]) { importCSV(e.target.files[0]); e.target.value = ""; }
  });

  // Edit modal buttons
  document.getElementById("editSaveBtn").addEventListener("click", submitEdit);
  document.getElementById("editCancelBtn").addEventListener("click", closeEditModal);
  document.getElementById("editModal").addEventListener("click", e => {
    if (e.target.id === "editModal") closeEditModal();
  });
  document.getElementById("editDef").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.ctrlKey) submitEdit();
  });

  // Merge modal
  document.getElementById("mergeModal").addEventListener("click", e => {
    if (e.target.id === "mergeModal") {
      document.getElementById("mergeCancelBtn").click();
    }
  });
}

// ── ONLINE/OFFLINE ────────────────────────────────────────────
function initNetwork() {
  window.addEventListener("online", () => {
    state.isOnline = true;
    setStatus("online");
    updateOfflineBanner();
    showToast("Back online — syncing…", "success");
    syncQueue().then(() => fetchWords());
  });

  window.addEventListener("offline", () => {
    state.isOnline = false;
    setStatus("offline");
    updateOfflineBanner();
    showToast("You're offline — changes will sync later", "warning");
  });
}

// ── SERVICE WORKER ────────────────────────────────────────────
function initSW() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js")
        .then(reg => console.log("SW registered", reg.scope))
        .catch(e  => console.warn("SW failed", e));
    });
  }
}

// ── VOICES PRELOAD ────────────────────────────────────────────
function preloadVoices() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", () =>
      window.speechSynthesis.getVoices()
    );
  }
}

// ── BOOT ──────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Load saved view preference
  const savedView = localStorage.getItem(VIEW_KEY);
  if (savedView) state.viewMode = savedView;

  // Load offline queue
  state.queue = loadQueue();

  // Load from cache immediately for instant display
  state.words = loadCache();

  initInputs();
  initNetwork();
  initSW();
  preloadVoices();

  setStatus(state.isOnline ? "online" : "offline");
  updateOfflineBanner();
  updateQueueBadge();

  // Render cached data instantly
  if (state.words.length) render();

  // Then fetch fresh from server
  if (state.isOnline) {
    fetchWords().then(() => {
      if (state.queue.length) syncQueue();
    });
  } else {
    render();
  }
});

// Expose globals needed by inline event handlers
window.toggleReadMore = toggleReadMore;
window.toggleExpand   = toggleExpand;
window.openEditModal  = openEditModal;
window.deleteWord     = deleteWord;
window.speak          = speak;
window.copyPrompt     = copyPrompt;
