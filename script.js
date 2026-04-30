"use strict";

// ═══════════════════════════════════════════════════════════
//  MBA Vocabulary — script.js
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

  // Edit mode: when set, "Add Word" becomes "Update"
  editMode:    false,
  editWordId:  null,   // word.id being edited
  editEntryId: null,   // entry.id being edited
};

// ═══════════════════════════════════════════════════════════
//  QUEUE PERSISTENCE
// ═══════════════════════════════════════════════════════════

function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
}

// ═══════════════════════════════════════════════════════════
//  API  (GET-tunneling — no CORS issues)
// ═══════════════════════════════════════════════════════════

async function api(action, payload = {}) {
  const params = new URLSearchParams({
    action:  action,
    payload: JSON.stringify(payload),
    t:       Date.now(),   // cache-bust
  });

  const url = API + "?" + params.toString();

  const res  = await fetch(url);

  // Guard: non-200 HTTP is an infrastructure error
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
    state.words = data.reverse();   // newest first
    render();
  } catch (err) {
    console.error("Fetch failed:", err);
    document.getElementById("tableBody").innerHTML =
      `<tr><td colspan="3" style="text-align:center;color:#f06565;padding:24px">
         Failed to load. Check your connection.
       </td></tr>`;
  }
}

// ═══════════════════════════════════════════════════════════
//  ADD  (unchanged from working baseline)
// ═══════════════════════════════════════════════════════════

async function addWord() {
  const wordEl = document.getElementById("wordInput");
  const defEl  = document.getElementById("defInput");
  const exEl   = document.getElementById("exInput");
  const addBtn = document.getElementById("addBtn");

  const word = wordEl.value.trim();
  const def  = defEl.value.trim();
  const ex   = exEl.value.trim();

  if (!word || !def) return;

  // ── EDIT MODE: route to updateWord instead ───────────────
  if (state.editMode) {
    await updateWord(word, def, ex);
    return;
  }

  // ── ADD MODE ─────────────────────────────────────────────
  addBtn.disabled    = true;
  addBtn.textContent = "Saving…";

  try {
    const result = await api("ADD", { displayWord: word, def, ex });

    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;
    else          state.words.unshift(result);

  } catch (err) {
    // Offline fallback — queue it
    state.queue.push({ displayWord: word, def, ex });
    saveQueue();
    console.warn("Queued for sync:", word);
  }

  wordEl.value = defEl.value = exEl.value = "";
  addBtn.disabled    = false;
  addBtn.textContent = "Add Word";

  render();
}

// ═══════════════════════════════════════════════════════════
//  EDIT  — new feature
// ═══════════════════════════════════════════════════════════

/**
 * Called from the ✏️ button in a rendered row.
 * Populates the form fields and switches the button to "Update".
 */
function startEdit(wordId, entryId) {
  const word  = state.words.find(w => w.id === wordId);
  const entry = word?.entries.find(e => e.id === entryId);
  if (!word || !entry) return;

  // Fill the input panel
  document.getElementById("wordInput").value = word.displayWord;
  document.getElementById("defInput").value  = entry.def;
  document.getElementById("exInput").value   = entry.ex || "";

  // Switch to edit mode
  state.editMode    = true;
  state.editWordId  = wordId;
  state.editEntryId = entryId;

  // Change button label + style
  const addBtn = document.getElementById("addBtn");
  addBtn.textContent = "Update Word";
  addBtn.style.background = "#5b8dee";
  addBtn.style.borderColor = "#5b8dee";

  // Scroll to form
  document.querySelector(".input-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Submits an UPDATE to the backend and resets the form.
 */
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

    // Replace the updated word in local state
    const idx = state.words.findIndex(w => w.id === result.id);
    if (idx >= 0) state.words[idx] = result;

  } catch (err) {
    console.error("Update failed:", err);
    alert("Update failed: " + err.message);
  }

  // Always reset form regardless of success/failure
  cancelEdit();
}

/** Resets the form back to ADD mode. */
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

  render();
}

// ═══════════════════════════════════════════════════════════
//  DELETE  — fixed
// ═══════════════════════════════════════════════════════════

