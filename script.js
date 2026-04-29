"use strict";

const API_URL = window.APPS_SCRIPT_URL;

let state = {
  words: []
};

// ================= API =================
async function apiCall(data) {
  const formData = new FormData();
  for (const key in data) formData.append(key, data[key]);

  const res = await fetch(API_URL, {
    method: "POST",
    body: formData
  });

  const json = await res.json();
  return json.data;
}

// ================= FETCH =================
async function fetchWords() {
  const data = await apiCall({ action: "GET" });
  state.words = data;
  render();
}

// ================= ADD =================
async function addWord() {
  const word = document.getElementById("wordInput").value.trim();
  const def = document.getElementById("defInput").value.trim();
  const ex = document.getElementById("exInput").value.trim();

  if (!word || !def) return;

  const result = await apiCall({
    action: "ADD",
    displayWord: word,
    def,
    ex
  });

  const idx = state.words.findIndex(w => w.id === result.id);
  if (idx >= 0) state.words[idx] = result;
  else state.words.unshift(result);

  document.getElementById("wordInput").value = "";
  document.getElementById("defInput").value = "";
  document.getElementById("exInput").value = "";

  render();
}

// ================= DELETE =================
async function deleteWord(id) {
  await apiCall({ action: "DELETE", id });
  state.words = state.words.filter(w => w.id !== id);
  render();
}

// ================= RENDER =================
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
            <small style="color:gold">${e.ex || ""}</small>
          </div>
        `).join("")}
      </td>
      <td>
        <button onclick="deleteWord('${w.id}')">Delete</button>
      </td>
    </tr>
  `).join("");
}

// ================= INIT =================
document.getElementById("addBtn").addEventListener("click", addWord);

fetchWords();