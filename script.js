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

// ── PART 5: Load persisted UI preferences ──────────────────────
function loadUIPrefs() {
  try {
    return JSON.parse(localStorage.getItem("uiPrefs") || "{}");
  } catch { return {}; }
}
function saveUIPrefs() {
  try {
    localStorage.setItem("uiPrefs", JSON.stringify({
      filter: state.filter,
      sort:   state.sort,
      view:   state.view,
    }));
  } catch {}
}

const _uiPrefs = loadUIPrefs();

let state = {
  words:        [],
  localWords:   JSON.parse(localStorage.getItem("localWords") || "[]"),
  queue:        JSON.parse(localStorage.getItem("queue") || "[]"),
  isOfflineMode: ENV.isFile, // startup sequence corrects this before first render
  editMode:     false,
  editWordId:   null,
  editEntryId:  null,
  search:       "",
  sort:         _uiPrefs.sort   || "newest",
  filter:       _uiPrefs.filter || "all",
  view:         _uiPrefs.view   || "table",
  expandedCells: {},
  expandedDefs:  {},
};

let _syncInProgress = false;

try { localStorage.removeItem("wordsData"); } catch {}

if (ENV.isFile) dbg("Running in offline mode (file://)");

function normalizeDef(def) {
  return String(def || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDuplicateDef(entries, def) {
  const nd = normalizeDef(def);
  return entries.some(e => normalizeDef(e.def) === nd);
}

function deduplicateEntries(entries) {
  const seen = new Map();
  entries.forEach(e => {
    const key = normalizeDef(e.def) || ("__ex_only__" + (e.id || Math.random()));
    if (!seen.has(key)) {
      seen.set(key, e);
    } else {
      // Prefer the entry that has an example over one that does not
      const prev = seen.get(key);
      if (!prev.ex && e.ex) seen.set(key, e);
    }
  });
  return Array.from(seen.values());
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
  const defVal  = (def || "").trim();
  const exVal   = (ex  || "").trim();
  // Always create one entry object so examples are preserved and the sheet
  // never receives an empty entries array. _incomplete is def-based only.
  const entries = [{ id: entryId, def: defVal, ex: exVal }];

  return {
    id,
    displayWord,
    word: normalizeWord(displayWord),
    entries,
    createdAt: new Date().toISOString(),
    _local: true,
    _incomplete: !defVal,
  };
}

function addLocalDefinition(existingWord, def, ex) {
  const word = state.localWords.find(w => w.id === existingWord.id);
  if (!word) return;
  if (def && hasDuplicateDef(word.entries, def)) return;
  const entryId = word.id + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
  const isServerWord = !String(word.id).startsWith("local_");
  word.entries.push({ id: entryId, def, ex: ex || "", ...(isServerWord ? { _pendingAdd: true } : {}) });
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

// ── Connection state machine ────────────────────────────────────
// Design invariants:
//  • Startup is OPTIMISTIC: never mark offline until at least 2 consecutive
//    ping failures (or navigator.onLine is hard-false).
//  • A single slow/timed-out ping NEVER forces offline.
//  • Apps Script cold-start can take up to 20 s — first ping timeout is 20 s,
//    retries use 15 s.
//  • Each ping carries a monotonic generation counter; a resolved promise from
//    a prior generation is silently discarded (no stale overwrites).
//  • Background re-ping runs every 30 s while the tab is visible; paused when
//    document is hidden to avoid unnecessary wake-ups.

const PING_TIMEOUT_STARTUP  = 20000; // first probe — Apps Script cold-start
const PING_TIMEOUT_RETRY    = 15000; // subsequent probes
const PING_TIMEOUT_ROUTINE  = 12000; // periodic background checks
const PING_FAIL_THRESHOLD   = 2;     // consecutive failures required before offline
const PING_RETRY_DELAY      = 4000;  // ms between startup retries
const PING_PERIODIC_INTERVAL= 30000; // ms between routine background pings

let _pingGeneration    = 0;  // monotonic counter; incremented on every new ping attempt
let _pingInProgress    = false;
let _consecutiveFails  = 0;
let _onlineDebounce    = null;
let _periodicPingTimer = null;

function makeAbortSignal(ms) {
  try { return AbortSignal.timeout(ms); }
  catch (_) { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), ms); return ctrl.signal; }
}

// Perform a single ping and return true/false. Never throws.
// Captures the generation at call-time and returns null if the result is stale.
async function _doPing(timeoutMs) {
  const gen = ++_pingGeneration;
  try {
    const params = new URLSearchParams({ action: "PING", t: Date.now() });
    const res = await fetch(API + "?" + params, {
      signal:   makeAbortSignal(timeoutMs),
      redirect: "follow",
    });
    if (gen !== _pingGeneration) { dbg("Ping stale (gen mismatch), discarding"); return null; }
    return res.status >= 200 && res.status < 300;
  } catch {
    if (gen !== _pingGeneration) { dbg("Ping stale (gen mismatch after error), discarding"); return null; }
    return false;
  }
}

// Core entry point — call this whenever connection state needs re-evaluation.
// triggerSync: attempt syncLocalToServer() if we transition from offline→online.
// isStartup:   first call on page load — uses longer timeout and is optimistic.
async function updateOnlineStatus(triggerSync = false, isStartup = false) {
  if (ENV.isFile) { setOfflineMode(true); return; }

  if (!navigator.onLine) {
    _consecutiveFails = PING_FAIL_THRESHOLD; // hard browser signal — trust it immediately
    setOfflineMode(true);
    dbg("Offline: navigator.onLine=false");
    return;
  }

  if (!API) {
    setOfflineMode(true);
    dbg("Offline: no API configured");
    return;
  }

  if (_pingInProgress) return;
  _pingInProgress = true;

  try {
    const timeout = isStartup ? PING_TIMEOUT_STARTUP : PING_TIMEOUT_ROUTINE;
    let success = await _doPing(timeout);

    // Stale result — another ping superseded this one; do nothing.
    if (success === null) return;

    if (success) {
      _consecutiveFails = 0;
      const wasOffline  = state.isOfflineMode;
      setOfflineMode(false);
      if (triggerSync && wasOffline) syncLocalToServer();
      _startPeriodicPing();
      return;
    }

    // First probe failed — retry once with a shorter timeout before penalising.
    dbg("Ping failed — retrying in", PING_RETRY_DELAY, "ms");
    await new Promise(r => setTimeout(r, PING_RETRY_DELAY));

    // If another ping has taken over while we were waiting, bail out.
    if (!_pingInProgress) return;

    const retryTimeout = isStartup ? PING_TIMEOUT_RETRY : PING_TIMEOUT_ROUTINE;
    success = await _doPing(retryTimeout);
    if (success === null) return;

    if (success) {
      _consecutiveFails = 0;
      const wasOffline  = state.isOfflineMode;
      setOfflineMode(false);
      if (triggerSync && wasOffline) syncLocalToServer();
      _startPeriodicPing();
    } else {
      _consecutiveFails++;
      dbg("Ping failed after retry — consecutive failures:", _consecutiveFails);
      if (_consecutiveFails >= PING_FAIL_THRESHOLD) {
        setOfflineMode(true);
        dbg("Offline threshold reached — switching to offline mode");
      } else {
        dbg("Below offline threshold — staying in current state");
      }
    }
  } finally {
    _pingInProgress = false;
  }
}

function _startPeriodicPing() {
  if (_periodicPingTimer) return; // already running
  _periodicPingTimer = setInterval(() => {
    if (document.hidden) return;
    updateOnlineStatus(true);
  }, PING_PERIODIC_INTERVAL);
}

window.addEventListener("online", () => {
  dbg("Browser online event");
  clearTimeout(_onlineDebounce);
  _consecutiveFails = 0; // reset — browser says we're back
  _onlineDebounce   = setTimeout(() => updateOnlineStatus(true), 1200);
});
window.addEventListener("offline", () => {
  dbg("Browser offline event");
  clearTimeout(_onlineDebounce);
  _consecutiveFails = PING_FAIL_THRESHOLD;
  setOfflineMode(true);
});

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
    // Do NOT call setOfflineMode(true) here — a single GET failure does not
    // mean the connection is lost. The ping layer handles connection state.
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
        const defKey = normalizeDef(e.def);
        const isDup = defKey !== ""
          ? hasDuplicateDef(merged, e.def)
          : merged.some(m => normalizeDef(m.def) === "" && m.id === e.id);
        if (!isDup) {
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
    const entries = Array.isArray(localWord.entries) ? localWord.entries : [];

    let allEntriesSynced = true;
    let serverResult = null;

    // Handle RENAME: word has _renamedFrom flag
    if (localWord._renamedFrom) {
      try {
        const result = await api("RENAME_WORD", {
          id:          String(localWord.id),
          displayWord: localWord.displayWord,
        });
        serverResult = result;
        mergeResultIntoState(result);
        syncedCount++;
      } catch (err) {
        dbg("Sync RENAME failed:", localWord.displayWord, err.message);
        allEntriesSynced = false;
        failedCount++;
      }

      if (allEntriesSynced && serverResult) {
        const idx = state.localWords.findIndex(w => w.id === localWord.id);
        if (idx >= 0) {
          state.localWords[idx] = { ...serverResult, _local: false };
        }
      }
      continue;
    }

    // Legacy path: entries:[] words saved before the buildLocalWord fix.
    // Send with empty def/ex — server will store it as incomplete.
    if (entries.length === 0) {
      try {
        const result = await api("ADD", {
          displayWord: localWord.displayWord,
          def: "",
          ex:  localWord._savedEx || "",
        });

        serverResult = result;
        mergeResultIntoState(result);
        syncedCount++;
      } catch (err) {
        dbg("Sync failed for incomplete word:", localWord.displayWord, err.message);
        allEntriesSynced = false;
        failedCount++;
      }

      if (allEntriesSynced && serverResult) {
        const idx = state.localWords.findIndex(w => w.id === localWord.id);
        if (idx >= 0) {
          state.localWords[idx] = { ...serverResult, _local: false };
        }
      }

      continue;
    }

    const isNewWord = String(localWord.id).startsWith("local_");

    for (const entry of entries) {
      try {
        let result;
        if (isNewWord) {
          result = await api("ADD", {
            displayWord: localWord.displayWord,
            def: entry.def,
            ex:  entry.ex || "",
          });
        } else {
          if (entry._pendingAdd) {
            result = await api("ADD", {
              displayWord: localWord.displayWord,
              def: entry.def,
              ex:  entry.ex || "",
            });
          } else {
            result = await api("UPDATE", {
              id:      String(localWord.id),
              entryId: String(entry.id),
              def:     entry.def,
              ex:      entry.ex || "",
            });
          }
        }
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
  // syncLocalToServer already calls fetchWords() when items were synced.
  // Only fetch again here when there was nothing to sync (pure refresh).
  if (!state.isOfflineMode) {
    const stillDirty = state.localWords.filter(w => w._local).length;
    if (stillDirty === 0 && state.queue.length === 0) {
      await fetchWords();
    }
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

// ── PART 3: Typo / Spelling Suggestion System ─────────────────
let _typoSuggestionWord = null;

function dismissTypoSuggestion() {
  const bar = document.getElementById("typoSuggestionBar");
  if (bar) bar.remove();
  _typoSuggestionWord = null;
}

// Returns suggestion string or null — pure data, no UI side effects.
async function getTypoSuggestion(word) {
  if (!word || word.length < 4) return null;
  if (/^\d/.test(word)) return null;
  if (word === word.toUpperCase()) return null;
  if (word.split(" ").length > 5) return null;

  const wordLower = word.toLowerCase();
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(wordLower)}&max=1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.length) return null;
    const top   = data[0].word;
    const score = data[0].score || 0;
    if (
      top &&
      top.toLowerCase() !== wordLower &&
      score > 500 &&
      Math.abs(top.length - wordLower.length) <= 3
    ) {
      return top;
    }
  } catch {
    // Datamuse failure — silently continue
  }
  return null;
}

// Shows the inline bar. onProceed(wordToUse) is called once the user decides.
function showTypoSuggestion(original, suggestion, onProceed) {
  dismissTypoSuggestion();
  _typoSuggestionWord = suggestion;

  const bar = document.createElement("div");
  bar.id = "typoSuggestionBar";
  bar.className = "typo-suggestion-bar";
  bar.innerHTML = `
    <span class="typo-msg">Did you mean: <strong>${escHtml(suggestion)}</strong>?</span>
    <button class="btn btn-primary btn-sm" id="typoUseSuggestion">Use Suggestion</button>
    <button class="btn btn-ghost btn-sm" id="typoKeepWord">Keep My Word</button>
  `;

  const inputPanel = document.querySelector(".input-panel");
  if (inputPanel) inputPanel.insertAdjacentElement("afterend", bar);

  document.getElementById("typoUseSuggestion").addEventListener("click", () => {
    document.getElementById("wordInput").value = suggestion;
    dismissTypoSuggestion();
    onProceed(suggestion);
  });
  document.getElementById("typoKeepWord").addEventListener("click", () => {
    dismissTypoSuggestion();
    onProceed(original);
  });
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

  if (!word) { toast("Please fill in Word.", "warning"); return; }
  if (state.editMode) { await updateWord(word, def, ex); return; }

  const normalized = normalizeWord(word);
  const existing   = state.words.find(w => normalizeWord(w.displayWord) === normalized);

  if (existing) {
    if (def && hasDuplicateDef(existing.entries, def)) {
      toast("This definition already exists for this word.", "warning");
      return;
    }
    openMergeModal(existing, word, def, ex);
    return;
  }

  // PART 3: Pre-save typo check — show suggestion bar and await user decision.
  addBtn.disabled    = true;
  addBtn.textContent = "Checking…";

  const suggestion = await getTypoSuggestion(word);

  if (suggestion) {
    addBtn.disabled    = false;
    addBtn.textContent = "Add Word";
    // Show bar; onProceed receives the word the user chose.
    showTypoSuggestion(word, suggestion, (chosenWord) => {
      _commitAddWord(chosenWord, def, ex);
    });
    return;
  }

  // No suggestion — proceed immediately.
  _commitAddWord(word, def, ex);
}

function _commitAddWord(word, def, ex) {
  const wordEl = document.getElementById("wordInput");
  const defEl  = document.getElementById("defInput");
  const exEl   = document.getElementById("exInput");
  const addBtn = document.getElementById("addBtn");

  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  const localWord = buildLocalWord(word, def, ex);
  mergeIntoLocalWords(localWord);
  mergeResultIntoState(localWord);
  saveLocalWords();

  wordEl.value       = defEl.value = exEl.value = "";
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
  if (def && hasDuplicateDef(checkWord.entries, def)) {
    toast("This definition already exists for this word.", "warning");
    return;
  }

  const addBtn = document.getElementById("addBtn");
  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  const baseId     = (existingWord.id || "e") + "";
  const newEntryId = baseId + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
  const isServerWord = !String(baseId).startsWith("local_");
  const newEntry   = { id: newEntryId, def, ex: ex || "", ...(isServerWord ? { _pendingAdd: true } : {}) };

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

// ── PART 1: Stable Edit Modal ─────────────────────────────────
function openEditModal(wordId, entryId) {
  const word = state.words.find(w => String(w.id) === String(wordId));
  if (!word) { dbg("openEditModal: word not found", wordId); return; }

  document.getElementById("editWordId").value  = String(wordId);
  document.getElementById("editEntryId").value = String(entryId);

  if (String(entryId) === "new") {
    // Incomplete word — create first definition
    document.getElementById("editModalTitle").textContent = "Add First Definition";
    document.getElementById("editDef").value = "";
    document.getElementById("editEx").value  = "";
  } else {
    document.getElementById("editModalTitle").textContent = "Edit Definition";
    const entry = word.entries.find(e => String(e.id) === String(entryId));
    if (!entry) { dbg("openEditModal: entry not found", wordId, entryId); return; }
    document.getElementById("editDef").value = entry.def;
    document.getElementById("editEx").value  = entry.ex || "";
  }
  document.getElementById("editModal").classList.add("open");
}

function closeEditModal() {
  document.getElementById("editModal").classList.remove("open");
  document.getElementById("editModalTitle").textContent = "Edit Definition";
}

async function saveEdit() {
  const wordId  = document.getElementById("editWordId").value;
  const entryId = document.getElementById("editEntryId").value;
  const def     = document.getElementById("editDef").value.trim();
  const ex      = document.getElementById("editEx").value.trim();
  const saveBtn = document.getElementById("editSaveBtn");
  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving…";

  const stateWord = state.words.find(w => String(w.id) === String(wordId));

  if (String(entryId) === "new") {
    // For a new entry, allow saving with no def (example-only stays incomplete).
    // Only skip saving entirely if both def and ex are empty.
    if (!def && !ex) {
      toast("Please enter at least a definition or an example.", "warning");
      saveBtn.disabled    = false;
      saveBtn.textContent = "Save Changes";
      return;
    }
    // Incomplete word: create its first definition entry
    if (def && stateWord && hasDuplicateDef(stateWord.entries, def)) {
      toast("This definition already exists for this word.", "warning");
      saveBtn.disabled    = false;
      saveBtn.textContent = "Save Changes";
      return;
    }
    const newEntryId = wordId + "_e" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
    const newEntry   = { id: newEntryId, def, ex };
    const entryHasDef = !!def;
    if (stateWord) {
      stateWord.entries     = [...(stateWord.entries || []), newEntry];
      stateWord._incomplete = !entryHasDef;
    }
    const localWordNew = state.localWords.find(w => String(w.id) === String(wordId));
    if (localWordNew) {
      localWordNew.entries     = [...(localWordNew.entries || []), newEntry];
      localWordNew._incomplete = !entryHasDef;
      localWordNew._local      = true;
    } else if (stateWord) {
      mergeIntoLocalWords({ ...stateWord, _local: true });
    }
    saveLocalWords();
    closeEditModal();
    render();
    updateStats();
    if (!state.isOfflineMode) {
      try {
        const result = await api("ADD", { displayWord: stateWord ? stateWord.displayWord : wordId, def, ex });
        if (result && result.id) {
          const idx  = state.words.findIndex(w => String(w.id) === String(wordId));
          if (idx  >= 0) state.words[idx]      = { ...result };
          const lidx = state.localWords.findIndex(w => String(w.id) === String(wordId));
          if (lidx >= 0) state.localWords[lidx] = { ...result, _local: false };
          saveLocalWords();
          render();
          updateStats();
        }
        toast("Definition added!", "success");
      } catch (err) {
        console.error("Add first entry failed:", err);
        toast("Saved locally. Will sync when online.", "warning");
      }
    } else {
      toast("Saved locally. Will sync when online.", "warning");
    }
    saveBtn.disabled    = false;
    saveBtn.textContent = "Save Changes";
    return;
  }

  // Editing existing entry — definition is required
  if (!def) { toast("Definition cannot be empty.", "warning"); saveBtn.disabled = false; saveBtn.textContent = "Save Changes"; return; }

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
  if (state.isOfflineMode) {
    toast("Internet connection required to delete.", "warning");
    return;
  }
  openDeleteModal("Delete this word and all its definitions?", async () => {
    closeDeleteModal();

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
  });
}

async function deleteEntry(wordId, entryId) {
  if (state.isOfflineMode) {
    toast("Internet connection required to delete.", "warning");
    return;
  }
  openDeleteModal("Delete this definition?", async () => {
    closeDeleteModal();

    const word = state.words.find(w => String(w.id) === String(wordId));
    if (!word) return;

    const entries = Array.isArray(word.entries) ? word.entries : [];
    word.entries = entries.filter(e => String(e.id) !== String(entryId));

    const hasDef = word.entries.some(e => e.def && e.def.trim());
    word._incomplete = !hasDef;

    const localWord = state.localWords.find(w => String(w.id) === String(wordId));
    if (localWord) {
      localWord.entries = [...word.entries];
      localWord._incomplete = !hasDef;
    }

    saveLocalWords();
    render();
    updateStats();
    toast("Definition deleted.", "info");

    if (!state.isOfflineMode) {
      try {
        await api("DELETE_ENTRY", {
          wordId:  String(wordId),
          entryId: String(entryId),
        });
      } catch (err) {
        console.error("DELETE_ENTRY failed:", err);
      }
    }
  });
}

// ── PART 2: Edit Word (rename) ────────────────────────────────
function openRenameWordModal(wordId) {
  const word = state.words.find(w => String(w.id) === String(wordId));
  if (!word) return;
  document.getElementById("renameWordId").value    = String(wordId);
  document.getElementById("renameWordInput").value = word.displayWord;
  document.getElementById("renameWordModal").classList.add("open");
  setTimeout(() => {
    const inp = document.getElementById("renameWordInput");
    if (inp) { inp.focus(); inp.select(); }
  }, 80);
}

function closeRenameWordModal() {
  document.getElementById("renameWordModal").classList.remove("open");
}

async function saveRenameWord() {
  const wordId     = document.getElementById("renameWordId").value;
  const newDisplay = document.getElementById("renameWordInput").value.trim();
  if (!newDisplay) { toast("Word cannot be empty.", "warning"); return; }

  const stateWord = state.words.find(w => String(w.id) === String(wordId));
  if (!stateWord) { closeRenameWordModal(); return; }

  const oldDisplay = stateWord.displayWord;
  if (normalizeWord(newDisplay) === normalizeWord(oldDisplay)) {
    closeRenameWordModal();
    return; // No change
  }

  // Duplicate check — don't allow rename to an already existing word
  const duplicate = state.words.find(
    w => String(w.id) !== String(wordId) &&
         normalizeWord(w.displayWord) === normalizeWord(newDisplay)
  );
  if (duplicate) {
    toast(`"${newDisplay}" already exists. Use merge instead.`, "warning");
    return;
  }

  const saveBtn = document.getElementById("renameWordSaveBtn");
  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving…";

  // Update state
  stateWord.displayWord = newDisplay;
  stateWord.word        = normalizeWord(newDisplay);

  // Update localWords
  const localWord = state.localWords.find(w => String(w.id) === String(wordId));
  if (localWord) {
    localWord.displayWord  = newDisplay;
    localWord.word         = normalizeWord(newDisplay);
    localWord._local       = true;
    localWord._renamedFrom = oldDisplay;
  } else {
    mergeIntoLocalWords({ ...stateWord, _local: true, _renamedFrom: oldDisplay });
  }
  saveLocalWords();

  closeRenameWordModal();
  render();
  updateStats();

  if (!state.isOfflineMode) {
    try {
      const result = await api("RENAME_WORD", { id: String(wordId), displayWord: newDisplay });
      if (result && result.id) {
        const idx = state.words.findIndex(w => String(w.id) === String(result.id));
        if (idx >= 0) state.words[idx] = { ...result };
        const lidx = state.localWords.findIndex(w => String(w.id) === String(result.id));
        if (lidx >= 0) {
          const prev = state.localWords[lidx];
          state.localWords[lidx] = { ...result, _local: false, _renamedFrom: undefined };
          delete state.localWords[lidx]._renamedFrom;
        }
        saveLocalWords();
        render();
        updateStats();
      }
      toast("Word renamed!", "success");
    } catch (err) {
      dbg("RENAME_WORD server failed:", err.message);
      toast("Saved locally. Will sync when online.", "warning");
    }
  } else {
    toast("Saved locally. Will sync when online.", "warning");
  }

  saveBtn.disabled    = false;
  saveBtn.textContent = "Rename";
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
      const entries = Array.isArray(w.entries) ? w.entries : [];
      return entries.some(e =>
        (e.def || "").toLowerCase().includes(q) ||
        (e.ex  || "").toLowerCase().includes(q)
      );
    });
  }
  if (state.filter === "complete") {
    words = words.filter(w => (w.entries || []).some(e => e.def && e.def.trim()));
  }
  if (state.filter === "incomplete") {
    words = words.filter(w => !(w.entries || []).some(e => e.def && e.def.trim()));
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
  const filtered = getFilteredWords();

  const totalDefs = state.words.reduce((sum, w) => {
    const entries = Array.isArray(w.entries) ? w.entries : [];
    return sum + entries.filter(e =>
      e && typeof e.def === "string" && e.def.trim()
    ).length;
  }, 0);

  const el = (id) => document.getElementById(id);

  if (el("statWords")) el("statWords").textContent = state.words.length;
  if (el("statDefs")) el("statDefs").textContent = totalDefs;
  if (el("statShown")) el("statShown").textContent = filtered.length;
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

// ── PART 1: buildDefCellHtml — stable IDs, no index reliance ──
function buildDefCellHtml(w, q) {
  const isIncomplete = !Array.isArray(w.entries) || !w.entries.some(e => e.def && e.def.trim());

  if (isIncomplete) {
    // Find the first entry that might have an example even without a def
    const incompleteEntry = Array.isArray(w.entries) ? w.entries[0] : null;
    const exHtml = (incompleteEntry && incompleteEntry.ex && incompleteEntry.ex.trim())
      ? `<div class="clamp-cell" data-clamp-key="${escAttr(w.id + "-inc-ex")}">
           <div class="entry-ex clamp-text">${highlight(incompleteEntry.ex, q)}</div>
           <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
         </div>`
      : "";
    return `<div class="entry-block incomplete-entry">
      <div class="entry-actions-row">
        <span class="incomplete-hint">No definition yet</span>
        <button class="btn btn-icon edit entry-edit-btn"
          onclick="openEditModal('${escAttr(String(w.id))}','${incompleteEntry ? escAttr(String(incompleteEntry.id)) : 'new'}')"
          title="Add definition">✏️</button>
      </div>
      ${exHtml}
    </div>`;
  }

  const allEntries = w.entries;
  const expanded   = !!state.expandedDefs[String(w.id)];
  const entries    = expanded ? allEntries : allEntries.slice(0, 1);
  const hasMore    = allEntries.length > 1;

  const entriesHtml = entries.map((e) => {
    const trueIndex = allEntries.findIndex(ae => ae.id === e.id);
    const defKey    = `${w.id}-${e.id}-def`;
    const exKey     = `${w.id}-${e.id}-ex`;
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
          title="Edit definition">✏️</button>
        <button class="btn btn-icon delete entry-edit-btn"
          onclick="event.stopPropagation();deleteEntry('${escAttr(String(w.id))}','${escAttr(String(e.id))}')"
          title="Delete entry">🗑</button>
      </div>
      ${exHtml}
    </div>`;
  }).join('<div class="entry-divider"></div>');

  const remaining = allEntries.length - 1;
  const moreBtn   = hasMore
    ? `<button class="show-more-btn" onclick="toggleShowMoreDefs('${escAttr(String(w.id))}')">
         ${expanded ? "Collapse ▲" : `Show ${remaining} more definition${remaining > 1 ? "s" : ""}`}
       </button>`
    : "";

  return entriesHtml + moreBtn;
}

// ── PART 1: buildTableRow — stable IDs, rename button ────────
function buildTableRow(w, q) {
  const isIncomplete = !Array.isArray(w.entries) || !w.entries.some(e => e.def && e.def.trim());
  return `
    <tr data-word-id="${escAttr(String(w.id))}">
      <td class="word-cell">
        <div class="word-cell-top">
          <span class="word-text word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</span>
          ${w.entries && w.entries.length > 1 ? `<span class="entry-count-badge">${w.entries.length}</span>` : ""}
          ${isIncomplete ? `<span class="incomplete-badge" title="No definition added yet">Incomplete</span>` : ""}
          ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
        </div>
        <div class="word-cell-actions">
          <button class="btn btn-icon rename" onclick="openRenameWordModal('${escAttr(String(w.id))}')" title="Rename word">✏️</button>
          <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Speak word">🔊</button>
          <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(String(w.id))}')" title="Delete word">🗑</button>
        </div>
      </td>
      <td class="def-cell">${buildDefCellHtml(w, q)}</td>
      <td class="actions-cell"></td>
    </tr>`;
}

// ── PART 1: buildCardHtml — stable IDs, rename button ─────────
function buildCardHtml(w, q) {
  const isIncomplete = !Array.isArray(w.entries) || !w.entries.some(e => e.def && e.def.trim());

  let entriesHtml;
  if (isIncomplete) {
    const incompleteEntry = Array.isArray(w.entries) ? w.entries[0] : null;
    const exHtml = (incompleteEntry && incompleteEntry.ex && incompleteEntry.ex.trim())
      ? `<div class="clamp-cell" data-clamp-key="${escAttr(w.id + "-inc-card-ex")}">
           <div class="entry-ex clamp-text">${highlight(incompleteEntry.ex, q)}</div>
           <button class="read-more-btn" onclick="toggleReadMore(this)">Read more ▼</button>
         </div>`
      : "";
    entriesHtml = `<div class="card-entry">
      <div class="card-entry-row">
        <div class="card-entry-content">
          <span class="incomplete-hint">No definition yet</span>
          ${exHtml}
        </div>
        <button class="btn btn-icon edit card-entry-edit-btn"
          onclick="openEditModal('${escAttr(String(w.id))}','${incompleteEntry ? escAttr(String(incompleteEntry.id)) : 'new'}')"
          title="Add definition">✏️</button>
      </div>
    </div>`;
  } else {
    entriesHtml = w.entries.map((e, i) => {
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
            <button class="btn btn-icon edit card-entry-edit-btn"
              onclick="openEditModal('${escAttr(String(w.id))}','${escAttr(String(e.id))}')"
              title="Edit definition">✏️</button>
            <button class="btn btn-icon delete card-entry-edit-btn"
              onclick="event.stopPropagation();deleteEntry('${escAttr(String(w.id))}','${escAttr(String(e.id))}')"
              title="Delete entry">🗑</button>
          </div>
        </div>`;
    }).join('<div class="entry-divider"></div>');
  }

  return `
    <div class="vocab-card" data-word-id="${escAttr(String(w.id))}">
      <div class="card-header">
        <div class="card-header-main">
          <div class="card-word word-truncate" title="${escAttr(w.displayWord)}">${highlight(w.displayWord, q)}</div>
          ${w._local ? `<span class="local-badge" title="Not yet synced">⏳</span>` : ""}
          ${isIncomplete ? `<span class="incomplete-badge" title="No definition added yet">Incomplete</span>` : ""}
          ${w.createdAt ? `<div class="card-date">${fmtDate(w.createdAt)}</div>` : ""}
        </div>
        <div class="card-word-actions">
          <button class="btn btn-icon rename" onclick="openRenameWordModal('${escAttr(String(w.id))}')" title="Rename word">✏️</button>
          <button class="btn btn-icon speak" onclick="speak('${escAttr(w.displayWord)}')" title="Speak word">🔊</button>
          <button class="btn btn-icon delete" onclick="deleteWord('${escAttr(String(w.id))}')" title="Delete word">🗑</button>
        </div>
      </div>
      <div class="card-entries">${entriesHtml}</div>
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
  saveUIPrefs();
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

/* ── Desktop card word click expand / collapse ───────────────── */
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
  const filtered = getFilteredWords();
  if (!filtered.length) { toast("Nothing to export.", "warning"); return; }
  const rows = [["word", "definition", "example"]];

  filtered.forEach(w => {
    const entries = Array.isArray(w.entries) ? w.entries : [];
    if (entries.length === 0) {
      rows.push([csvEsc(w.displayWord), "", ""]);
    } else {
      entries.forEach(e =>
        rows.push([csvEsc(w.displayWord), csvEsc(e.def || ""), csvEsc(e.ex || "")])
      );
    }
  });

  const csv      = rows.map(r => r.join(",")).join("\n");
  const blob     = new Blob([csv], { type: "text/csv" });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement("a");
  a.href         = url;
  const suffix   = state.filter !== "all"  ? "-" + state.filter
                 : state.search.trim()     ? "-search"
                 : "";
  a.download     = "mba-vocabulary" + suffix + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`CSV exported (${filtered.length} word${filtered.length !== 1 ? "s" : ""})!`, "success");
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
    const rows = lines.slice(start).map(parseCSVRow).filter(r => r.length >= 1 && r[0]);
    if (!rows.length) { toast("No valid rows found.", "warning"); return; }

    toast(`Importing ${rows.length} rows…`, "info");
    let ok = 0, fail = 0, skipped = 0;

    for (const row of rows) {
      const [word, def, ex = ""] = row;
      const wordTrimmed = word.trim();
      const defTrimmed  = def ? def.trim() : "";
      const exTrimmed   = ex  ? ex.trim()  : "";
      const normalized  = normalizeWord(wordTrimmed);

      if (!wordTrimmed) { skipped++; continue; }

      const existing = state.words.find(w => normalizeWord(w.displayWord) === normalized);

      if (existing) {
        // Case A: incoming row fills in a definition for an existing example-only / word-only entry.
        //         Find a matching incomplete entry (def === "") and update it in-place instead of
        //         pushing a duplicate, but only when the incoming def is non-empty.
        const incompleteEntry = defTrimmed
          ? (existing.entries || []).find(e => !e.def || !e.def.trim())
          : null;

        if (incompleteEntry) {
          // UPDATE path — fill the blank entry in-place
          incompleteEntry.def = defTrimmed;
          if (exTrimmed && !incompleteEntry.ex) incompleteEntry.ex = exTrimmed;
          const localWord = state.localWords.find(w => String(w.id) === String(existing.id));
          if (localWord) {
            const le = (localWord.entries || []).find(e => String(e.id) === String(incompleteEntry.id));
            if (le) { le.def = defTrimmed; if (exTrimmed && !le.ex) le.ex = exTrimmed; }
            localWord._local = true;
          } else {
            mergeIntoLocalWords({ ...existing, _local: true });
          }
        } else {
          // ADD path — guard against true duplicates
          // For non-empty def: deduplicate by normalized def text
          // For example-only (def === ""): deduplicate by exact ex text
          const isDuplicate = defTrimmed
            ? hasDuplicateDef(existing.entries, defTrimmed)
            : (existing.entries || []).some(e => !e.def && e.ex === exTrimmed);

          if (isDuplicate) { skipped++; continue; }

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

// ── Delete Confirm Modal ────────────────────────────────────────
let _deleteCallback = null;

function openDeleteModal(message, onConfirm) {
  _deleteCallback = onConfirm;
  document.getElementById("deleteModalMsg").textContent = message;
  document.getElementById("deleteModal").classList.add("open");
}

function closeDeleteModal() {
  document.getElementById("deleteModal").classList.remove("open");
  _deleteCallback = null;
}

// ── Expose globals ─────────────────────────────────────────────
window.cancelEdit            = cancelEdit;
window.startEdit             = startEdit;
window.openEditModal         = openEditModal;
window.deleteWord            = deleteWord;
window.deleteEntry           = deleteEntry;
window.speak                 = speak;
window.toggleReadMore        = toggleReadMore;
window.toggleShowMoreDefs    = toggleShowMoreDefs;
window.manualSync            = manualSync;
window.openRenameWordModal   = openRenameWordModal;
window.closeRenameWordModal  = closeRenameWordModal;
window.saveRenameWord        = saveRenameWord;

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

// Rename Word Modal button listeners
document.getElementById("renameWordSaveBtn").addEventListener("click", saveRenameWord);
document.getElementById("renameWordCancelBtn").addEventListener("click", closeRenameWordModal);
document.getElementById("renameWordModal").addEventListener("click", function(e) { if (e.target === this) closeRenameWordModal(); });
document.getElementById("renameWordInput").addEventListener("keydown", e => { if (e.key === "Enter") saveRenameWord(); if (e.key === "Escape") closeRenameWordModal(); });

document.getElementById("searchInput").addEventListener("input", function() {
  state.search = this.value;
  const clearBtn = document.getElementById("searchClearBtn");
  if (clearBtn) clearBtn.style.display = this.value ? "flex" : "none";
  render();
});

// Part 4: Search clear button handler
window.__vcabClearSearch = function() {
  state.search = "";
  const inp = document.getElementById("searchInput");
  if (inp) inp.value = "";
  const clearBtn = document.getElementById("searchClearBtn");
  if (clearBtn) clearBtn.style.display = "none";
  render();
};
document.getElementById("sortSelect").addEventListener("change", function() {
  state.sort = this.value;
  saveUIPrefs();
  render();
});
document.getElementById("filterSelect").addEventListener("change", function() {
  state.filter = this.value;
  saveUIPrefs();
  render();
});

// ── PART 5: Restore persisted UI state ────────────────────────
(function restoreUIPrefs() {
  const sortEl   = document.getElementById("sortSelect");
  const filterEl = document.getElementById("filterSelect");
  if (sortEl   && state.sort)   sortEl.value   = state.sort;
  if (filterEl && state.filter) filterEl.value = state.filter;
})();

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

document.getElementById("deleteCancelBtn").addEventListener("click", closeDeleteModal);
document.getElementById("deleteConfirmBtn").addEventListener("click", () => {
  if (_deleteCallback) _deleteCallback();
});
document.getElementById("deleteModal").addEventListener("click", function(e) {
  if (e.target === this) closeDeleteModal();
});
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape" && document.getElementById("deleteModal").classList.contains("open")) {
    closeDeleteModal();
  }
});

// ── Startup sequence ───────────────────────────────────────────
// 1. Render from localWords immediately (app is usable at once).
// 2. Set initial online state OPTIMISTICALLY — assume online if navigator.onLine
//    is true, so the UI never flickers to offline before the first ping returns.
// 3. Kick off ping with extended cold-start timeout in the background.
// 4. fetchWords runs in parallel and will populate from server when ping succeeds.
setView(state.view);
if (state.localWords.length > 0) {
  state.words = buildDeduplicatedWords(state.localWords);
  render();
  updateStats();
} else {
  showLoadingState();
}

// Optimistic startup: if navigator.onLine and we have an API, assume online
// immediately so the UI starts in Online state without waiting for the ping.
// The ping will correct this if the API is actually unreachable.
if (!ENV.isFile && navigator.onLine && API) {
  setOfflineMode(false);
}

updateOnlineStatus(false, true).then(() => fetchWords());