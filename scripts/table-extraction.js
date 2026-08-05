'use strict';
// ============================================================
// table-extraction.js  —  drop-in module (two parts)
//
//   PART A → belongs in  ingest-protocols.js   (capture PMC tables)
//   PART B → belongs in  extract-injection-data.js (mine table rows
//            + reversed-order running-text coords + simplex synonyms)
//
// WHY: PMC <table-wrap> markup is the single cleanest coordinate
// source in these papers — one row = structure + AP + ML + DV +
// volume + n, already tabulated by the authors. The current pipeline
// runs stripTags() over it, flattening rows into number-soup and
// producing MIS-ATTRIBUTED coordinates (the Crus I/II → "simplex"
// bug in PMC6695568). This module keeps tables structured.
//
// Integration anchors are marked "▶ INTEGRATE" throughout.
// ============================================================


// ════════════════════════════════════════════════════════════
// PART A — INGEST SIDE  (add to ingest-protocols.js)
// ════════════════════════════════════════════════════════════
//
// ▶ INTEGRATE A1: paste parsePMCTables() next to parsePMCSections().
// ▶ INTEGRATE A2: inside parsePMCSections()'s return object, add:
//        tables: parsePMCTables(body),
//    (where `body` is the <body>…</body> XML string it already has).
// ▶ INTEGRATE A3: in the paper object you store per PMID, carry the
//    field through:   tables: sections.tables || []
//
// Result: each Track-A paper gains a `tables` array:
//   [{ label, caption, headers: [...], rows: [[...], ...] }]

/**
 * Parse every <table-wrap> in a PMC body into structured rows.
 * Handles rowspan carry-forward (grouping columns like "Hippocampus"
 * that span several sub-rows) and colspan expansion. Header row is
 * whichever row lives in <thead>, else the first row.
 *
 * @param {string} bodyXml - the <body>…</body> section of the PMC XML
 * @returns {Array<{label:string,caption:string,headers:string[],rows:string[][]}>}
 */
