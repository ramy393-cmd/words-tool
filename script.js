"use strict";

const API = window.APPS_SCRIPT_URL;

if (!API) {
  alert("API URL missing. Set window.APPS_SCRIPT_URL in index.html");
}

// ===== STATE =====
let state = {
  words: [],
  queue: JSON.parse(localStorage.getItem("queue") || "[]"),
};

// ===== STORAGE =====
function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
}

// ===== API (🔥 FIXED) =====
async function api(action, payload = {}) {
  const params = new URLSearchParams({
    action: action,
    payload: JSON.stringify(payload), // 🔥 أهم سطر
    t: Date.now(),
  });

  const url = API + "?" + params.toString();

  try {
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "API error");
    }

    return json.data;
  } catch (err) {
    console.error("API ERROR:", err);
    throw err;
  }
}

// ===== FETCH =====
async function fetchWords() {
  try {
    const data = await api("GET");
    state.words = data.reverse();
    render();
  } catch (err) {
    console.error("Fetch failed", err);
  }
}

// ===== ADD =====
async function addWord() {
  const word = document.getElementById("wordInput").value.trim();
  const def = document.getElementById("defInput").value.trim();
  const ex = document.getElementById("exInput").value.trim();

  if (!word || !def) return;

  try {
    const result = await api("ADD", {
      displayWord: word,
      def: def,
      ex: ex,
    });

    const idx = state.words.findIndex(w => w.id === result.id);

    if (idx >= 0) state.words[idx] = result;
    else state.words.unshift(result);

  } catch (err) {
    // offline fallback
    state.queue.push({ displayWord: word, def, ex });
    saveQueue();
  }

  document.getElementById("wordInput").value = "";
  document.getElementById("defInput").value = "";
  document.getElementById("exInput").value = "";

  render();
}

// ===== SYNC =====
async function syncQueue() {
  if (!state.queue.length) return;

  const pending = [...state.queue];
  state.queue = [];

  for (const item of pending) {
    try {
      await api("ADD", item);
    } catch {
      state.queue.push(item);
    }
  }

  saveQueue();
}

// ===== DELETE =====
async function deleteWord(id) {
  try {
    await api("DELETE", { id });
    state.words = state.words.filter(w => w.id !== id);
    render();
  } catch (err) {
    console.error("Delete failed", err);
  }
}

// ===== TTS =====
function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.speak(u);
}

// ===== RENDER =====
function render() {
  const table = document.getElementById("tableBody");

  if (!state.words.length) {
    table.innerHTML = `<tr><td colspan="3">No data</td></tr>`;
    return;
  }

  table.innerHTML = state.words.map(w => `
    <tr>
      <td>${w.displayWord}</td>
      <td>
        ${w.entries.map(e => `
          <div>
            ${e.def}<br>
            <small style="color:#c9a94d">${e.ex || ""}</small>
          </div>
        `).join("")}
      </td>
      <td>
        <button onclick="speak('${w.displayWord}')">🔊</button>
        <button onclick="deleteWord('${w.id}')">🗑</button>
      </td>
    </tr>
  `).join("");
}

// ===== INIT =====
document.getElementById("addBtn").addEventListener("click", addWord);

fetchWords();
syncQueue();