async function deleteWord(id) {
  try {
    // FIX: the previous version passed id as-is; the real failure was in the
    // backend (type mismatch). Belt-and-suspenders: send as string here too.
    await api("DELETE", { id: String(id) });

    // Remove from local state immediately — don't wait for a re-fetch
    state.words = state.words.filter(w => String(w.id) !== String(id));

    // If we were editing this word, reset the form
    if (state.editWordId === id) cancelEdit();

    render();
  } catch (err) {
    console.error("Delete failed:", err);
    alert("Delete failed: " + err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  OFFLINE SYNC  (unchanged from working baseline)
// ═══════════════════════════════════════════════════════════

async function syncQueue() {
  if (!state.queue.length) return;

  const pending  = [...state.queue];
  state.queue    = [];

  for (const item of pending) {
    try {
      const result = await api("ADD", item);
      const idx    = state.words.findIndex(w => w.id === result.id);
      if (idx >= 0) state.words[idx] = result;
      else          state.words.unshift(result);
    } catch {
      state.queue.push(item);  // re-queue on failure
    }
  }

  saveQueue();
  render();
}

// ═══════════════════════════════════════════════════════════
//  SPEECH  (unchanged)
// ═══════════════════════════════════════════════════════════

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u  = new SpeechSynthesisUtterance(text);
  u.lang   = "en-US";
  speechSynthesis.speak(u);
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════

function render() {
  const table = document.getElementById("tableBody");

  if (!state.words.length) {
    table.innerHTML = `
      <tr>
        <td colspan="3" style="text-align:center;padding:48px;color:#665f52;font-size:0.9rem">
          No words yet. Add your first one above.
        </td>
      </tr>`;
    return;
  }

  table.innerHTML = state.words.map(w => `
    <tr>
      <td class="word-cell">
        <span class="word-text">${escHtml(w.displayWord)}</span>
        ${w.entries.length > 1
          ? `<span class="entry-count-badge">${w.entries.length}</span>`
          : ""}
      </td>

      <td class="def-cell">
        ${w.entries.map((e, i) => `
          <div class="entry-block">
            ${w.entries.length > 1
              ? `<div class="entry-num">Def. ${i + 1}</div>`
              : ""}
            <div class="entry-def">${escHtml(e.def)}</div>
            ${e.ex
              ? `<div class="entry-ex" style="color:#c9a84c;font-size:0.82rem;margin-top:3px">
                   ${escHtml(e.ex)}
                 </div>`
              : ""}
            <!-- Edit button per entry -->
            <button
              class="btn btn-icon edit"
              onclick="startEdit('${escAttr(w.id)}','${escAttr(e.id)}')"
              title="Edit this definition"
              style="margin-top:6px;font-size:0.75rem"
            >✏️ Edit</button>
          </div>
        `).join("")}
      </td>

      <td class="actions-cell">
        <button class="btn btn-icon speak"
          onclick="speak('${escAttr(w.displayWord)}')"
          title="Pronounce">🔊</button>
        <button class="btn btn-icon delete"
          onclick="deleteWord('${escAttr(w.id)}')"
          title="Delete word">🗑</button>
      </td>
    </tr>
  `).join("");
}

// ── Safe HTML escaping (prevents XSS in innerHTML rendering) ─
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// For values injected into onclick="..." attribute strings
function escAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════
//  CANCEL EDIT BUTTON  — injected dynamically when editing
// ═══════════════════════════════════════════════════════════

// Expose cancelEdit globally so inline onclick can reach it
window.cancelEdit = cancelEdit;
window.startEdit  = startEdit;
window.deleteWord = deleteWord;
window.speak      = speak;

// ═══════════════════════════════════════════════════════════
//  EVENT WIRING
// ═══════════════════════════════════════════════════════════

document.getElementById("addBtn").addEventListener("click", addWord);

// Enter key on any input field triggers add/update
["wordInput", "defInput", "exInput"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") addWord();
  });
});

// ── Cancel Edit button (shown only during edit mode) ────────
// We insert it next to the Add button; it removes itself on cancel.
const inputActions = document.querySelector(".input-actions");
const cancelBtn    = document.createElement("button");
cancelBtn.id        = "cancelEditBtn";
cancelBtn.className = "btn btn-ghost";
cancelBtn.textContent = "Cancel";
cancelBtn.style.display = "none";
cancelBtn.addEventListener("click", cancelEdit);
inputActions.appendChild(cancelBtn);

// Show/hide Cancel button when edit mode changes
const _originalStartEdit = startEdit;
// Patch startEdit to also reveal the Cancel button
window.startEdit = function(wordId, entryId) {
  _originalStartEdit(wordId, entryId);
  cancelBtn.style.display = "";
};

const _originalCancelEdit = cancelEdit;
// Patch cancelEdit to also hide the Cancel button
window.cancelEdit = function() {
  _originalCancelEdit();
  cancelBtn.style.display = "none";
};

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

fetchWords();
syncQueue();
