"use strict";

// CONFIG
const API_URL = window.APPS_SCRIPT_URL;

const CACHE_KEY = "vocab_words";
const QUEUE_KEY = "vocab_queue";

// STATE
let state = {
  words: [],
  queue: [],
  isOnline: navigator.onLine
};

// NORMALIZE
function normalizeWord(w) {
  return String(w).trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizeDef(d) {
  return String(d).trim().toLowerCase().replace(/\s+/g, " ");
}

// API (🔥 FIX — NO POST ANYMORE)
async function apiCall(params) {
  const url = API_URL + "?" + new URLSearchParams(params).toString();

  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);

  const json = await resp.json();
  if (json.status === "error") throw new Error(json.message);

  return json.data;
}

// FETCH WORDS
async function fetchWords() {
  try {
    const data = await apiCall({ action: "GET" });
    state.words = data;
    render();
  } catch (e) {
    console.error(e);
  }
}

// ADD WORD
async function addWord(displayWord, def, ex) {
  const result = await apiCall({
    action: "ADD",
    displayWord,
    def,
    ex
  });

  const idx = state.words.findIndex(w => w.id === result.id);
  if (idx >= 0) state.words[idx] = result;
  else state.words.unshift(result);

  render();
}

// DELETE
async function deleteWord(wordId) {
  await apiCall({ action: "DELETE", wordId });
  state.words = state.words.filter(w => w.id !== wordId);
  render();
}

// UPDATE
async function updateEntry(wordId, entryId, def, ex) {
  const result = await apiCall({
    action: "UPDATE",
    wordId,
    entryId,
    def,
    ex
  });

  const idx = state.words.findIndex(w => w.id === wordId);
  if (idx >= 0) state.words[idx] = result;

  render();
}

// PROMPT
function copyPrompt(word) {
  const text = `Provide a clear, concise definition of the word "${word}" and one practical example, specifically in an MBA or business context. Use professional language and avoid generic explanations.`;

  navigator.clipboard.writeText(text)
    .then(() => alert("Prompt copied"))
    .catch(() => alert("Copy failed"));
}

// RENDER (بسيطة)
function render() {
  console.log(state.words);
}

// INIT
fetchWords();