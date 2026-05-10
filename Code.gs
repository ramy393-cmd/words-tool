function doGet(e) {
  const action = (e.parameter.action || "GET").toUpperCase();

  let payload = {};
  try {
    payload = JSON.parse(e.parameter.payload || "{}");
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON payload" });
  }

  const sheet = getSheet();

  try {
    let result;

    if (action === "GET") {
      result = getAllWords(sheet);
    }

    else if (action === "ADD") {
      const displayWord = (payload.displayWord || "").trim();
      const def = (payload.def || "").trim();
      const ex = (payload.ex || "").trim();

      if (!displayWord) {
        throw new Error("Missing word");
      }

      const word = normalize(displayWord);
      const data = getAllWords(sheet);
      const existing = data.find(w => w.word === word);

      if (existing) {
        const exists = def
          ? existing.entries.some(e => normalize(e.def) === normalize(def))
          : false;

        if (def && !exists) {
          existing.entries.push({
            id: Date.now().toString() + "_" + Math.random().toString(36).slice(2),
            def,
            ex
          });
          updateRow(sheet, existing);
        }

        result = existing;

      } else {
        const newWord = {
          id: Date.now().toString(),
          word,
          displayWord,
          entries: def ? [{
            id: Date.now().toString() + "_" + Math.random().toString(36).slice(2),
            def,
            ex
          }] : [],
          createdAt: new Date().toISOString()
        };

        sheet.appendRow([
          newWord.id,
          newWord.word,
          newWord.displayWord,
          JSON.stringify(newWord.entries),
          newWord.createdAt
        ]);

        result = newWord;
      }
    }

    else if (action === "UPDATE") {
      // Update an existing entry's def/ex by wordId + entryId
      const wordId  = String(payload.id      || "");
      const entryId = String(payload.entryId || "");
      const def     = (payload.def || "").trim();
      const ex      = (payload.ex  || "").trim();

      if (!wordId || !entryId) throw new Error("Missing id or entryId");
      if (!def)                throw new Error("Definition cannot be empty");

      const data     = getAllWords(sheet);
      const existing = data.find(w => String(w.id) === wordId);
      if (!existing) throw new Error("Word not found");

      const entry = (existing.entries || []).find(e => String(e.id) === entryId);
      if (!entry) throw new Error("Entry not found");

      entry.def = def;
      entry.ex  = ex;

      updateRow(sheet, existing);
      result = existing;
    }

    else if (action === "RENAME_WORD") {
      // Rename the word text itself; preserve all entries
      const wordId     = String(payload.id          || "");
      const newDisplay = (payload.displayWord || "").trim();

      if (!wordId)     throw new Error("Missing id");
      if (!newDisplay) throw new Error("Missing displayWord");

      const data     = getAllWords(sheet);
      const existing = data.find(w => String(w.id) === wordId);
      if (!existing) throw new Error("Word not found");

      // Duplicate check on server side
      const newNorm  = normalize(newDisplay);
      const duplicate = data.find(w => String(w.id) !== wordId && normalize(w.displayWord) === newNorm);
      if (duplicate) throw new Error("A word with that name already exists");

      existing.displayWord = newDisplay;
      existing.word        = newNorm;

      updateRenameRow(sheet, existing);
      result = existing;
    }

    else if (action === "DELETE_ENTRY") {
      const wordId  = String(payload.wordId  || "");
      const entryId = String(payload.entryId || "");

      if (!wordId || !entryId) {
        throw new Error("Missing wordId or entryId");
      }

      const data     = getAllWords(sheet);
      const existing = data.find(w => String(w.id) === wordId);

      if (!existing) {
        throw new Error("Word not found");
      }

      existing.entries = (existing.entries || []).filter(
        e => String(e.id) !== entryId
      );

      updateRow(sheet, existing);
      result = existing;
    }

    else if (action === "DELETE") {
      deleteRow(sheet, payload.id);
      result = true;
    }

    else if (action === "PING") {
      result = { pong: true };
    }

    else {
      throw new Error("Unknown action: " + action);
    }

    return jsonResponse({ ok: true, data: result });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ===== Helpers =====

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["id", "word", "displayWord", "entries", "createdAt"]);
  }

  return sheet;
}

function getAllWords(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  return rows.slice(1).map(r => ({
    id:          String(r[0]),
    word:        r[1],
    displayWord: r[2],
    entries:     safeParse(r[3]),
    createdAt:   r[4]
  }));
}

function updateRow(sheet, wordObj) {
  // Updates the entries column (col 4) only
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(wordObj.id)) {
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(wordObj.entries));
      return;
    }
  }
}

function updateRenameRow(sheet, wordObj) {
  // Updates word (col 2), displayWord (col 3), and entries (col 4)
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(wordObj.id)) {
      sheet.getRange(i + 1, 2).setValue(wordObj.word);
      sheet.getRange(i + 1, 3).setValue(wordObj.displayWord);
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(wordObj.entries));
      return;
    }
  }
}

function deleteRow(sheet, id) {
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, " ");
}

function safeParse(val) {
  try {
    return JSON.parse(val || "[]");
  } catch {
    return [];
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
