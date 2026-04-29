function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const action = e.parameter.action;

  const sheet = getSheet();

  if (action === "GET") {
    return jsonResponse({ status: "ok", data: getAllWords(sheet) });
  }

  if (action === "ADD") {
    const displayWord = e.parameter.displayWord;
    const def = e.parameter.def;
    const ex = e.parameter.ex || "";

    const word = normalize(displayWord);

    let data = getAllWords(sheet);
    let existing = data.find(w => w.word === word);

    if (existing) {
      const exists = existing.entries.some(e => normalize(e.def) === normalize(def));
      if (!exists) {
        existing.entries.push({ def, ex });
        updateRow(sheet, existing);
      }
      return jsonResponse({ status: "ok", data: existing });
    }

    const newWord = {
      id: Date.now().toString(),
      word,
      displayWord,
      entries: [{ def, ex }],
      createdAt: new Date().toISOString()
    };

    sheet.appendRow([
      newWord.id,
      newWord.word,
      newWord.displayWord,
      JSON.stringify(newWord.entries),
      newWord.createdAt
    ]);

    return jsonResponse({ status: "ok", data: newWord });
  }

  if (action === "DELETE") {
    const id = e.parameter.id;
    deleteRow(sheet, id);
    return jsonResponse({ status: "ok" });
  }

  return jsonResponse({ status: "error", message: "Invalid action" });
}

// ================= HELPERS =================

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];

  if (sheet.getLastRow() === 0) {
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

function updateRow(sheet, wordObj) {
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === wordObj.id) {
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(wordObj.entries));
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

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, " ");
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}