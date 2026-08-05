/**
 * extract-injection-data.js
 *
 * Post-processes the fetched literature corpora to pull out, per PMID:
 *   - stereotaxic coordinate sets (AP/ML/DV in mm)          §6a
 *   - reference point (bregma / lambda / unknown)            §6b
 *   - injection volume (nL) and virus titer                  §6c
 *   - injected material (AAV, tracer, drug, DREADD, opsin…)
 *   - Allen CCFv3 region cross-references
 *
 * Reads TWO corpus formats:
 *
 *   stereotaxic-protocols.json  — flat array
 *       [{ pmid, pmcid, regions[], methods, results, figure_legends }]
 *
 *   surgical-protocols.json  — TWO possible shapes depending on which
 *       version of ingest-protocols.js produced it:
 *
 *       OLD (region-keyed object):
 *           { "BLA": [{ pmid, title, surgical_methods_summary, raw_abstract_snippet }] }
 *
 *       NEW (flat array, same shape as stereotaxic-protocols.json):
 *           [{ pmid, pmcid, regions[], methods, results, figure_legends }]
 *
 *   toFlatArray() detects and normalises both shapes.
 *
 * Output:
 *   react-app/public/data/injection-coordinates.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const STEREOTAXIC_PATH = path.join(__dirname, '../react-app/public/data/stereotaxic-protocols.json');
const SURGICAL_PATH    = path.join(__dirname, '../react-app/public/data/surgical-protocols.json');
const STRUCTURES_PATH  = path.join(__dirname, '../react-app/public/atlas/ccfv3_structures.json');
const OUT_PATH         = path.join(__dirname, '../react-app/public/data/injection-coordinates.json');

// ── Format normaliser ──────────────────────────────────────────────────────
/**
 * Accept either corpus shape and return a flat array of paper objects
 * that always have: { pmid, pmcid?, regions[], methods?, results?, figure_legends? }
 *
 * OLD shape: { "RegionName": [{ pmid, title, surgical_methods_summary, raw_abstract_snippet }] }
 * NEW shape: [{ pmid, pmcid, regions[], methods, results, figure_legends }]
 */
function toFlatArray(raw) {
  if (Array.isArray(raw)) {
    // Flat array — may contain mixed old + new format records in the same file.
    // Normalise old-format records (surgical_methods_summary) so all downstream
    // code sees a consistent shape with a `methods` field.
    return raw.map(p => {
      if (!p) return p;
      if (p.methods) return p;                          // already new format
      return {
        ...p,
        methods:        [p.surgical_methods_summary, p.raw_abstract_snippet, p.title]
                          .filter(Boolean).join(' ') || null,
        results:        p.results        || null,
        figure_legends: p.figure_legends || null,
      };
    });
  }
  if (raw && typeof raw === 'object') {
    // OLD shape — region-keyed object
    const out = [];
    const seen = new Set();
    for (const [regionName, papers] of Object.entries(raw)) {
      if (!Array.isArray(papers)) continue;
      for (const p of papers) {
        if (!p || !p.pmid) continue;
        const id = String(p.pmid);
        if (seen.has(id)) {
          // already added — just append the region
          const existing = out.find(x => String(x.pmid) === id);
          if (existing) (existing.regions = existing.regions || []).push(regionName);
          continue;
        }
        seen.add(id);
        // Map old field names → unified field names
        out.push({
          pmid:    p.pmid,
          pmcid:   p.pmcid || null,
          regions: [regionName],
          // OLD corpus stored scored sentences in surgical_methods_summary;
          // treat those as the "methods" text for extraction purposes.
          methods: [p.surgical_methods_summary, p.raw_abstract_snippet, p.title]
                     .filter(Boolean).join(' ') || null,
          results:        null,
          figure_legends: null,
        });
      }
    }
    return out;
  }
  return [];
}

// ── Coordinate extraction ──────────────────────────────────────────────────
const AXES = {
  AP: 'AP', anteroposterior: 'AP', posterior: 'AP', anterior: 'AP',
  ML: 'ML', mediolateral: 'ML', lateral: 'ML', medial: 'ML',
  DV: 'DV', dorsoventral: 'DV', ventral: 'DV',
};
const AXIS_PATTERN = Object.keys(AXES).join('|');
const NUM_PATTERN  = '(?:\u00b1\\s?\\d+(?:\\.\\d+)?|[+-]?\\d+(?:\\.\\d+)?(?:\\s*\u00b1\\s*\\d+(?:\\.\\d+)?)?)';

