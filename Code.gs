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

      if (!displayWord || !def) {
        throw new Error("Missing word or definition");
      }

      const word = normalize(displayWord);
      const data = getAllWords(sheet);
      const existing = data.find(w => normalize(w.word) === word);

      if (existing) {
        const exists = existing.entries.some(e => normalize(e.def) === normalize(def));

        if (!exists) {
          existing.entries.push({
            id: Date.now().toString(),
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
          entries: [{
            id: Date.now().toString(),
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

    return jsonResponse({ ok: true, data: result });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ===== Helpers =====

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["id","word","displayWord","entries","createdAt"]);
  }

  return sheet;
}

function getAllWords(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  return rows.slice(1).map(r => ({
    id: String(r[0]),
    word: r[1],
    displayWord: r[2],
    entries: safeParse(r[3]),
    createdAt: r[4]
  }));
}

function updateRow(sheet, wordObj) {
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (
      String(rows[i][0]) === String(wordObj.id) ||
      normalize(rows[i][1]) === normalize(wordObj.word)
    ) {
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(wordObj.entries));
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