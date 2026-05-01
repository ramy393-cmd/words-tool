"use strict";

// ═══════════════════════════════════════════════════════════
//  MBA Vocabulary — script.js  (v3.0 — offline-first)
// ═══════════════════════════════════════════════════════════

const API = window.APPS_SCRIPT_URL;

// ── [NEW] ENVIRONMENT DETECTION ──────────────────────────────────────────────
const ENV = (() => {
  const proto = location.protocol;
  return {
    isFile:      proto === "file:",
    isLocalhost: proto === "http:" && (location.hostname === "localhost" || location.hostname === "127.0.0.1"),
    isHttps:     proto === "https:",
  };
})();

// ── [NEW] DEBUG LOGGER ────────────────────────────────────────────────────────
const LOG_PREFIX = "[VocabPWA]";
function dbg(...args) { console.log(LOG_PREFIX, ...args); }

dbg("Environment →", ENV);

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

let state = {
  words:        [],
  // [NEW] localWords: full word objects persisted in localStorage
  localWords:   JSON.parse(localStorage.getItem("localWords") || "[]"),
  // legacy queue kept for backward compatibility; local-first supersedes it
  queue:        JSON.parse(localStorage.getItem("queue") || "[]"),
  // [NEW] isOfflineMode: true when file://, or navigator is offline, or API unreachable
  isOfflineMode: ENV.isFile || !navigator.onLine,
  editMode:     false,
  editWordId:   null,
  editEntryId:  null,
  search:       "",
  sort:         "newest",
  view:         "table",
  expandedCells: {},
  expandedDefs:  {},
};

if (ENV.isFile) dbg("Running in offline mode (file://)");

// ═══════════════════════════════════════════════════════════
//  [NEW] LOCAL WORDS PERSISTENCE
//  Full word structure stored in localStorage so the UI can
//  always render, even with no network at all.
// ═══════════════════════════════════════════════════════════

function saveLocalWords() {
  localStorage.setItem("localWords", JSON.stringify(state.localWords));
  updateQueueBadge();
}

/** Merge a word object into state.localWords (same logic as mergeResultIntoState). */
function mergeIntoLocalWords(word) {
  const byId = state.localWords.findIndex(w => w.id === word.id);
  if (byId >= 0) { state.localWords[byId] = word; return; }
  const byName = state.localWords.findIndex(
    w => normalizeWord(w.displayWord) === normalizeWord(word.displayWord)
  );
  if (byName >= 0) { state.localWords[byName] = word; return; }
  state.localWords.unshift(word);
}

/** [NEW] Build a temporary local word object when offline. */
function buildLocalWord(displayWord, def, ex) {
  const id      = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const entryId = id + "_e0";
  return {
    id,
    displayWord,
    entries: [{ id: entryId, def, ex: ex || "" }],
    createdAt: new Date().toISOString(),
    _local: true,  // marker so sync knows it needs uploading
  };
}

/** [NEW] Add a new definition to an existing local word. */
function addLocalDefinition(existingWord, def, ex) {
  const word  = state.localWords.find(w => w.id === existingWord.id);
  if (!word) return;
  const entryId = word.id + "_e" + Date.now();
  word.entries.push({ id: entryId, def, ex: ex || "" });
  word._local = true;
  saveLocalWords();
}

// ═══════════════════════════════════════════════════════════
//  QUEUE PERSISTENCE  (kept for legacy sync compat)
// ═══════════════════════════════════════════════════════════

function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
  updateQueueBadge();
}

