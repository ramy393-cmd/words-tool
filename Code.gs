// ============================================================
// MBA Vocabulary App — Google Apps Script Backend
// ============================================================

const SHEET_NAME = "Vocabulary";
const HEADERS   = ["id", "word", "displayWord", "entries", "createdAt", "updatedAt"];

// ── Helpers ──────────────────────────────────────────────────

function getOrCreateSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function normalizeWord(w) {
  return String(w).trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDef(d) {
  return String(d).trim().toLowerCase().replace(/\s+/g, " ");
}

function generateId() {
  return Utilities.getUuid();
}

function now() {
  return new Date().toISOString();
}

function rowToObj(row) {
  return {
    id:          row[0],
    word:        row[1],
    displayWord: row[2],
    entries:     JSON.parse(row[3] || "[]"),
    createdAt:   row[4],
    updatedAt:   row[5]
  };
}

function getAllRows(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1).map(rowToObj);
}

function findRowIndex(sheet, normalizedWord) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === normalizedWord) return i + 1; // 1-based
  }
  return -1;
}

function writeRow(sheet, rowNum, obj) {
  sheet.getRange(rowNum, 1, 1, HEADERS.length).setValues([[
    obj.id,
    obj.word,
    obj.displayWord,
    JSON.stringify(obj.entries),
    obj.createdAt,
    obj.updatedAt
  ]]);
}

// ── CORS Response ────────────────────────────────────────────

function respond(data, status) {
  const payload = JSON.stringify({ status: status || "ok", data });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function respondError(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "error", message: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET ──────────────────────────────────────────────────────

function doGet(e) {
  try {
    const sheet = getOrCreateSheet();
    const rows  = getAllRows(sheet);
    // newest first by default
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return respond(rows);
  } catch (err) {
    return respondError(err.message);
  }
}

// ── POST ─────────────────────────────────────────────────────

function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action;
    const sheet  = getOrCreateSheet();

    if (action === "ADD")    return handleAdd(sheet, body);
    if (action === "UPDATE") return handleUpdate(sheet, body);
    if (action === "DELETE") return handleDelete(sheet, body);

    return respondError("Unknown action: " + action);
  } catch (err) {
    return respondError(err.message);
  }
}

// ── ADD ──────────────────────────────────────────────────────

function handleAdd(sheet, body) {
  const { displayWord, def, ex } = body;
  if (!displayWord || !def) return respondError("word and def are required");

  const normWord = normalizeWord(displayWord);
  const normDef  = normalizeDef(def);
  const newEntry = { def: def.trim(), ex: (ex || "").trim(), id: generateId() };

  const rowNum = findRowIndex(sheet, normWord);

  if (rowNum === -1) {
    // New word
    const obj = {
      id:          generateId(),
      word:        normWord,
      displayWord: displayWord.trim(),
      entries:     [newEntry],
      createdAt:   now(),
      updatedAt:   now()
    };
    sheet.appendRow([
      obj.id, obj.word, obj.displayWord,
      JSON.stringify(obj.entries),
      obj.createdAt, obj.updatedAt
    ]);
    return respond(obj);
  } else {
    // Existing word — merge definition
    const data  = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const obj   = rowToObj(data);

    // Duplicate definition check
    const isDup = obj.entries.some(e => normalizeDef(e.def) === normDef);
    if (isDup) return respondError("DUPLICATE_DEF");

    obj.entries.push(newEntry);
    obj.updatedAt = now();
    writeRow(sheet, rowNum, obj);
    return respond(obj);
  }
}

// ── UPDATE ───────────────────────────────────────────────────

function handleUpdate(sheet, body) {
  const { wordId, entryId, def, ex } = body;
  if (!wordId || !entryId) return respondError("wordId and entryId required");

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === wordId) {
      const obj = rowToObj(data[i]);
      const idx = obj.entries.findIndex(e => e.id === entryId);
      if (idx === -1) return respondError("Entry not found");

      if (def !== undefined) obj.entries[idx].def = def.trim();
      if (ex  !== undefined) obj.entries[idx].ex  = ex.trim();
      obj.updatedAt = now();
      writeRow(sheet, i + 1, obj);
      return respond(obj);
    }
  }
  return respondError("Word not found");
}

// ── DELETE ───────────────────────────────────────────────────

function handleDelete(sheet, body) {
  const { wordId } = body;
  if (!wordId) return respondError("wordId required");

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === wordId) {
      sheet.deleteRow(i + 1);
      return respond({ deleted: wordId });
    }
  }
  return respondError("Word not found");
}