function parsePMCTables(bodyXml) {
  if (!bodyXml) return [];
  const strip = (x) =>
    (x || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x?[0-9a-fA-F]+;/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const out = [];
  const wraps = bodyXml.match(/<table-wrap\b[\s\S]*?<\/table-wrap>/gi) || [];

  for (const wrap of wraps) {
    const label = strip(wrap.match(/<label[^>]*>([\s\S]*?)<\/label>/i)?.[1] || '');
    const caption = strip(wrap.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || '');

    // Footnotes / <table-wrap-foot> often hold "relative to bregma" — keep it.
    const foot = strip(wrap.match(/<table-wrap-foot[^>]*>([\s\S]*?)<\/table-wrap-foot>/i)?.[1] || '');
    const captionFull = [caption, foot].filter(Boolean).join(' ');

    const tableXml = wrap.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!tableXml) continue;

    // Collect rows in document order (thead + tbody).
    const rowXmls = tableXml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    const grid = [];                 // string[][]
    const pending = {};              // colIndex -> { value, rowsLeft }

    for (const rowXml of rowXmls) {
      const cellXmls = rowXml.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) || [];
      const row = [];
      let col = 0;

      const placeCarry = () => {
        while (pending[col] && pending[col].rowsLeft > 0) {
          row[col] = pending[col].value;
          pending[col].rowsLeft -= 1;
          if (pending[col].rowsLeft === 0) delete pending[col];
          col += 1;
        }
      };

      placeCarry(); // fill any columns still spanning from a previous row
      for (const cellXml of cellXmls) {
        const rowspan = parseInt(cellXml.match(/rowspan\s*=\s*["']?(\d+)/i)?.[1] || '1', 10);
        const colspan = parseInt(cellXml.match(/colspan\s*=\s*["']?(\d+)/i)?.[1] || '1', 10);
        const text = strip(cellXml.replace(/^<t[hd][^>]*>/i, '').replace(/<\/t[hd]>$/i, ''));

        for (let c = 0; c < colspan; c++) {
          row[col] = text;
          if (rowspan > 1) pending[col] = { value: text, rowsLeft: rowspan - 1 };
          col += 1;
          placeCarry();
        }
      }
      grid.push(row.map((c) => c ?? ''));
    }

    if (!grid.length) continue;

    // Header = row inside <thead> if present, else first row.
    const theadXml = tableXml.match(/<thead\b[\s\S]*?<\/thead>/i)?.[0] || '';
    const theadRowCount = (theadXml.match(/<tr\b/gi) || []).length;
    const headerIdx = theadRowCount > 0 ? theadRowCount - 1 : 0;

    out.push({
      label,
      caption: captionFull,
      headers: grid[headerIdx] || grid[0],
      rows: grid.slice(headerIdx + 1),
    });
  }

  return out;
}


// ════════════════════════════════════════════════════════════
// PART B — EXTRACT SIDE  (add to extract-injection-data.js)
// ════════════════════════════════════════════════════════════

// ── B1 · SIMPLEX + hyphenated-axis synonyms ─────────────────
// ▶ INTEGRATE B1: merge these into your CCF region synonym /
//   CATEGORY_SEARCH_TERMS map. Simplex is a real CCF structure
//   (acronym SIM, "Simplex lobule") but papers spell it many ways.
const SIMPLEX_SYNONYMS = {
  SIM: ['simplex', 'simple lobule', 'lobule simplex', 'lobulus simplex', 'HVI', 'lobule VI'],
};

// ── B2 · Reversed-order running-text coordinate extractor ────
// Catches "(−6.25 mm anterior-posterior, 1.9 mm medial-lateral,
// measured from bregma) at a depth of 1.2 mm" — value→axis order
// with hyphenated axis words, which the axis→value extractor misses.
//
// ▶ INTEGRATE B2: call extractReversedCoordSets(sentence) inside
//   extractCoordinateSets() and merge its results with the existing
//   axis→value matches (dedupe on ap+ml+dv).

const AP_WORDS = 'anterior[\\s-]*posterior|antero[\\s-]*posterior|anteroposterior|\\bA[\\s\\/]?P\\b|rostro[\\s-]*caudal';
const ML_WORDS = 'medial[\\s-]*lateral|medio[\\s-]*lateral|mediolateral|\\bM[\\s\\/]?L\\b|lateral';
const DV_WORDS = 'dorsal[\\s-]*ventral|dorso[\\s-]*ventral|dorsoventral|\\bD[\\s\\/]?V\\b|ventral|depth';

const VAL = '([+-−]?\\d+(?:\\.\\d+)?)';

const REV_AP = new RegExp(`${VAL}\\s*mm[\\s,]+(?:${AP_WORDS})`, 'i');
const REV_ML = new RegExp(`${VAL}\\s*mm[\\s,]+(?:${ML_WORDS})`, 'i');
const REV_DV = new RegExp(`${VAL}\\s*mm[\\s,]+(?:${DV_WORDS})`, 'i');
// "at a depth of 1.2 mm" — depth stated in a separate clause.
const DEPTH_CLAUSE = /(?:at\s+a\s+)?depth\s+of\s+([+-−]?\d+(?:\.\d+)?)\s*mm/i;

function normNum(s) {
  return s == null ? null : parseFloat(String(s).replace('−', '-'));
}

/**
 * Extract a coordinate triple from value→axis phrasing.
 * @returns {{ap:number,ml:number,dv:number,reference_point:string,source:string}|null}
 */
function extractReversedCoordSets(sentence) {
  const ap = normNum(sentence.match(REV_AP)?.[1]);
  const ml = normNum(sentence.match(REV_ML)?.[1]);
  let dv = normNum(sentence.match(REV_DV)?.[1]);
  if (dv == null) dv = normNum(sentence.match(DEPTH_CLAUSE)?.[1]);

  // Require at least AP+ML to trust it as a stereotaxic triple.
  if (ap == null || ml == null) return null;

  const reference_point = /\blambda\b/i.test(sentence)
    ? 'lambda'
    : /\bbregma\b/i.test(sentence)
    ? 'bregma'
    : 'unknown';

  return { ap, ml, dv, reference_point, source: 'text-reversed' };
}


// ── B3 · Table-row coordinate extractor ─────────────────────
// ▶ INTEGRATE B3: after building each PMID record, if the paper
//   has `tables`, run:
//       extractTableCoordinates(paper.tables).forEach(c => rec.coordinates.push(c));
//   These are HIGHER confidence than regex hits — they carry
//   source:'table' so the RAG/LLM can trust and prefer them.

const HDR_AP = new RegExp(`\\bAP\\b|antero|anterior[\\s-]*posterior|rostro`, 'i');
const HDR_ML = new RegExp(`\\bML\\b|medio|medial[\\s-]*lateral|lateral`, 'i');
const HDR_DV = new RegExp(`\\bDV\\b|dorso|dorsal[\\s-]*ventral|ventral|depth`, 'i');
const HDR_VOL = /volume|\bvol\b|µl|ul|nl/i;
const HDR_N = /^n$|number\s+of\s+animals|\banimals?\b/i;

// A coordinate cell: a signed number, or a range like "1.7–1.07",
// or "±1.5". Captures the first numeric token for the value.
const COORD_CELL = /[+-−±]?\d+(?:\.\d+)?(?:\s*[–—-]\s*[+-−]?\d+(?:\.\d+)?)?/;

function cellNum(cell) {
  if (cell == null) return null;
  const m = String(cell).replace('−', '-').match(/[+-]?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Find the column index whose header matches a given regex.
 * Returns -1 if none match.
 */
function findCol(headers, re) {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(headers[i] || '')) return i;
  }
  return -1;
}

/**
 * Extract one coordinate record per data row of every coordinate
 * table (a table whose header row contains AP + ML columns).
 *
 * The STRUCTURE column is inferred as the first text column that is
 * NOT a coordinate/volume/n column. Rowspan carry-forward (done in
 * parsePMCTables) means grouping labels like "Cerebellum" are already
 * filled into each sub-row, so structure attribution stays correct.
 *
 * @param {Array} tables - the paper.tables array from parsePMCTables
 * @returns {Array<{region:string,ap:number,ml:number,dv:number,
 *                  volume_raw:?string,n:?number,reference_point:string,
 *                  source:string,table_label:string}>}
 */
function extractTableCoordinates(tables) {
  const results = [];
  if (!Array.isArray(tables)) return results;

  for (const t of tables) {
    const headers = t.headers || [];
    const apCol = findCol(headers, HDR_AP);
    const mlCol = findCol(headers, HDR_ML);
    if (apCol === -1 || mlCol === -1) continue; // not a coordinate table

    const dvCol = findCol(headers, HDR_DV);
    const volCol = findCol(headers, HDR_VOL);
    const nCol = findCol(headers, HDR_N);

    // Structure column = first column that isn't a numeric/meta column.
    const numericCols = new Set([apCol, mlCol, dvCol, volCol, nCol].filter((c) => c >= 0));
    let structCol = -1;
    for (let i = 0; i < headers.length; i++) {
      if (!numericCols.has(i)) { structCol = i; break; }
    }

    // Reference point from caption/footnote (default bregma if stated).
    const cap = (t.caption || '').toLowerCase();
    const reference_point = /\blambda\b/.test(cap)
      ? 'lambda'
      : /\bbregma\b/.test(cap)
      ? 'bregma'
      : 'unknown';

    for (const row of t.rows) {
      const apCell = row[apCol];
      const mlCell = row[mlCol];
      // Skip rows without a real coordinate value (sub-headers, notes).
      if (!apCell || !COORD_CELL.test(apCell)) continue;
      if (!mlCell || !COORD_CELL.test(mlCell)) continue;

      const ap = cellNum(apCell);
      const ml = cellNum(mlCell);
      if (ap == null || ml == null) continue;

      // Prefer the row's own structure cell; fall back to the group
      // column (structCol) which rowspan carry-forward has filled.
      let region = structCol >= 0 ? (row[structCol] || '').trim() : '';
      // If a second descriptive column exists (e.g. "Cerebellum | Crus I/II"),
      // append it so we get "Cerebellum — Crus I/II" not just "Cerebellum".
      if (structCol >= 0) {
        for (let i = structCol + 1; i < row.length; i++) {
          if (numericCols.has(i)) continue;
          const extra = (row[i] || '').trim();
          if (extra && extra.toLowerCase() !== region.toLowerCase()) {
            region = region ? `${region} — ${extra}` : extra;
          }
          break;
        }
      }

      results.push({
        region: region || 'unspecified',
        ap,
        ml,
        dv: dvCol >= 0 ? cellNum(row[dvCol]) : null,
        volume_raw: volCol >= 0 ? (row[volCol] || null) : null,
        n: nCol >= 0 ? cellNum(row[nCol]) : null,
        reference_point,
        source: 'table',
        table_label: t.label || '',
      });
    }
  }

  return results;
}


// ── Exports (CommonJS — matches the pipeline's require() style) ──
module.exports = {
  parsePMCTables,
  extractReversedCoordSets,
  extractTableCoordinates,
  SIMPLEX_SYNONYMS,
};