function updateQueueBadge() {
  const badge = document.getElementById("queueBadge");
  if (!badge) return;
  // [UPDATED] Show local-unsynced count + legacy queue count
  const localUnsyncedCount = state.localWords.filter(w => w._local).length;
  const total = state.queue.length + localUnsyncedCount;
  if (total > 0) {
    badge.textContent = total + " unsynced";
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
//  [NEW] ONLINE / OFFLINE STATUS  (with API reachability check)
// ═══════════════════════════════════════════════════════════

function setOfflineMode(isOffline) {
  state.isOfflineMode = isOffline;
  const badge  = document.getElementById("statusBadge");
  const banner = document.getElementById("offlineBanner");
  if (!badge) return;
  if (isOffline) {
    badge.className = "status-badge offline";
    badge.querySelector(".label").textContent = "Offline";
    if (banner) banner.classList.add("visible");
  } else {
    badge.className = "status-badge online";
    badge.querySelector(".label").textContent = "Online";
    if (banner) banner.classList.remove("visible");
  }
  updateQueueBadge();
}

async function updateOnlineStatus() {
  const badge  = document.getElementById("statusBadge");
  const banner = document.getElementById("offlineBanner");

  // file:// always offline
  if (ENV.isFile) {
    setOfflineMode(true);
    dbg("Running in offline mode");
    return;
  }

  if (!navigator.onLine) {
    setOfflineMode(true);
    dbg("Running in offline mode (navigator.onLine = false)");
    return;
  }

  // [NEW] Probe API reachability with a lightweight ping
  if (API) {
    try {
      const params = new URLSearchParams({ action: "PING", t: Date.now() });
      const res = await fetch(API + "?" + params, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      setOfflineMode(false);
      // Trigger sync on every transition to online
      syncLocalToServer();
    } catch {
      dbg("API unreachable — forcing offline mode");
      setOfflineMode(true);
    }
  } else {
    // No API configured — always offline
    setOfflineMode(true);
    dbg("Running in offline mode (no API configured)");
  }
}

window.addEventListener("online",  () => { dbg("Browser online event"); updateOnlineStatus(); });
window.addEventListener("offline", () => { dbg("Browser offline event"); setOfflineMode(true); });

// ═══════════════════════════════════════════════════════════
//  API  (GET-tunneling)
// ═══════════════════════════════════════════════════════════

async function api(action, payload = {}) {
  if (!API) throw new Error("No API configured");
  const params = new URLSearchParams({
    action:  action.toUpperCase(),
    payload: JSON.stringify(payload),
    t:       Date.now(),
  });
  const url = API + "?" + params.toString();
  const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error");
  return json.data;
}

// ═══════════════════════════════════════════════════════════
//  WORD NORMALIZATION
//  IMPORTANT: Must match the normalization in Code.gs (backend)
//  Backend should use: word.trim().toLowerCase().replace(/\s+/g, " ")
// ═══════════════════════════════════════════════════════════

function normalizeWord(word) {
  return String(word).trim().toLowerCase().replace(/\s+/g, " ");
}

// ═══════════════════════════════════════════════════════════
//  FETCH (with localWords fallback)
// ═══════════════════════════════════════════════════════════

async function fetchWords() {
  // [NEW] If offline mode, render from localWords immediately
  if (state.isOfflineMode) {
    dbg("Offline mode: rendering from localWords");
    if (state.localWords.length > 0) {
      state.words = [...state.localWords];
      render();
      updateStats();
    } else {
      // Show empty state rather than stuck spinner
      const tbody = document.getElementById("tableBody");
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div class="empty-icon">📖</div><p>No words yet. Add your first one above.</p></div></td></tr>`;
      }
    }
    return;
  }

  try {
    const data = await api("GET");
    const seen = new Map();
    data.reverse().forEach(w => {
      const key = normalizeWord(w.displayWord);
      if (!seen.has(key)) {
        seen.set(key, w);
      } else {
        const existing = seen.get(key);
        if ((w.entries || []).length > (existing.entries || []).length) {
          seen.set(key, w);
        }
      }
    });
    state.words = Array.from(seen.values());

    // [NEW] Merge server words into localWords so local cache stays fresh
    state.words.forEach(w => mergeIntoLocalWords({ ...w, _local: false }));
    saveLocalWords();

    render();
    updateStats();
  } catch (err) {
    console.error("Fetch failed:", err);
    dbg("Fetch failed, falling back to localWords");
    // [NEW] Fallback: render from localWords instead of showing error
    if (state.localWords.length > 0) {
      state.words = [...state.localWords];
      render();
      updateStats();
      toast("Offline — showing cached data.", "warning");
    } else {
      document.getElementById("tableBody").innerHTML =
        `<tr><td colspan="3" class="error-cell">Failed to load. Check your connection.</td></tr>`;
      toast("Failed to load words. Check your connection.", "error");
    }
    // Force offline mode so subsequent adds go local
    state.isOfflineMode = true;
  }
}

// ═══════════════════════════════════════════════════════════
//  MERGE HELPER
// ═══════════════════════════════════════════════════════════

function mergeResultIntoState(result) {
  const byId = state.words.findIndex(w => w.id === result.id);
  if (byId >= 0) { state.words[byId] = result; return; }
  const byName = state.words.findIndex(
    w => normalizeWord(w.displayWord) === normalizeWord(result.displayWord)
  );
  if (byName >= 0) { state.words[byName] = result; return; }
  state.words.unshift(result);
}

// ═══════════════════════════════════════════════════════════
//  [NEW] SYNC ENGINE — syncLocalToServer()
//  Pushes all _local:true words from localWords to the server.
//  Runs after coming back online. Handles partial failures,
//  retries implicitly on next online event. No duplicates.
// ═══════════════════════════════════════════════════════════

async function syncLocalToServer() {
  const localDirty = state.localWords.filter(w => w._local);
  const hasQueue   = state.queue.length > 0;

  if (!localDirty.length && !hasQueue) return;
  if (!navigator.onLine || state.isOfflineMode) return;

  dbg("Sync started — localDirty:", localDirty.length, "queue:", state.queue.length);

  const badge = document.getElementById("statusBadge");
  if (badge) { badge.className = "status-badge syncing"; badge.querySelector(".label").textContent = "Syncing…"; }

  let syncedCount = 0;
  let failedCount = 0;

  // 1. Sync local-first words (full word objects)
  for (const localWord of localDirty) {
    for (const entry of localWord.entries) {
      try {
        const result = await api("ADD", {
          displayWord: localWord.displayWord,
          def: entry.def,
          ex:  entry.ex || "",
        });
        mergeResultIntoState(result);
        // Update localWords with server version (replace local id with real id)
        const idx = state.localWords.findIndex(w => w.id === localWord.id);
        if (idx >= 0) {
          state.localWords[idx] = { ...result, _local: false };
        }
        syncedCount++;
      } catch (err) {
        dbg("Sync failed for word:", localWord.displayWord, err.message);
        failedCount++;
      }
    }
  }

  // 2. Sync legacy queue items
  const pending   = [...state.queue];
  state.queue     = [];
  for (const item of pending) {
    try {
      const result = await api("ADD", item);
      mergeResultIntoState(result);
      syncedCount++;
    } catch {
      state.queue.push(item);
      failedCount++;
    }
  }

  saveLocalWords();
  saveQueue();

  if (badge) { badge.className = "status-badge online"; badge.querySelector(".label").textContent = "Online"; }

  if (failedCount === 0) {
    dbg("Sync success — synced:", syncedCount);
    if (syncedCount > 0) toast(`Synced ${syncedCount} item(s) to server.`, "success");
  } else {
    dbg("Sync failed (partial) — synced:", syncedCount, "failed:", failedCount);
    toast(`Synced ${syncedCount}, ${failedCount} still pending.`, "warning");
  }

  // After sync: refresh from server to get canonical IDs
  if (syncedCount > 0 && !failedCount) {
    await fetchWords();
  } else {
    render();
    updateStats();
  }
}

// ═══════════════════════════════════════════════════════════
//  GENERATE PROMPT
// ═══════════════════════════════════════════════════════════

async function generatePrompt() {
  const wordEl = document.getElementById("wordInput");
  const word   = wordEl.value.trim();
  if (!word) { toast("Enter a word first, then click Generate Prompt.", "warning"); wordEl.focus(); return; }
  const prompt = `Give me a clear MBA/business definition and one practical example for the term: ${word}. Format: definition -- example`;
  try {
    await navigator.clipboard.writeText(prompt);
    toast("Prompt copied. Paste into ChatGPT.", "success");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = prompt;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand("copy"); toast("Prompt copied. Paste into ChatGPT.", "success"); }
    catch (_2) { toast("Copy failed. Please copy manually: " + prompt, "warning", 6000); }
    document.body.removeChild(ta);
  }
}

// ═══════════════════════════════════════════════════════════
//  ADD  — [UPDATED] Always succeeds locally; syncs when online
// ═══════════════════════════════════════════════════════════

async function addWord() {
  const wordEl = document.getElementById("wordInput");
  const defEl  = document.getElementById("defInput");
  const exEl   = document.getElementById("exInput");
  const addBtn = document.getElementById("addBtn");

  const word = wordEl.value.trim();
  const def  = defEl.value.trim();
  const ex   = exEl.value.trim();

  if (!word || !def) { toast("Please fill in Word and Definition.", "warning"); return; }
  if (state.editMode) { await updateWord(word, def, ex); return; }

  const normalized = normalizeWord(word);
  const existing   = state.words.find(w => normalizeWord(w.displayWord) === normalized);
  if (existing) { openMergeModal(existing, word, def, ex); return; }

  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  // [NEW] ALWAYS update local state immediately (no blocking on network)
  const localWord = buildLocalWord(word, def, ex);
  mergeIntoLocalWords(localWord);
  mergeResultIntoState(localWord);
  saveLocalWords();

  wordEl.value = defEl.value = exEl.value = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  render();
  updateStats();

  // [NEW] Attempt network sync in background (non-blocking)
  if (!state.isOfflineMode) {
    _pushWordToServer(localWord, word, def, ex);
  } else {
    dbg("Offline — word saved locally, will sync later");
    toast("Saved locally. Will sync when online.", "warning");
  }
}

/** [NEW] Push a single word+entry to server, replace local placeholder if success. */
async function _pushWordToServer(localWord, displayWord, def, ex) {
  try {
    const result = await api("ADD", { displayWord, def, ex });
    // Replace local placeholder with server result
    mergeResultIntoState(result);
    const idx = state.localWords.findIndex(w => w.id === localWord.id);
    if (idx >= 0) state.localWords[idx] = { ...result, _local: false };
    saveLocalWords();
    render();
    updateStats();
    toast("Word added!", "success");
  } catch (err) {
    dbg("Push to server failed:", err.message, "— will retry on next sync");
    toast("Saved locally. Will sync when online.", "warning");
    // Already in localWords with _local:true, will sync later
  }
}

// ─── Merge Modal ──────────────────────────────────────────

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
  const { existingWord, displayWord, def, ex } = _pendingMerge;
  _pendingMerge = null;

  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  // [NEW] Always update locally first
  addLocalDefinition(existingWord, def, ex);
  // Also update state.words for immediate UI
  const stateWord = state.words.find(w => w.id === existingWord.id);
  if (stateWord) {
    const entryId = existingWord.id + "_e" + Date.now();
    stateWord.entries.push({ id: entryId, def, ex: ex || "" });
  }

  document.getElementById("wordInput").value = "";
  document.getElementById("defInput").value  = "";
  document.getElementById("exInput").value   = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  render();
  updateStats();

  if (!state.isOfflineMode) {
    try {
      const result = await api("ADD", { displayWord, def, ex });
      mergeResultIntoState(result);
      // Update localWords with authoritative server version
      const idx = state.localWords.findIndex(w => normalizeWord(w.displayWord) === normalizeWord(displayWord));
      if (idx >= 0) state.localWords[idx] = { ...result, _local: false };
      saveLocalWords();
      render();
      updateStats();
      toast("Definition added!", "success");
    } catch (err) {
      dbg("Merge push failed:", err.message);
      toast("Saved locally. Will sync when online.", "warning");
    }
  } else {
    toast("Saved locally. Will sync when online.", "warning");
  }
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
  if (!def) { toast("Definition cannot be empty.", "warning"); return; }

  const saveBtn = document.getElementById("editSaveBtn");
  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving…";

  // [NEW] Update locally first
  const localWord = state.localWords.find(w => w.id === wordId);
  if (localWord) {
    const entry = localWord.entries.find(e => e.id === entryId);
    if (entry) { entry.def = def; entry.ex = ex; }
    localWord._local = true;
    saveLocalWords();
  }
  // Update state.words immediately for UI
  const stateWord = state.words.find(w => w.id === wordId);
  if (stateWord) {
    const entry = stateWord.entries.find(e => e.id === entryId);
    if (entry) { entry.def = def; entry.ex = ex; }
  }
  closeEditModal();
  render();
  updateStats();

  if (!state.isOfflineMode) {
    try {
      const result = await api("UPDATE", { id: wordId, entryId, def, ex });
      const idx = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) state.words[idx] = result;
      const lidx = state.localWords.findIndex(w => w.id === result.id);
      if (lidx >= 0) state.localWords[lidx] = { ...result, _local: false };
      saveLocalWords();
      render();
      updateStats();
      toast("Updated!", "success");
    } catch (err) {
      console.error("Update failed:", err);
      toast("Saved locally. Will sync when online.", "warning");
    }
  } else {
    toast("Saved locally. Will sync when online.", "warning");
  }

  saveBtn.disabled    = false;
  saveBtn.textContent = "Save Changes";
}

// ─── Legacy inline edit (startEdit) — kept for backward compat ─
function startEdit(wordId, entryId) { openEditModal(wordId, entryId); }

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
    const result = await api("UPDATE", { id: state.editWordId, entryId: state.editEntryId, def, ex });
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

  // [NEW] Remove locally immediately
  state.words      = state.words.filter(w => String(w.id) !== String(id));
  state.localWords = state.localWords.filter(w => String(w.id) !== String(id));
  saveLocalWords();
  if (state.editWordId === id) cancelEdit();
  render();
  updateStats();
  toast("Word deleted.", "info");

  if (!state.isOfflineMode) {
    try {
      await api("DELETE", { id: String(id) });
    } catch (err) {
      console.error("Server delete failed (removed locally only):", err);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  [UPDATED] LEGACY syncQueue — now calls syncLocalToServer
// ═══════════════════════════════════════════════════════════

async function syncQueue() {
  await syncLocalToServer();
}

// ═══════════════════════════════════════════════════════════
//  SPEECH
// ═══════════════════════════════════════════════════════════

function speak(text) {
  if (!("speechSynthesis" in window)) { toast("Speech not supported in this browser.", "warning"); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = "en-US";
  speechSynthesis.speak(u);
}

// ═══════════════════════════════════════════════════════════
//  SEARCH + SORT + FILTER
// ═══════════════════════════════════════════════════════════

function getFilteredWords() {
  let words = [...state.words];
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
  if (state.sort === "oldest") {
    words = words.slice().reverse();
  } else if (state.sort === "az") {
    words = words.slice().sort((a, b) => a.displayWord.localeCompare(b.displayWord));
  }
  return words;
}

function highlight(text, query) {
  if (!query) return escHtml(text);
  const escaped = escHtml(text);
  const qEsc    = escHtml(query);
  const re = new RegExp("(" + qEsc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return escaped.replace(re, "<mark>$1</mark>");
}

// ═══════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════

function updateStats() {
  const filtered  = getFilteredWords();
  const totalDefs = state.words.reduce((s, w) => s + w.entries.length, 0);
  const el = (id) => document.getElementById(id);
  if (el("statWords"))  el("statWords").textContent  = state.words.length;
  if (el("statDefs"))   el("statDefs").textContent   = totalDefs;
  if (el("statShown"))  el("statShown").textContent  = filtered.length;
}

// ═══════════════════════════════════════════════════════════
//  READ-MORE (CLAMP) TOGGLE
// ═══════════════════════════════════════════════════════════

function toggleReadMore(btn) {
  const cell = btn.closest(".clamp-cell");
  if (!cell) return;
  const key      = cell.dataset.clampKey;
  const expanded = cell.classList.toggle("expanded");
  btn.textContent = expanded ? "Show less ▲" : "Read more ▼";
  if (key) {
    if (expanded) state.expandedCells[key] = true;
    else delete state.expandedCells[key];
  }
}

// ═══════════════════════════════════════════════════════════
//  OVERFLOW DETECTION
// ═══════════════════════════════════════════════════════════

function detectOverflow() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".clamp-cell").forEach(cell => {
      const text = cell.querySelector(".clamp-text");
      const btn  = cell.querySelector(".read-more-btn");
      if (!text || !btn) return;
      if (cell.classList.contains("expanded")) { btn.style.display = "inline-block"; return; }
      btn.style.display = text.scrollWidth > text.clientWidth + 1 ? "inline-block" : "none";
    });
  });
}

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
  const row = document.querySelector(`tr[data-word-id="${wordId}"]`);
  if (!row) { render(); return; }
  const defCell = row.querySelector(".def-cell");
  if (!defCell) return;
  const word = state.words.find(w => w.id === wordId);
  if (!word) return;
  defCell.innerHTML = buildDefCellHtml(word, state.search);
  restoreExpandedCells();
  detectOverflow();
}

// ═══════════════════════════════════════════════════════════
//  BUILD TABLE HTML HELPERS
// ═══════════════════════════════════════════════════════════

function buildDefCellHtml(w, q) {
  const allEntries = Array.isArray(w.entries) && w.entries.length > 0
    ? w.entries
    : [{ id: w.id + "-0", def: w.def || "", ex: w.ex || "" }];

  const expanded = !!state.expandedDefs[w.id];
  const entries  = expanded ? allEntries : allEntries.slice(0, 1);
  const hasMore  = allEntries.length > 1;

  const entriesHtml = entries.map((e) => {
    const trueIndex = allEntries.indexOf(e);
    const defKey = `${w.id}-${e.id}-def`;
    const exKey  = `${w.id}-${e.id}-ex`;
    const labelHtml = allEntries.length > 1
      ? `<div class="entry-num">Def. ${trueIndex + 1}</div>`
      : "";
    const exHtml = (e.ex && e.ex.trim())
      ? `<div class="clamp-cell" data-clamp-key="${escAttr(exKey)}">
           <div class="entry-ex clamp-text">${highlight(e.ex, q)}</div>
           <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
         </div>`
      : "";
    return `
    <div class="entry-block">
      ${labelHtml}
      <div class="entry-actions-row">
        <div class="clamp-cell" data-clamp-key="${escAttr(defKey)}">
          <div class="entry-def clamp-text">${highlight(e.def, q)}</div>
          <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
        </div>
        <button class="btn btn-icon edit entry-edit-btn"
          onclick="openEditModal('${escAttr(String(w.id))}','${escAttr(String(e.id))}')"
          title="Edit this definition">✏️</button>
      </div>
      ${exHtml}
    </div>`;
  }).join('<div class="entry-divider"></div>');

  const remaining = allEntries.length - 1;
  const moreBtn = hasMore
    ? `<button class="show-more-btn" onclick="toggleShowMoreDefs('${escAttr(String(w.id))}')">
         ${expanded ? "Collapse ▲" : `Show ${remaining} more definition${remaining > 1 ? "s" : ""}`}
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
        ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
      </td>
      <td class="def-cell">${buildDefCellHtml(w, q)}</td>
      <td class="actions-cell">
        <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Pronounce">🔊</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(w.id)}')" title="Delete word">🗑</button>
      </td>
    </tr>`;
}

// ── Card HTML ──────────────────────────────────────────────

function buildCardHtml(w, q) {
  const entriesHtml = w.entries.map((e, i) => {
    const defKey = `${w.id}-${e.id}-card-def`;
    const exKey  = `${w.id}-${e.id}-card-ex`;
    return `
      <div class="card-entry">
        ${w.entries.length > 1 ? `<div class="card-def-num">Definition ${i + 1}</div>` : ""}
        <div class="card-entry-row">
          <div class="card-entry-content">
            <div class="clamp-cell" data-clamp-key="${escAttr(defKey)}">
              <div class="entry-def clamp-text">${highlight(e.def, q)}</div>
              <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
            </div>
            ${(e.ex && e.ex.trim()) ? `
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
        ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
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
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }); }
  catch { return ""; }
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════

function render() {
  const filtered = getFilteredWords();
  const q        = state.search.trim().toLowerCase();
  updateStats();
  if (state.view === "table") renderTable(filtered, q);
  else renderCards(filtered, q);
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
  if (view === "table") { tableWrapper.classList.remove("hidden"); cardsWrapper.classList.add("hidden"); }
  else { tableWrapper.classList.add("hidden"); cardsWrapper.classList.remove("hidden"); }
  btns.forEach(b => b.classList.toggle("active", b.dataset.view === view));
  render();
}

// ═══════════════════════════════════════════════════════════
//  CSV EXPORT
// ═══════════════════════════════════════════════════════════

function exportCSV() {
  if (!state.words.length) { toast("Nothing to export.", "warning"); return; }
  const rows = [["word", "definition", "example"]];
  state.words.forEach(w => {
    w.entries.forEach(e => rows.push([csvEsc(w.displayWord), csvEsc(e.def), csvEsc(e.ex || "")]));
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
//  CSV IMPORT  — [UPDATED] local-first
// ═══════════════════════════════════════════════════════════

function importCSV(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const text  = e.target.result;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) { toast("Empty file.", "warning"); return; }
    const start = lines[0].toLowerCase().includes("word") ? 1 : 0;
    const rows  = lines.slice(start).map(parseCSVRow).filter(r => r.length >= 2 && r[0] && r[1]);
    if (!rows.length) { toast("No valid rows found.", "warning"); return; }

    toast(`Importing ${rows.length} rows…`, "info");
    let ok = 0, fail = 0;

    for (const row of rows) {
      const [word, def, ex = ""] = row;
      // [NEW] Save locally first always
      const normalized = normalizeWord(word.trim());
      const existing = state.words.find(w => normalizeWord(w.displayWord) === normalized);
      if (existing) {
        addLocalDefinition(existing, def.trim(), ex.trim());
        const sw = state.words.find(w => w.id === existing.id);
        if (sw) sw.entries.push({ id: existing.id + "_e" + Date.now(), def: def.trim(), ex: ex.trim() });
      } else {
        const localWord = buildLocalWord(word.trim(), def.trim(), ex.trim());
        mergeIntoLocalWords(localWord);
        mergeResultIntoState(localWord);
      }
      saveLocalWords();

      if (!state.isOfflineMode) {
        try {
          const result = await api("ADD", { displayWord: word.trim(), def: def.trim(), ex: ex.trim() });
          mergeResultIntoState(result);
          const idx = state.localWords.findIndex(w => normalizeWord(w.displayWord) === normalizeWord(word.trim()));
          if (idx >= 0) state.localWords[idx] = { ...result, _local: false };
          saveLocalWords();
          ok++;
        } catch {
          fail++;
        }
      } else {
        ok++;
      }
    }

    render();
    updateStats();
    toast(`Import done: ${ok} saved${fail ? ", " + fail + " failed." : "."}`, ok ? "success" : "warning");
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
    } else { cur += ch; }
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

document.getElementById("addBtn").addEventListener("click", addWord);
document.getElementById("generatePromptBtn").addEventListener("click", generatePrompt);

["wordInput", "defInput", "exInput"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") addWord(); });
});

const inputActions = document.querySelector(".input-actions");
const cancelBtn    = document.createElement("button");
cancelBtn.id        = "cancelEditBtn";
cancelBtn.className = "btn btn-ghost";
cancelBtn.textContent = "Cancel";
cancelBtn.style.display = "none";
cancelBtn.addEventListener("click", cancelEdit);
inputActions.appendChild(cancelBtn);

document.getElementById("editSaveBtn").addEventListener("click", saveEdit);
document.getElementById("editCancelBtn").addEventListener("click", closeEditModal);
document.getElementById("mergeConfirmBtn").addEventListener("click", confirmMerge);
document.getElementById("mergeCancelBtn").addEventListener("click", closeMergeModal);

document.getElementById("editModal").addEventListener("click", function(e) { if (e.target === this) closeEditModal(); });
document.getElementById("mergeModal").addEventListener("click", function(e) { if (e.target === this) closeMergeModal(); });

document.getElementById("searchInput").addEventListener("input", function() { state.search = this.value; render(); });
document.getElementById("sortSelect").addEventListener("change", function() { state.sort = this.value; render(); });

document.querySelectorAll(".view-toggle .vbtn").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

document.getElementById("exportBtn").addEventListener("click", exportCSV);
document.getElementById("importBtn").addEventListener("click", () => { document.getElementById("csvFileInput").click(); });
document.getElementById("csvFileInput").addEventListener("change", function() { importCSV(this.files[0]); this.value = ""; });

window.addEventListener("resize", () => { detectOverflow(); });

// ═══════════════════════════════════════════════════════════
//  [UPDATED] SERVICE WORKER — skipped on file://
// ═══════════════════════════════════════════════════════════

if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
  navigator.serviceWorker.register("./service-worker.js")
    .then(() => dbg("Service worker registered"))
    .catch(err => console.warn("SW registration failed:", err));
} else {
  dbg("Service worker skipped (file:// or unsupported)");
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

(async () => {
  await updateOnlineStatus();
  await fetchWords();
})();