// ═══════════════════════════════════════════════════════════
//  MBA Vocabulary — Code.gs  (v2.0)
//  Columns: id | word | displayWord | entries | createdAt | updatedAt
// ═══════════════════════════════════════════════════════════

function doGet(e) {
  // TASK 10 FIX: always uppercase the action to handle any casing from client
  const action = (e.parameter.action || "GET").toUpperCase();

  let payload = {};
  try {
    payload = JSON.parse(e.parameter.payload || "{}");
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON payload" });
  }

  let sheet;
  try {
    sheet = getSheet();
  } catch (err) {
    return jsonResponse({ ok: false, error: "Could not access sheet: " + err.message });
  }

  try {
    let result;

    // ── GET ──────────────────────────────────────────────────
    if (action === "GET") {
      result = getAllWords(sheet);
    }

    // ── ADD ──────────────────────────────────────────────────
    else if (action === "ADD") {
      const displayWord = (payload.displayWord || "").trim();
      const def         = (payload.def || "").trim();
      const ex          = (payload.ex || "").trim();

      if (!displayWord || !def) {
        throw new Error("Missing word or definition");
      }

      const normalized = normalize(displayWord);
      const data       = getAllWords(sheet);
      const existing   = data.find(w => w.word === normalized);

      if (existing) {
        const isDup = existing.entries.some(en => normalize(en.def) === normalize(def));
        if (!isDup) {
          existing.entries.push({ id: generateId(), def, ex });
          updateEntriesAndTimestamp(sheet, existing);
        }
        result = existing;
      } else {
        const now     = new Date().toISOString();
        const newWord = {
          id:          generateId(),
          word:        normalized,
          displayWord,
          entries:     [{ id: generateId(), def, ex }],
          createdAt:   now,
          updatedAt:   now
        };

        sheet.appendRow([
          newWord.id,
          newWord.word,
          newWord.displayWord,
          JSON.stringify(newWord.entries),
          newWord.createdAt,
          newWord.updatedAt
        ]);

        result = newWord;
      }
    }

    // ── UPDATE ───────────────────────────────────────────────
    else if (action === "UPDATE") {
      const id      = String(payload.id || "").trim();
      const entryId = String(payload.entryId || "").trim();
      const def     = (payload.def || "").trim();
      const ex      = (payload.ex  || "").trim();

      if (!id || !entryId || !def) {
        throw new Error("Missing id, entryId, or definition for UPDATE");
      }

      const data = getAllWords(sheet);
      const word = data.find(w => String(w.id) === id);
      if (!word) throw new Error("Word not found: " + id);

      const entry = word.entries.find(en => String(en.id) === entryId);
      if (!entry) throw new Error("Entry not found: " + entryId);

      entry.def = def;
      entry.ex  = ex;

      updateEntriesAndTimestamp(sheet, word);
      result = word;
    }

    // ── DELETE ───────────────────────────────────────────────
    else if (action === "DELETE") {
      const id = String(payload.id || "").trim();
      if (!id) throw new Error("Missing id for DELETE");

      // String() coercion on both sides is critical:
      // Google Sheets returns numeric-looking cell values as JS numbers.
      const deleted = deleteRow(sheet, id);
      if (!deleted) throw new Error("Row not found for id: " + id);

      result = { deleted: true, id };
    }

    else {
      throw new Error("Unknown action: " + action);
    }

    return jsonResponse({ ok: true, data: result });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
//  SHEET HELPERS
// ═══════════════════════════════════════════════════════════

function getSheet() {
  const sheet     = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const firstCell = sheet.getRange(1, 1).getValue();
  if (!firstCell || String(firstCell).trim() === "") {
    sheet.appendRow(["id", "word", "displayWord", "entries", "createdAt", "updatedAt"]);
  }
  return sheet;
}

function getAllWords(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];

  return rows.slice(1)
    .filter(r => r[0] !== "" && r[0] !== null && r[0] !== undefined)
    .map(r => {
      let entries = [];
      try {
        const raw = String(r[3] || "").trim();
        if (raw && raw.startsWith("[")) entries = JSON.parse(raw);
      } catch (_) {
        entries = [];
      }

      return {
        id:          String(r[0]),   // always string — prevents === type mismatch
        word:        String(r[1]),
        displayWord: String(r[2]),
        entries,
        createdAt:   r[4] ? String(r[4]) : "",
        updatedAt:   r[5] ? String(r[5]) : ""
      };
    });
}

function updateEntriesAndTimestamp(sheet, wordObj) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(wordObj.id)) {
      const now = new Date().toISOString();
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(wordObj.entries));
      sheet.getRange(i + 1, 6).setValue(now);
      wordObj.updatedAt = now;
      return true;
    }
  }
  return false;
}

function deleteRow(sheet, id) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, " ");
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