// §6a — expanded DV / depth patterns
const DV_PATTERNS = [
  /(?:DV|dorsoventral|depth)[:\s]+[-\u2212]?([\d.]+)\s*mm/i,
  /(?:ventral|depth) (?:from|to|of)[^.]{0,40}?([\d.]+)\s*mm/i,
  /depth from (?:the )?skull(?: surface)? (?:was|of) ([\d.]+)\s*mm/i,
  /([\d.]+)\s*mm (?:below|ventral to) (?:the )?dura/i,
  /inserted to a depth of ([\d.]+)\s*mm/i,
  /(?:lowered|advanced) ([\d.]+)\s*mm/i,
];

/** §6a — extract DV from a sentence using expanded pattern list */
function extractDV(sentence) {
  for (const pattern of DV_PATTERNS) {
    const m = sentence.match(pattern);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val)) return String(val);
    }
  }
  return null;
}

/** §6b — tag reference landmark from the coordinate-bearing sentence */
function extractReferencePoint(sentence) {
  if (/\blambda\b/i.test(sentence)) return 'lambda';
  if (/\bbregma\b/i.test(sentence)) return 'bregma';
  return 'unknown';
}

function cleanNum(raw) {
  const trimmed = (raw || '').trim();
  const m = trimmed.match(/^(\u00b1\s?\d+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)/);
  return (m ? m[1] : trimmed).replace(/\s+/g, '');
}

function splitSentences(text) {
  return text
    .replace(/(?<!\b(e\.g|i\.e|fig|ref|vs|dr|prof|approx|no|figs))\.\s+(?=[A-Z0-9])/gi, '.\u0001')
    .split('\u0001')
    .map(s => s.trim())
    .filter(Boolean);
}

