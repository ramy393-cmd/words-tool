function doGet(e) {
  const action = e.parameter.action;
  const payload = JSON.parse(e.parameter.payload || "{}");
  const sheet = getSheet();

  try {
    let result;

    if (action === "GET") {
      result = getAllWords(sheet);
    }

    if (action === "ADD") {
      const displayWord = (payload.displayWord || "").trim();
      const def = (payload.def || "").trim();
      const ex = (payload.ex || "").trim();

      if (!displayWord || !def) throw new Error("Missing data");

      const word = normalize(displayWord);
      const data = getAllWords(sheet);
      let existing = data.find(w => w.word === word);

      if (existing) {
        const exists = existing.entries.some(e => normalize(e.def) === normalize(def));
        if (!exists) {
          existing.entries.push({
            id: generateId(),   // FIX 1: use generateId() instead of Date.now() twice
            def,
            ex
          });
          updateRow(sheet, existing);
        }
        result = existing;
      } else {
        const wordId  = generateId();             // FIX 1: guaranteed unique IDs
        const entryId = generateId();
        const newWord = {
          id: wordId,
          word,
          displayWord,
          entries: [{
            id: entryId,
            def,
            ex
          }],
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

    if (action === "DELETE") {
      deleteRow(sheet, payload.id);
      result = true;
    }

    if (action === "UPDATE") {
      const { id, entryId, def, ex } = payload;
      const data = getAllWords(sheet);
      let word = data.find(w => w.id === id);

      if (!word) throw new Error("Word not found");

      let entry = word.entries.find(e => e.id === entryId);
      if (entry) {
        entry.def = def;
        entry.ex = ex;
        updateRow(sheet, word);
      }

      result = word;
    }

    return jsonResponse({ ok: true, data: result });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ===== Helpers =====

function generateId() {
  // FIX 1: Combines timestamp + random suffix to guarantee uniqueness
  // even when called multiple times in the same millisecond
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  // FIX 2: Check for header by reading first row value, not getLastRow()
  // getLastRow() can return 0 or 1 unreliably on a fresh sheet
  const firstCell = sheet.getRange(1, 1).getValue();
  if (!firstCell || firstCell === "") {
    sheet.appendRow(["id", "word", "displayWord", "entries", "createdAt"]);
  }
  return sheet;
}

function getAllWords(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  return rows.slice(1).map(r => ({
    id: r[0],
    word: r[1],
    displayWord: r[2],
    entries: JSON.parse(r[3] || "[]"),
    createdAt: r[4]
  }));
}

function updateRow(sheet, word) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === word.id) {
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(word.entries));
      return;
    }
  }
}

function deleteRow(sheet, id) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
