"use strict";

const API = window.APPS_SCRIPT_URL;

const ENV = (() => {
  const proto = location.protocol;
  return {
    isFile:      proto === "file:",
    isLocalhost: proto === "http:" && (location.hostname === "localhost" || location.hostname === "127.0.0.1"),
    isHttps:     proto === "https:",
  };
})();

const LOG_PREFIX = "[VocabPWA]";
function dbg(...args) { console.log(LOG_PREFIX, ...args); }

dbg("Environment →", ENV);

const isMobile = () => window.innerWidth <= 700;

let state = {
  words:        [],
  localWords:   JSON.parse(localStorage.getItem("localWords") || "[]"),
  queue:        JSON.parse(localStorage.getItem("queue") || "[]"),
  isOfflineMode: ENV.isFile || !navigator.onLine,
  editMode:     false,
  editWordId:   null,
  editEntryId:  null,
  search:       "",
  sort:         "newest",
  view:         isMobile() ? "table" : "table",
  expandedCells: {},
  expandedDefs:  {},
};

let _syncInProgress = false;

if (ENV.isFile) dbg("Running in offline mode (file://)");

function normalizeDef(def) {
  return String(def || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDuplicateDef(entries, def) {
  const nd = normalizeDef(def);
  return entries.some(e => normalizeDef(e.def) === nd);
}

function deduplicateEntries(entries) {
  const seen = new Set();
  return entries.filter(e => {
    const key = normalizeDef(e.def);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function saveLocalWords() {
  localStorage.setItem("localWords", JSON.stringify(state.localWords));
  updateQueueBadge();
  updateSyncButton();
}

function mergeIntoLocalWords(word) {
  const byId = state.localWords.findIndex(w => w.id === word.id);
  if (byId >= 0) { state.localWords[byId] = word; return; }
  const byName = state.localWords.findIndex(
    w => normalizeWord(w.displayWord) === normalizeWord(word.displayWord)
  );
  if (byName >= 0) { state.localWords[byName] = word; return; }
  state.localWords.unshift(word);
}

function buildLocalWord(displayWord, def, ex) {
  const id      = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const entryId = id + "_e0";
  return {
    id,
    displayWord,
    word: normalizeWord(displayWord),
    entries: [{ id: entryId, def, ex: ex || "" }],
    createdAt: new Date().toISOString(),
    _local: true,
  };
}

function addLocalDefinition(existingWord, def, ex) {
  const word = state.localWords.find(w => w.id === existingWord.id);
  if (!word) return;
  if (hasDuplicateDef(word.entries, def)) return;
  const entryId = word.id + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
  word.entries.push({ id: entryId, def, ex: ex || "" });
  word._local = true;
  saveLocalWords();
}

function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
  updateQueueBadge();
}

function updateQueueBadge() {
  const badge = document.getElementById("queueBadge");
  if (!badge) return;
  const localUnsyncedCount = state.localWords.filter(w => w._local).length;
  const total = state.queue.length + localUnsyncedCount;
  if (total > 0) {
    badge.textContent = total + " unsynced";
    badge.classList.add("visible");
  } else {
    badge.classList.remove("visible");
  }
}

function updateSyncButton() {
  const btn = document.getElementById("syncBtn");
  if (!btn) return;
  const localUnsyncedCount = state.localWords.filter(w => w._local).length;
  const total = state.queue.length + localUnsyncedCount;
  if (total > 0 && !state.isOfflineMode) {
    btn.style.display = "inline-flex";
  } else {
    btn.style.display = "none";
  }
}

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
  updateSyncButton();
}

async function updateOnlineStatus() {
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

  if (API) {
    try {
      const params = new URLSearchParams({ action: "PING", t: Date.now() });
      const res = await fetch(API + "?" + params, { signal: makeAbortSignal(5000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      setOfflineMode(false);
      syncLocalToServer();
    } catch {
      dbg("API unreachable — forcing offline mode");
      setOfflineMode(true);
    }
  } else {
    setOfflineMode(true);
    dbg("Running in offline mode (no API configured)");
  }
}

window.addEventListener("online",  () => { dbg("Browser online event"); updateOnlineStatus(); });
window.addEventListener("offline", () => { dbg("Browser offline event"); setOfflineMode(true); });

function makeAbortSignal(ms) {
  try { return AbortSignal.timeout(ms); }
  catch (_) { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), ms); return ctrl.signal; }
}

async function api(action, payload = {}) {
  if (!API) throw new Error("No API configured");
  const params = new URLSearchParams({
    action:  action.toUpperCase(),
    payload: JSON.stringify(payload),
    t:       Date.now(),
  });
  const url = API + "?" + params.toString();
  const res  = await fetch(url, { signal: makeAbortSignal(10000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error");
  return json.data;
}

function normalizeWord(word) {
  return String(word).trim().toLowerCase().replace(/\s+/g, " ");
}

function showLoadingState() {
  const tbody = document.getElementById("tableBody");
  const grid  = document.getElementById("cardsGrid");
  if (tbody) tbody.innerHTML = `<tr><td colspan="3"><div class="loading-state"><span class="spinner"></span> Loading…</div></td></tr>`;
  if (grid)  grid.innerHTML  = `<div class="loading-state"><span class="spinner"></span> Loading…</div>`;
}

function showEmptyFallback(msg) {
  const tbody = document.getElementById("tableBody");
  const grid  = document.getElementById("cardsGrid");
  const html  = msg || "No words yet. Add your first one above.";
  if (tbody) tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div class="empty-icon">📖</div><p>${html}</p></div></td></tr>`;
  if (grid)  grid.innerHTML  = `<div class="empty-state"><div class="empty-icon">📖</div><p>${html}</p></div>`;
}

async function fetchWords() {
  if (state.localWords.length > 0) {
    state.words = buildDeduplicatedWords(state.localWords);
    render();
    updateStats();
  } else if (state.isOfflineMode) {
    showEmptyFallback();
  }

  if (state.isOfflineMode) {
    dbg("Offline mode: rendering from localWords");
    if (state.localWords.length === 0) showEmptyFallback();
    return;
  }

  try {
    const data = await api("GET");
    state.words = buildDeduplicatedWords(data);
    state.words.forEach(w => mergeIntoLocalWords({ ...w, _local: false }));
    saveLocalWords();
    render();
    updateStats();
  } catch (err) {
    console.error("Fetch failed:", err);
    dbg("Fetch failed, falling back to localWords");
    if (state.localWords.length === 0) {
      showEmptyFallback("Failed to load. Check your connection.");
      toast("Failed to load words. Check your connection.", "error");
    }
    state.isOfflineMode = true;
    updateSyncButton();
  }
}

function buildDeduplicatedWords(data) {
  const seen = new Map();
  const arr  = Array.isArray(data) ? [...data] : [];

  arr.forEach(w => {
    const key = normalizeWord(w.displayWord || "");
    if (!seen.has(key)) {
      seen.set(key, { ...w, entries: deduplicateEntries(Array.isArray(w.entries) ? [...w.entries] : []) });
    } else {
      const existing = seen.get(key);
      const incomingEntries = Array.isArray(w.entries) ? w.entries : [];
      const merged = [...existing.entries];
      incomingEntries.forEach(e => {
        if (!hasDuplicateDef(merged, e.def)) {
          merged.push(e);
        }
      });
      const base = (w.createdAt && existing.createdAt && w.createdAt < existing.createdAt) ? w : existing;
      seen.set(key, { ...base, entries: merged });
    }
  });

  return Array.from(seen.values());
}

function mergeResultIntoState(result) {
  const byId = state.words.findIndex(w => String(w.id) === String(result.id));
  if (byId >= 0) {
    state.words[byId] = { ...result };
    return;
  }
  const byName = state.words.findIndex(
    w => normalizeWord(w.displayWord) === normalizeWord(result.displayWord)
  );
  if (byName >= 0) {
    state.words[byName] = { ...result };
    return;
  }
  state.words.unshift({ ...result });
}

async function syncLocalToServer() {
  if (_syncInProgress) return;

  const localDirty = state.localWords.filter(w => w._local);
  const hasQueue   = state.queue.length > 0;

  if (!localDirty.length && !hasQueue) return;
  if (!navigator.onLine || state.isOfflineMode) return;

  _syncInProgress = true;
  dbg("Sync started — localDirty:", localDirty.length, "queue:", state.queue.length);

  const badge  = document.getElementById("statusBadge");
  const syncBtn = document.getElementById("syncBtn");
  if (badge) { badge.className = "status-badge syncing"; badge.querySelector(".label").textContent = "Syncing…"; }
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = "⟳ Syncing…"; }

  let syncedCount = 0;
  let failedCount = 0;

  for (const localWord of localDirty) {
    let allEntriesSynced = true;
    let serverResult = null;

    for (const entry of localWord.entries) {
      try {
        const result = await api("ADD", {
          displayWord: localWord.displayWord,
          def: entry.def,
          ex:  entry.ex || "",
        });
        serverResult = result;
        mergeResultIntoState(result);
        syncedCount++;
      } catch (err) {
        dbg("Sync failed for word:", localWord.displayWord, err.message);
        allEntriesSynced = false;
        failedCount++;
      }
    }

    if (allEntriesSynced && serverResult) {
      const idx = state.localWords.findIndex(w => w.id === localWord.id);
      if (idx >= 0) {
        state.localWords[idx] = { ...serverResult, _local: false };
      }
    }
  }

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

  _syncInProgress = false;

  if (badge) { badge.className = "status-badge online"; badge.querySelector(".label").textContent = "Online"; }
  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.textContent = "⟳ Sync";
    updateSyncButton();
  }

  if (failedCount === 0) {
    dbg("Sync success — synced:", syncedCount);
    if (syncedCount > 0) toast(`Synced ${syncedCount} item(s) to server.`, "success");
  } else {
    dbg("Sync failed (partial) — synced:", syncedCount, "failed:", failedCount);
    toast(`Synced ${syncedCount}, ${failedCount} still pending.`, "warning");
  }

  if (syncedCount > 0) {
    await fetchWords();
  } else {
    render();
    updateStats();
  }
}

async function manualSync() {
  if (_syncInProgress) { toast("Sync already in progress…", "info"); return; }
  const syncBtn = document.getElementById("syncBtn");
  if (syncBtn) syncBtn.disabled = true;
  await syncLocalToServer();
  if (!state.isOfflineMode) {
    await fetchWords();
  }
}

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

async function addWord() {
  const wordEl = document.getElementById("wordInput");
  const defEl  = document.getElementById("defInput");
  const exEl   = document.getElementById("exInput");
  const addBtn = document.getElementById("addBtn");

  const word = wordEl.value.trim();
  let def = defEl.value.trim();
  let ex  = exEl.value.trim();

  if (def.includes("--") && !ex) {
    const parts = def.split("--");
    if (parts.length >= 2) {
      def = parts[0].trim();
      ex  = parts.slice(1).join("--").trim();
    }
  }

  if (!word || !def) { toast("Please fill in Word and Definition.", "warning"); return; }
  if (state.editMode) { await updateWord(word, def, ex); return; }

  const normalized = normalizeWord(word);
  const existing   = state.words.find(w => normalizeWord(w.displayWord) === normalized);

  if (existing) {
    if (hasDuplicateDef(existing.entries, def)) {
      toast("This definition already exists for this word.", "warning");
      return;
    }
    openMergeModal(existing, word, def, ex);
    return;
  }

  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  const localWord = buildLocalWord(word, def, ex);
  mergeIntoLocalWords(localWord);
  mergeResultIntoState(localWord);
  saveLocalWords();

  wordEl.value = defEl.value = exEl.value = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";
  render();
  updateStats();

  if (!state.isOfflineMode) {
    _pushWordToServer(localWord, word, def, ex);
  } else {
    dbg("Offline — word saved locally, will sync later");
    toast("Saved locally. Will sync when online.", "warning");
  }
}

async function _pushWordToServer(localWord, displayWord, def, ex) {
  try {
    const result = await api("ADD", { displayWord, def, ex });
    const oldId = localWord.id;

    const byId   = state.words.findIndex(w => String(w.id) === String(result.id));
    const byOld  = state.words.findIndex(w => String(w.id) === String(oldId));
    const byName = state.words.findIndex(w => normalizeWord(w.displayWord) === normalizeWord(result.displayWord));

    if (byId >= 0) {
      state.words[byId] = { ...result };
    } else if (byOld >= 0) {
      state.words[byOld] = { ...result };
    } else if (byName >= 0) {
      state.words[byName] = { ...result };
    } else {
      state.words.unshift({ ...result });
    }

    const lidxById  = state.localWords.findIndex(w => w.id === oldId);
    const lidxByName = state.localWords.findIndex(w => normalizeWord(w.displayWord) === normalizeWord(displayWord));

    if (lidxById >= 0) {
      state.localWords[lidxById] = { ...result, _local: false };
    } else if (lidxByName >= 0) {
      state.localWords[lidxByName] = { ...result, _local: false };
    } else {
      mergeIntoLocalWords({ ...result, _local: false });
    }

    saveLocalWords();
    render();
    updateStats();
    toast("Word added!", "success");
  } catch (err) {
    dbg("Push to server failed:", err.message, "— will retry on next sync");
    toast("Saved locally. Will sync when online.", "warning");
  }
}

let _pendingMerge = null;

function openMergeModal(existingWord, displayWord, def, ex) {
  _pendingMerge = { existingWord, displayWord, def, ex };
  document.getElementById("mergeWord").textContent     = existingWord.displayWord;
  document.getElementById("mergeDefCount").textContent = existingWord.entries.length;
  document.getElementById("mergeModal").classList.add("open");
}

async function confirmMerge() {
  if (!_pendingMerge) return;
  const { existingWord, displayWord, def, ex } = _pendingMerge;
  _pendingMerge = null;
  document.getElementById("mergeModal").classList.remove("open");

  const currentWord = state.words.find(
    w => String(w.id) === String(existingWord.id) ||
         normalizeWord(w.displayWord) === normalizeWord(existingWord.displayWord)
  );
  const checkWord = currentWord || existingWord;
  if (hasDuplicateDef(checkWord.entries, def)) {
    toast("This definition already exists for this word.", "warning");
    return;
  }

  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  const baseId     = (existingWord.id || "e") + "";
  const newEntryId = baseId + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
  const newEntry   = { id: newEntryId, def, ex: ex || "" };

  const stateWord = state.words.find(
    w => String(w.id) === String(existingWord.id) ||
         normalizeWord(w.displayWord) === normalizeWord(existingWord.displayWord)
  );
  if (stateWord) {
    if (!hasDuplicateDef(stateWord.entries, def)) {
      stateWord.entries = [...stateWord.entries, newEntry];
    }
  }

  const localWord = state.localWords.find(
    w => String(w.id) === String(existingWord.id) ||
         normalizeWord(w.displayWord) === normalizeWord(existingWord.displayWord)
  );
  if (localWord) {
    if (!hasDuplicateDef(localWord.entries, def)) {
      localWord.entries = [...localWord.entries, newEntry];
    }
    localWord._local = true;
  } else {
    const combined = stateWord ? { ...stateWord } : { ...existingWord };
    if (!hasDuplicateDef(combined.entries || [], def)) {
      combined.entries = [...(combined.entries || []), newEntry];
    }
    combined._local = true;
    mergeIntoLocalWords(combined);
  }
  saveLocalWords();

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
      const lidx = state.localWords.findIndex(
        w => String(w.id) === String(result.id) ||
             normalizeWord(w.displayWord) === normalizeWord(displayWord)
      );
      if (lidx >= 0) state.localWords[lidx] = { ...result, _local: false };
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

function openEditModal(wordId, entryId) {
  const word  = state.words.find(w => String(w.id) === String(wordId));
  const entry = word?.entries.find(e => String(e.id) === String(entryId));
  if (!word || !entry) { dbg("openEditModal: word/entry not found", wordId, entryId); return; }
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

  const stateWord = state.words.find(w => String(w.id) === String(wordId));
  if (stateWord) {
    const otherEntries = stateWord.entries.filter(e => String(e.id) !== String(entryId));
    if (hasDuplicateDef(otherEntries, def)) {
      toast("This definition already exists for this word.", "warning");
      saveBtn.disabled    = false;
      saveBtn.textContent = "Save Changes";
      return;
    }
    const entry = stateWord.entries.find(e => String(e.id) === String(entryId));
    if (entry) { entry.def = def; entry.ex = ex; }
  }

  const localWord = state.localWords.find(w => String(w.id) === String(wordId));
  if (localWord) {
    const entry = localWord.entries.find(e => String(e.id) === String(entryId));
    if (entry) { entry.def = def; entry.ex = ex; }
    localWord._local = true;
  } else if (stateWord) {
    mergeIntoLocalWords({ ...stateWord, _local: true });
  }
  saveLocalWords();

  closeEditModal();
  render();
  updateStats();

  if (!state.isOfflineMode) {
    try {
      const result = await api("UPDATE", { id: wordId, entryId, def, ex });
      if (result && result.id) {
        const idx = state.words.findIndex(w => String(w.id) === String(result.id));
        if (idx >= 0) state.words[idx] = { ...result };
        const lidx = state.localWords.findIndex(w => String(w.id) === String(result.id));
        if (lidx >= 0) state.localWords[lidx] = { ...result, _local: false };
        saveLocalWords();
        render();
        updateStats();
      }
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

async function updateWord(displayWord, def, ex) {
  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Updating…";

  const stateWord = state.words.find(w => String(w.id) === String(state.editWordId));
  if (stateWord) {
    const entry = stateWord.entries.find(e => String(e.id) === String(state.editEntryId));
    if (entry) { entry.def = def; entry.ex = ex; }
  }

  const localWord = state.localWords.find(w => String(w.id) === String(state.editWordId));
  if (localWord) {
    const entry = localWord.entries.find(e => String(e.id) === String(state.editEntryId));
    if (entry) { entry.def = def; entry.ex = ex; }
    localWord._local = true;
  } else if (stateWord) {
    mergeIntoLocalWords({ ...stateWord, _local: true });
  }
  saveLocalWords();

  try {
    if (!state.isOfflineMode) {
      const result = await api("UPDATE", { id: state.editWordId, entryId: state.editEntryId, def, ex });
      const idx = state.words.findIndex(w => String(w.id) === String(result.id));
      if (idx >= 0) state.words[idx] = { ...result };
      const lidx = state.localWords.findIndex(w => String(w.id) === String(result.id));
      if (lidx >= 0) state.localWords[lidx] = { ...result, _local: false };
      saveLocalWords();
      toast("Updated!", "success");
    } else {
      toast("Saved locally. Will sync when online.", "warning");
    }
  } catch (err) {
    console.error("Update failed:", err);
    toast("Saved locally. Will sync when online.", "warning");
  }
  cancelEdit();
}

async function deleteWord(id) {
  if (!confirm("Delete this word and all its definitions?")) return;

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

async function syncQueue() {
  await syncLocalToServer();
}

function speak(text) {
  if (!("speechSynthesis" in window)) { toast("Speech not supported in this browser.", "warning"); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = "en-US";
  speechSynthesis.speak(u);
}

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
    words = words.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  } else if (state.sort === "az") {
    words = words.slice().sort((a, b) => a.displayWord.localeCompare(b.displayWord));
  } else {
    words = words.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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

function updateStats() {
  const filtered  = getFilteredWords();
  const totalDefs = state.words.reduce((s, w) => s + w.entries.length, 0);
  const el = (id) => document.getElementById(id);
  if (el("statWords"))  el("statWords").textContent  = state.words.length;
  if (el("statDefs"))   el("statDefs").textContent   = totalDefs;
  if (el("statShown"))  el("statShown").textContent  = filtered.length;
}

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

function detectOverflow() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".clamp-cell").forEach(cell => {
      const text = cell.querySelector(".clamp-text");
      const btn  = cell.querySelector(".read-more-btn");
      if (!text || !btn) return;
      if (cell.classList.contains("expanded")) { btn.style.display = "inline-block"; return; }
      const isOverflowing = text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1;
      btn.style.display = isOverflowing ? "inline-block" : "none";
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

function toggleShowMoreDefs(wordId) {
  state.expandedDefs[wordId] = !state.expandedDefs[wordId];
  const row = document.querySelector(`tr[data-word-id="${CSS.escape(wordId)}"]`);
  if (!row) { render(); return; }
  const defCell = row.querySelector(".def-cell");
  if (!defCell) return;
  const word = state.words.find(w => String(w.id) === String(wordId));
  if (!word) return;
  defCell.innerHTML = buildDefCellHtml(word, state.search.trim().toLowerCase());
  restoreExpandedCells();
  detectOverflow();
}

function buildDefCellHtml(w, q) {
  const allEntries = Array.isArray(w.entries) && w.entries.length > 0
    ? w.entries
    : [{ id: w.id + "-0", def: w.def || "", ex: w.ex || "" }];

  const expanded = !!state.expandedDefs[String(w.id)];
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
    <tr data-word-id="${escAttr(String(w.id))}">
      <td class="word-cell">
        <span class="word-text word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</span>
        ${w.entries.length > 1 ? `<span class="entry-count-badge">${w.entries.length}</span>` : ""}
        ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
      </td>
      <td class="def-cell">${buildDefCellHtml(w, q)}</td>
      <td class="actions-cell">
        <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Pronounce">🔊</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(String(w.id))}')" title="Delete word">🗑</button>
      </td>
    </tr>`;
}

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
          <button class="btn btn-icon edit card-entry-edit-btn" onclick="openEditModal('${escAttr(String(w.id))}','${escAttr(String(e.id))}')" title="Edit this definition">✏️</button>
        </div>
      </div>`;
  }).join('<div class="entry-divider"></div>');

  return `
    <div class="vocab-card" data-word-id="${escAttr(String(w.id))}">
      <div class="card-header">
        <div class="card-word word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</div>
        ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
        ${w.createdAt ? `<div class="card-date">${fmtDate(w.createdAt)}</div>` : ""}
      </div>
      <div class="card-entries">${entriesHtml}</div>
      <div class="card-actions">
        <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Pronounce">🔊 Speak</button>
        <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(String(w.id))}')" title="Delete">🗑 Delete</button>
      </div>
    </div>`;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }); }
  catch { return ""; }
}

function render() {
  const filtered = getFilteredWords();
  const q        = state.search.trim().toLowerCase();
  updateStats();
  if (state.view === "table") renderTable(filtered, q);
  else renderCards(filtered, q);
  restoreExpandedCells();
  detectOverflow();
  updateSyncButton();
  // Re-attach mobile row expand listeners after every render
  if (isMobile()) attachMobileRowExpand();
  // Desktop-only: attach card-word click to toggle expanded class
  if (!isMobile()) attachDesktopCardExpand();
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

/* ── Mobile table row expand / collapse ─────────────────────── */
function attachMobileRowExpand() {
  const tbody = document.getElementById("tableBody");
  if (!tbody) return;

  tbody.querySelectorAll("tr[data-word-id]").forEach(row => {
    // Avoid double-binding
    if (row._mobileExpandBound) return;
    row._mobileExpandBound = true;

    row.addEventListener("click", function(e) {
      // Do not expand when tapping action buttons (speak, delete, edit)
      if (e.target.closest(".btn")) return;

      const isExpanded = this.classList.contains("row-expanded");

      // Collapse all other rows
      tbody.querySelectorAll("tr.row-expanded").forEach(r => {
        if (r !== this) r.classList.remove("row-expanded");
      });

      // Toggle this row
      this.classList.toggle("row-expanded", !isExpanded);
    });
  });
}

/* ── Desktop card word click expand / collapse ───────────── */
function attachDesktopCardExpand() {
  const grid = document.getElementById("cardsGrid");
  if (!grid) return;

  grid.querySelectorAll(".vocab-card .card-word").forEach(wordEl => {
    if (wordEl._desktopExpandBound) return;
    wordEl._desktopExpandBound = true;

    wordEl.addEventListener("click", function(e) {
      const card = this.closest(".vocab-card");
      if (!card) return;
      card.classList.toggle("expanded");
    });
  });
}


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
    let ok = 0, fail = 0, skipped = 0;

    for (const row of rows) {
      const [word, def, ex = ""] = row;
      const wordTrimmed = word.trim();
      const defTrimmed  = def.trim();
      const exTrimmed   = ex.trim();
      const normalized  = normalizeWord(wordTrimmed);

      const existing = state.words.find(w => normalizeWord(w.displayWord) === normalized);

      if (existing) {
        if (hasDuplicateDef(existing.entries, defTrimmed)) {
          skipped++;
          continue;
        }
        const newEntryId = existing.id + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
        const newEntry   = { id: newEntryId, def: defTrimmed, ex: exTrimmed };
        existing.entries = [...existing.entries, newEntry];
        const localWord  = state.localWords.find(w => String(w.id) === String(existing.id));
        if (localWord) {
          localWord.entries = [...localWord.entries, newEntry];
          localWord._local  = true;
        } else {
          mergeIntoLocalWords({ ...existing, _local: true });
        }
      } else {
        const localWord = buildLocalWord(wordTrimmed, defTrimmed, exTrimmed);
        mergeIntoLocalWords(localWord);
        mergeResultIntoState(localWord);
      }
      saveLocalWords();

      if (!state.isOfflineMode) {
        try {
          const result = await api("ADD", { displayWord: wordTrimmed, def: defTrimmed, ex: exTrimmed });
          mergeResultIntoState(result);
          const idx = state.localWords.findIndex(w => normalizeWord(w.displayWord) === normalizeWord(wordTrimmed));
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
    const skipMsg = skipped > 0 ? `, ${skipped} duplicate(s) skipped` : "";
    toast(`Import done: ${ok} saved${fail ? ", " + fail + " failed" : ""}${skipMsg}.`, ok ? "success" : "warning");
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

window.cancelEdit         = cancelEdit;
window.startEdit          = startEdit;
window.openEditModal      = openEditModal;
window.deleteWord         = deleteWord;
window.speak              = speak;
window.toggleReadMore     = toggleReadMore;
window.toggleShowMoreDefs = toggleShowMoreDefs;
window.manualSync         = manualSync;

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

const syncBtnEl = document.getElementById("syncBtn");
if (syncBtnEl) syncBtnEl.addEventListener("click", manualSync);

window.addEventListener("resize", () => { detectOverflow(); });

if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
  navigator.serviceWorker.register("./service-worker.js")
    .then(() => dbg("Service worker registered"))
    .catch(err => console.warn("SW registration failed:", err));
} else {
  dbg("Service worker skipped (file:// or unsupported)");
}

setView("table");
showLoadingState();
updateOnlineStatus().then(() => fetchWords());