function extractCoordinateSets(rawText) {
  if (!rawText) return [];
  const normalized = rawText.replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u00b1/g, '±');
  const sentences  = splitSentences(normalized);
  const results    = [];
  const seen       = new Set();

  for (let i = 0; i < sentences.length; i++) {
    const window = [sentences[i - 1], sentences[i], sentences[i + 1]].filter(Boolean).join(' ');
    const found    = {};
    const positions = [];

    const labelFirst = new RegExp(`\\b(${AXIS_PATTERN})\\b[\\s:=]{0,3}(${NUM_PATTERN})\\s*mm`, 'gi');
    const valueFirst = new RegExp(`(${NUM_PATTERN})\\s*mm\\s*(${AXIS_PATTERN})\\b`, 'gi');

    let m;
    while ((m = labelFirst.exec(window))) {
      const axis = AXES[m[1].toUpperCase()] || AXES[m[1].toLowerCase()];
      if (axis && !found[axis]) { found[axis] = cleanNum(m[2]); positions.push(m.index, m.index + m[0].length); }
    }
    while ((m = valueFirst.exec(window))) {
      const axis = AXES[m[2].toUpperCase()] || AXES[m[2].toLowerCase()];
      if (axis && !found[axis]) { found[axis] = cleanNum(m[1]); positions.push(m.index, m.index + m[0].length); }
    }

    // §6a — DV fallback using expanded pattern list
    if (!found.DV) {
      const dv = extractDV(window);
      if (dv) { found.DV = dv; positions.push(0); }
    }

    if (found.AP && found.ML) {
      const key = `${found.AP}|${found.ML}|${found.DV || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        const start = positions.length ? Math.max(0, Math.min(...positions) - 80) : 0;
        const end   = positions.length ? Math.min(window.length, Math.max(...positions) + 80) : 160;
        results.push({
          ap: found.AP,
          ml: found.ML,
          dv: found.DV || null,
          reference_point: extractReferencePoint(window),   // §6b
          source_sentence: window.slice(start, end).trim(),
        });
      }
    }
  }
  return results;
}

// ── Volume + titer extraction (§6c) ───────────────────────────────────────
// Viral-context keywords gate — only sentences/text containing these terms
// are considered for titer extraction, eliminating arena/cell-count false positives.
const VIRAL_KEYWORDS = /\b(AAV|adeno.assoc|lentivir|lenti-|WPRE|DREADD|hM[34]D|ChR2|opsin|GCaMP|titer|titre|vg\/m[lL]|v\.g\.|viral.{0,10}genomes?|vector.{0,10}genomes?|genomic.copies|infectious.units|transducing.units|particles\/m[lL])\b/i;

// Unicode superscript → ASCII (e.g. 10¹² → 10^12)
const SUPER_MAP = { '\u00b9':'1','\u00b2':'2','\u00b3':'3','\u2074':'4','\u2075':'5','\u2076':'6','\u2077':'7','\u2078':'8','\u2079':'9','\u2070':'0' };
function normSuper(s) { return s.replace(/[\u00b9\u00b2\u00b3\u2074-\u2079\u2070]/g, c => SUPER_MAP[c] || c); }

const UNIT  = '(?:GC|gc|vg|VG|TU|tu|IU|iu|PFU|pfu|FFU|ffu|viral[ -]genomes?|genome[ -]copies?|vector[ -]genomes?|genomic[ -]copies?|infectious[ -]units?|transducing[ -]units?|particles)';
const DENOM = '(?:\\/(?:mL|ml|µL|uL|\\xb5L|\u03bcL)|\\s+per\\s+(?:mL|ml)|\\s+per\\s+(?:µL|uL))';
const EXP   = '(?:\\^|\\s+)(\\d{1,2})';

const TITER_PATTERNS = [
  // P1 — coefficient × 10 EXP UNIT/DENOM  (most explicit form)
  new RegExp('([\\d]+(?:\\.[\\d]+)?)\\s*[xX\u00d7\u2715]\\s*10' + EXP + '\\s*' + UNIT + DENOM, 'i'),
  // P2 — bare 10 EXP UNIT/DENOM (no coefficient)
  new RegExp('10' + EXP + '\\s*' + UNIT + DENOM, 'i'),
  // P3 — E-notation  1.5e12 or 1.5E+12  UNIT/DENOM
  new RegExp('([\\d]+(?:\\.[\\d]+)?)[eE]\\s*[+]?\\s*(\\d{1,2})\\s*' + UNIT + DENOM, 'i'),
  // P4 — bare titer keyword + number (e.g. "titer: 4.25 × 10 12,")
  new RegExp('(?:titer|titre)[:\\s]+([\\d]+(?:\\.[\\d]+)?)\\s*[xX\u00d7\u2715]\\s*10' + EXP, 'i'),
  // P5 — denominator-free: 1×10^12 vg or 10^13 GC
  new RegExp('([\\d]+(?:\\.[\\d]+)?)?\\s*[xX\u00d7\u2715]?\\s*10' + EXP + '\\s*' + UNIT, 'i'),
];

function extractVolumeAndTiter(text) {
  if (!text) return { volume_nL: null, volume_raw: null, titer_raw: null };

  // ── Volume ────────────────────────────────────────────────────────────────
  const nLMatch = text.match(/([\d]+(?:\.[\d]+)?)\s*(?:nL|nl)\b/i);
  const uLMatch = text.match(/([\d]+(?:\.[\d]+)?)\s*[μuµ\u03bc]L\b/i);

  let volume_nL  = null;
  let volume_raw = null;

  if (nLMatch) {
    volume_nL  = parseFloat(nLMatch[1]);
    volume_raw = nLMatch[0].trim();
  } else if (uLMatch) {
    volume_nL  = parseFloat(uLMatch[1]) * 1000;
    volume_raw = uLMatch[0].trim();
  }

  // ── Titer — context-gated sentence-level search ───────────────────────────
  let titer_raw = null;

  const sentences = text.split(/[\n.]+/).filter(Boolean);
  for (const raw of sentences) {
    if (!VIRAL_KEYWORDS.test(raw)) continue;
    const s = normSuper(raw);
    for (const pat of TITER_PATTERNS) {
      const m = s.match(pat);
      if (m) { titer_raw = m[0].trim(); break; }
    }
    if (titer_raw) break;
  }

  // Fallback — if no sentence matched but text has viral keywords, try whole text
  if (!titer_raw && VIRAL_KEYWORDS.test(text)) {
    const s = normSuper(text);
    for (const pat of TITER_PATTERNS) {
      const m = s.match(pat);
      if (m) { titer_raw = m[0].trim(); break; }
    }
  }

  return { volume_nL, volume_raw, titer_raw };
}

// ── Injectate extraction ───────────────────────────────────────────────────
const INJECTATE_PATTERNS = [
  { type: 'AAV',               regex: /\bAAV[\s-]?(?:\d(?:\/\d+)?|DJ|PHP\.[A-Za-z0-9]+|rh\d+)?(?:-[\w.]+){0,4}/gi },
  { type: 'Lentivirus',        regex: /\b(?:lenti-?virus|LV-[\w.]+)/gi },
  { type: 'Retrograde tracer', regex: /\b(?:cholera toxin subunit B|CTB|fluorogold|FluoroGold|DiI|DiO|fast blue|retrobeads|WGA-HRP)\b/gi },
  { type: 'Rabies virus',      regex: /\b(?:rabies virus|RABV|SAD[\u2212-]?B19|EnvA)\b/gi },
  { type: 'DREADD',            regex: /\b(?:hM3Dq|hM4Di|rM3Ds|KORD|DREADD)\b/gi },
  { type: 'Opsin',             regex: /\b(?:ChR2|ChRmine|NpHR|eNpHR|ArchT|Jaws|GtACR\d?|iC\+\+)\b/gi },
  { type: 'CAV',               regex: /\bCAV-?2\b/gi },
  { type: 'Muscimol',          regex: /\bmuscimol\b/gi },
];

function extractInjectates(text) {
  if (!text) return [];
  const hits = new Map();
  for (const { type, regex } of INJECTATE_PATTERNS) {
    let m;
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(text))) {
      const raw = m[0].trim();
      const key = `${type}:${raw.toLowerCase()}`;
      if (!hits.has(key)) hits.set(key, { type, raw });
    }
  }
  return Array.from(hits.values());
}

// ── CCF region matcher ────────────────────────────────────────────────────
function buildRegionMatcher(structures) {
  return function matchRegions(namesToTry, maxResults = 5) {
    const matches  = [];
    const seenIds  = new Set();
    for (const rawName of namesToTry) {
      if (!rawName) continue;
      const needle = rawName.toLowerCase().replace(/[()]/g, '').trim();
      if (!needle) continue;
      for (const s of structures) {
        if (seenIds.has(s.id)) continue;
        const name    = s.name.toLowerCase();
        const acronym = s.acronym.toLowerCase();
        if (name === needle || acronym === needle || name.includes(needle) || needle.includes(name)) {
          matches.push({ id: s.id, acronym: s.acronym, name: s.name, ap_mm: s.ap_mm, ml_mm: s.ml_mm, dv_mm: s.dv_mm });
          seenIds.add(s.id);
          if (matches.length >= maxResults) return matches;
        }
      }
    }
    return matches;
  };
}

// ── Species detection ─────────────────────────────────────────────────────
const RAT_SIGNALS   = /\brats?\b|\bsprague[- ]dawley\b|\bwistar\b|\blong[- ]evans\b|\bfischer\s*344\b|\bSD\s+rat\b/i;
const MOUSE_SIGNALS = /\bmice\b|\bmouse\b|\bc57bl[\/\s-]/i;

function detectSpecies(text) {
  const isRat   = RAT_SIGNALS.test(text);
  const isMouse = MOUSE_SIGNALS.test(text);
  if (isMouse && !isRat)  return 'mouse';
  if (isRat   && !isMouse) return 'rat';
  if (isMouse && isRat)   return 'mixed';
  return 'unknown';
}

// ── Region category → CCF search terms ───────────────────────────────────
const CATEGORY_SEARCH_TERMS = {
  'Prefrontal Cortex':        ['prefrontal','cingulate','prelimbic','infralimbic','orbital'],
  'Sensory & Motor Cortex':   ['motor cortex','somatosensory','visual cortex','auditory cortex','piriform','entorhinal','insular'],
  'Olfactory Bulb':           ['olfactory bulb'],
  'Hippocampus & Subiculum':  ['hippocampus','dentate gyrus','field ca','subiculum'],
  'Amygdala & BNST':          ['amygdala','bed nucleus'],
  'Striatum & NAc':           ['striatum','caudoputamen','accumbens'],
  'Pallidum & Subthalamus':   ['pallidum','subthalamic'],
  'Thalamus & Habenula':      ['thalamus','habenula'],
  'Hypothalamus':             ['hypothalamus','hypothalamic'],
  'Midbrain (VTA & SN)':      ['substantia nigra','ventral tegmental'],
  'Midbrain (PAG & Colliculi)':['periaqueductal','colliculus','interpeduncular'],
  'Brainstem & Raphe':        ['locus coeruleus','raphe','solitary tract','medulla'],
  'Cerebellum':               ['cerebell','purkinje','dentate nucleus'],
};

// ── Helpers ────────────────────────────────────────────────────────────────
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`Could not load ${p}: ${e.message}`); return fallback; }
}

// ── Main ──────────────────────────────────────────────────────────────────
function main() {
  const stereotaxicRaw = loadJson(STEREOTAXIC_PATH, []);
  const surgicalRaw    = loadJson(SURGICAL_PATH, []);
  const structures     = loadJson(STRUCTURES_PATH, []);
  const matchRegions   = buildRegionMatcher(structures);

  // Normalise both corpora to the same flat array shape
  const stereotaxic = toFlatArray(stereotaxicRaw);
  const surgical    = toFlatArray(surgicalRaw);

  console.log(`Loaded ${stereotaxic.length} stereotaxic + ${surgical.length} surgical papers.`);

  const byPmid = new Map();

  function ensureRecord(pmid, pmcid) {
    if (!byPmid.has(pmid)) {
      byPmid.set(pmid, {
        pmid,
        pmcid:           pmcid || null,
        region_categories: new Set(),
        coordinates:     [],
        injectates:      [],
        ccf_regions:     [],
        sources:         new Set(),
        speciesTexts:    [],
        volume_nL:       null,
        volume_raw:      null,
        titer_raw:       null,
      });
    }
    return byPmid.get(pmid);
  }

  // ── Text-based region detection ─────────────────────────────────────────
  // Scans all available text fields against CATEGORY_SEARCH_TERMS keywords.
  // Returns array of matching category names.
  function detectRegionsFromText(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const found = [];
    for (const [category, keywords] of Object.entries(CATEGORY_SEARCH_TERMS)) {
      if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
        found.push(category);
      }
    }
    return found;
  }

  function processCorpusPaper(paper, sourceLabel) {
    if (!paper.pmid) return;
    const rec = ensureRecord(String(paper.pmid), paper.pmcid);
    rec.sources.add(sourceLabel);

    // 1. Explicit regions[] from ingest (usually empty — kept as fallback)
    (paper.regions || []).forEach(r => rec.region_categories.add(r));

    // 2. Text-based region detection — scan all available text fields
    const allText = [
      paper.methods,
      paper.abstract,
      paper.results,
      paper.figure_legends,
      paper.surgical_methods_summary,
      paper.raw_abstract_snippet,
      paper.title,
    ].filter(Boolean).join('\n');

    detectRegionsFromText(allText).forEach(r => rec.region_categories.add(r));

    // All available text, in priority order — covers both old and new format
    const methodsText = paper.methods || paper.surgical_methods_summary || null;
    const combined    = [
      paper.methods,
      paper.abstract,
      paper.results,
      paper.figure_legends,
      paper.surgical_methods_summary,
      paper.raw_abstract_snippet,
    ].filter(Boolean).join('\n');

    // Species detection — use all text, not just methods
    const speciesText = [
      paper.methods, paper.abstract, paper.results,
      paper.surgical_methods_summary, paper.raw_abstract_snippet, paper.title,
    ].filter(Boolean).join(' ');
    if (speciesText) rec.speciesTexts.push(speciesText.slice(0, 1200));

    // Coordinates — methods first, then broaden to all text
    const coordText = combined || '';
    extractCoordinateSets(coordText).forEach(c => {
      const key = `${c.ap}|${c.ml}|${c.dv}`;
      if (!rec.coordinates.some(x => `${x.ap}|${x.ml}|${x.dv}` === key)) rec.coordinates.push(c);
    });

    // Injectates — all text
    extractInjectates(combined).forEach(inj => {
      const key = `${inj.type}:${inj.raw.toLowerCase()}`;
      if (!rec.injectates.some(x => `${x.type}:${x.raw.toLowerCase()}` === key)) rec.injectates.push(inj);
    });

    // Volume + titer — methods takes priority, then fall back to all text
    if (rec.volume_nL === null || rec.titer_raw === null) {
      const { volume_nL, volume_raw, titer_raw } = extractVolumeAndTiter(methodsText || combined);
      if (rec.volume_nL  === null && volume_nL  !== null) { rec.volume_nL = volume_nL; rec.volume_raw = volume_raw; }
      if (rec.titer_raw  === null && titer_raw  !== null) { rec.titer_raw = titer_raw; }
    }
    // Second pass fallback — try results + figure_legends if methods gave nothing
    if ((rec.volume_nL === null || rec.titer_raw === null) && (paper.results || paper.figure_legends)) {
      const fallback = [paper.results, paper.figure_legends].filter(Boolean).join('\n');
      const { volume_nL, volume_raw, titer_raw } = extractVolumeAndTiter(fallback);
      if (rec.volume_nL  === null && volume_nL  !== null) { rec.volume_nL = volume_nL; rec.volume_raw = volume_raw; }
      if (rec.titer_raw  === null && titer_raw  !== null) { rec.titer_raw = titer_raw; }
    }
  }

  stereotaxic.forEach(p => processCorpusPaper(p, 'stereotaxic'));
  surgical.forEach(p    => processCorpusPaper(p, 'surgical'));

  // CCF region cross-reference
  for (const rec of byPmid.values()) {
    const categories = Array.from(rec.region_categories);
    const searchTerms = categories.flatMap(c => CATEGORY_SEARCH_TERMS[c] || [c]);
    const fromSentences = rec.coordinates.map(c => c.source_sentence).join(' ');
    rec.ccf_regions = matchRegions([...searchTerms, fromSentences.slice(0, 60)]);
  }

  const output = Array.from(byPmid.values())
    .map(rec => ({
      pmid:             rec.pmid,
      pmcid:            rec.pmcid,
      species:          detectSpecies(rec.speciesTexts.join(' ')),
      region_categories: Array.from(rec.region_categories),
      ccf_regions:      rec.ccf_regions,
      coordinates:      rec.coordinates,
      injectates:       rec.injectates,
      volume_nL:        rec.volume_nL,
      volume_raw:       rec.volume_raw,
      titer_raw:        rec.titer_raw,
      sources:          Array.from(rec.sources),
    }))
    .sort((a, b) => Number(b.pmid) - Number(a.pmid));

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  const withCoords   = output.filter(r => r.coordinates.length > 0).length;
  const withInj      = output.filter(r => r.injectates.length > 0).length;
  const withCcf      = output.filter(r => r.ccf_regions.length > 0).length;
  const withVolume   = output.filter(r => r.volume_nL !== null).length;
  const withTiter    = output.filter(r => r.titer_raw !== null).length;
  const bregmaCount  = output.filter(r => r.coordinates.some(c => c.reference_point === 'bregma')).length;
  const lambdaCount  = output.filter(r => r.coordinates.some(c => c.reference_point === 'lambda')).length;
  const speciesCounts = output.reduce((a, r) => { a[r.species] = (a[r.species] || 0) + 1; return a; }, {});

  console.log(`Processed ${output.length} unique PMIDs.`);
  console.log(`  With extracted coordinates:  ${withCoords}`);
  console.log(`  With extracted injectate:    ${withInj}`);
  console.log(`  With CCF region match:       ${withCcf}`);
  console.log(`  With volume extracted (§6c): ${withVolume}`);
  console.log(`  With titer extracted  (§6c): ${withTiter}`);
  console.log(`  Bregma-referenced (§6b):     ${bregmaCount}`);
  console.log(`  Lambda-referenced (§6b):     ${lambdaCount}`);
  console.log(`  Species breakdown:`, speciesCounts);
  console.log(`Wrote ${OUT_PATH}`);
}

main();
