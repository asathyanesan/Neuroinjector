'use strict';
// ============================================================
// extract-passages.js  —  PASSAGE-FIRST injection extractor
//                          (MULTI-SENTENCE WINDOW version)
//
// WHY THIS VERSION EXISTS
//   The single-sentence extractor missed papers where the
//   COORDINATES and the INJECTION VERB live in DIFFERENT
//   sentences. Real example (PMID 40848722, lobule simplex):
//
//     "...a craniotomy was prepared over lobule simplex ...
//      (~2.8 mm posterior and 1.4 mm lateral to lambda).
//      To express GCaMP ... a glass micropipette was filled
//      with virus AAV1..."
//
//   Coordinates are in sentence 1 (craniotomy), the injection
//   verb is in sentence 2. Single-sentence capture grabbed
//   sentence 2 and LOST the coordinates -> has_coords:false.
//
// THE FIX
//   * Anchor on any injection OR craniotomy sentence.
//   * Expand the passage to a WINDOW of +/- N sentences and
//     merge overlaps, so the coordinate sentence and the
//     injection verb end up in the SAME passage.
//   * Coordinates remain a BOOLEAN hint (has_coords). The LLM
//     reads the raw passage text at answer time and parses the
//     numbers itself (handles ranges, +/-, reversed order, um).
//   * Region assignment is CONTEXT-GATED: a synonym only maps
//     to a CCF region when required context is present AND
//     disqualifying context (e.g. herpes simplex) is absent.
//
// OUTPUT (non-destructive):
//   react-app/public/data/injection-passages.json
//
// USAGE
//   node extract-passages.js
// ============================================================

const fs   = require('fs');
const path = require('path');

const SURG_FILE = path.resolve(
  __dirname, '../react-app/public/data/surgical-protocols.json'
);
const OUT_FILE = path.resolve(
  __dirname, '../react-app/public/data/injection-passages.json'
);

// Multi-sentence window: how many sentences of context to keep
// on each side of an anchor sentence.
const WINDOW_BEFORE = 2;
const WINDOW_AFTER  = 2;

// ── Load corpus (flat array or region-keyed object) ─────────
function loadCorpus() {
  const raw = JSON.parse(fs.readFileSync(SURG_FILE, 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw).flat();
}

// ────────────────────────────────────────────────────────────
// CONTEXT-GATED REGION SYNONYM MAP
//   syns    : terms that (loosely) name the region
//   require : context that MUST be present for the term to count
//   exclude : context that DISQUALIFIES the match (false positives)
// ────────────────────────────────────────────────────────────
const REGIONS = {
  // ── Cerebellar ──
  SIM:  { syns: ['simplex lobule','simple lobule','lobulus simplex','lobule simplex','lobule vi','hvi'],
          require: /cerebell|purkinje|lobule|vermis|crus|molecular layer|granule|mossy|climbing/i,
          exclude: /herpes|hsv[\s-]?[12]|simplex virus/i },
  CRUS1:{ syns: ['crus i','crus 1','crus1'], require: /cerebell|purkinje|ansiform/i },
  CRUS2:{ syns: ['crus ii','crus 2','crus2'], require: /cerebell|purkinje|ansiform/i },
  CENT: { syns: ['central lobule','lobule ii','lobule iii'], require: /cerebell/i },
  CUL:  { syns: ['culmen','lobule iv','lobule v','lobule iv/v'], require: /cerebell/i },
  NOD:  { syns: ['nodulus','lobule x'], require: /cerebell|vestibul/i },
  FL:   { syns: ['flocculus'], require: /cerebell|vestibul|oculomotor/i },
  UVU:  { syns: ['uvula','lobule ix'], require: /cerebell/i },
  PYR:  { syns: ['pyramis','lobule viii'], require: /cerebell/i },
  DN:   { syns: ['dentate nucleus'], require: /cerebell|deep cerebellar/i },
  FN:   { syns: ['fastigial nucleus','fastigial'], require: /cerebell/i },
  IP:   { syns: ['interposed nucleus','interpositus'], require: /cerebell/i },
  VERM: { syns: ['vermis'], require: /cerebell/i },

  // ── Hippocampal ──
  DG:   { syns: ['dentate gyrus'], require: /hippocamp|granule|mossy|perforant/i,
          exclude: /cerebell|dentate nucleus/i },
  CA1:  { syns: ['ca1'], require: /hippocamp|pyramidal|schaffer/i },
  CA3:  { syns: ['ca3'], require: /hippocamp|pyramidal|mossy/i },

  // ── Cortex ──
  ACAd: { syns: ['anterior cingulate cortex','cingulate area'], require: /cortex|cortical|prefrontal/i,
          exclude: /\bacc\b(?!.*cingulate)/i },
  PL:   { syns: ['prelimbic'], require: /cortex|prefrontal|mpfc/i },
  ILA:  { syns: ['infralimbic'], require: /cortex|prefrontal|mpfc/i },
  AI:   { syns: ['insular cortex','insula'], require: /cortex|cortical/i },
  MOp:  { syns: ['primary motor cortex','m1 motor'], require: /cortex|cortical|motor/i },
  SSp:  { syns: ['somatosensory cortex','barrel cortex','s1 cortex'], require: /cortex|cortical/i },
  VISp: { syns: ['primary visual cortex','v1 cortex'], require: /cortex|visual/i },
  AUDp: { syns: ['primary auditory cortex','a1 cortex'], require: /cortex|auditory/i },
  ENT:  { syns: ['entorhinal cortex'], require: /cortex|cortical/i },
  PIR:  { syns: ['piriform cortex'], require: /cortex|olfactory/i },
  RSP:  { syns: ['retrosplenial cortex'], require: /cortex|cortical/i },

  // ── Subcortical ──
  BLA:  { syns: ['basolateral amygdala','basolateral nucleus of the amygdala'], require: /amygdal/i },
  CEA:  { syns: ['central amygdala','central nucleus of the amygdala'], require: /amygdal/i },
  MEA:  { syns: ['medial amygdala'], require: /amygdal/i },
  LC:   { syns: ['locus coeruleus','locus ceruleus'] },
  DR:   { syns: ['dorsal raphe','dorsal raphe nucleus'] },
  MRN:  { syns: ['median raphe'], require: /raphe/i },
  VTA:  { syns: ['ventral tegmental area'] },
  SNc:  { syns: ['substantia nigra pars compacta','substantia nigra compacta'], require: /nigra|dopamin/i },
  SNr:  { syns: ['substantia nigra pars reticulata','substantia nigra reticulata'], require: /nigra/i },
  PAG:  { syns: ['periaqueductal gray','periaqueductal grey'] },
  PVN:  { syns: ['paraventricular nucleus of the hypothalamus','hypothalamic paraventricular'], require: /hypothal/i },
  LHA:  { syns: ['lateral hypothalamus','lateral hypothalamic area'], require: /hypothal/i },
  VMH:  { syns: ['ventromedial hypothalamus','ventromedial nucleus'], require: /hypothal/i },
  ARH:  { syns: ['arcuate nucleus'], require: /hypothal/i },
  SCN:  { syns: ['suprachiasmatic nucleus'], require: /hypothal|circadian/i },
  MPO:  { syns: ['medial preoptic'], require: /hypothal|preoptic/i },
  PVT:  { syns: ['paraventricular thalamus','paraventricular nucleus of the thalamus'], require: /thalam/i },
  MD:   { syns: ['mediodorsal thalamus','mediodorsal nucleus'], require: /thalam/i },
  RT:   { syns: ['thalamic reticular','reticular nucleus of the thalamus'], require: /thalam/i },
  LHb:  { syns: ['lateral habenula'], require: /habenul/i },
  MHb:  { syns: ['medial habenula'], require: /habenul/i },
  ACB:  { syns: ['nucleus accumbens','accumbens'] },
  CP:   { syns: ['dorsal striatum','dorsomedial striatum','dorsolateral striatum','caudate putamen','caudate-putamen'], require: /striat/i },
  BNST: { syns: ['bed nucleus of the stria terminalis','bed nucleus of stria terminalis'] },
  GPe:  { syns: ['globus pallidus','external pallidum'], require: /pallid|basal ganglia/i },
  STN:  { syns: ['subthalamic nucleus'], require: /subthalam|basal ganglia/i },
  MS:   { syns: ['medial septum'], require: /septum|septal/i },
  NBM:  { syns: ['nucleus basalis','basal forebrain'], require: /cholinerg|basal/i },
  MOB:  { syns: ['olfactory bulb'], require: /olfactor|glomerul|mitral/i },
  SC:   { syns: ['superior colliculus'], require: /collicul|tectum|visual/i },
  IC:   { syns: ['inferior colliculus'], require: /collicul|auditory/i },
};

// ── Signals ─────────────────────────────────────────────────
// A sentence describes an INJECTION or is an injection SITE if it
// mentions a delivery verb/tool OR a craniotomy (in these papers the
// craniotomy location IS the injection site and carries coordinates).
const INJECT_RE = /\b(inject|infus|implant|microinjec|deliver|inocul|stereotax|craniotom|cannula|AAV|adeno.assoc|lentivir|virus|viral|tracer|GCaMP|jGCaMP|ChR2|optogenet|DREADD|micropipette|pressure inject)\w*/i;

// Coordinate presence (boolean hint — NOT parsed for value here).
// Broadened to catch value-first spelled-out axes and micrometre depths.
const COORD_RE = /\bAP\b|\bML\b|\bDV\b|antero.?poster|medio.?later|dorso.?ventr|\bposterior\b|\banterior\b|\blateral\b|\bventral\b|\bdepth\b|bregma|lambda|[-\u2212+]?\d+(?:\.\d+)?\s*mm|\d+\s*(?:um|\u00b5m|\u03bcm|microns?)/i;

const REF_RE   = { bregma: /\bbregma\b/i, lambda: /\blambda\b/i };
const INJECTATE_RE = /\b(AAV[- ]?\d?[a-z0-9.]*|adeno.assoc\w*|lentivir\w*|rabies|CTB|CAV|HSV|FluoroGold|DiI|biotinylated dextran|BDA|muscimol|6[- ]?OHDA|ibotenic|kainic|CNO|GCaMP\w*|jGCaMP\w*|ChR2|eNpHR\w*|ArchT|hM3Dq|hM4Di|GFP|mCherry|tdTomato|Cre)\b/i;

// ── Sentence splitter (keeps decimals/mm intact) ────────────
function sentences(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+(?=[A-Z(0-9])|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 15);
}

// ── Resolve which CCF regions a text names (context-gated) ──
function regionsIn(text) {
  const low = ' ' + text.toLowerCase() + ' ';
  const hits = [];
  for (const [acr, spec] of Object.entries(REGIONS)) {
    const named = spec.syns.some(s => low.includes(' ' + s + ' ') || low.includes(' ' + s + ',') ||
                                       low.includes(' ' + s + '.') || low.includes('(' + s + ' '));
    if (!named) continue;
    if (spec.require && !spec.require.test(text)) continue;
    if (spec.exclude && spec.exclude.test(text))  continue;
    hits.push({ acr, terms: spec.syns.filter(s => low.includes(s)) });
  }
  return hits;
}

// Which raw region terms are named anywhere in the text (for region_terms field).
function regionTermsIn(text) {
  const low = ' ' + text.toLowerCase() + ' ';
  const terms = new Set();
  for (const spec of Object.values(REGIONS)) {
    for (const s of spec.syns) {
      if (low.includes(s)) terms.add(s);
    }
  }
  return [...terms];
}

// ── Build merged windows around anchor sentences ────────────
// An anchor = a sentence with an injection/craniotomy verb.
// Window = [anchor-BEFORE .. anchor+AFTER], overlapping windows merged.
function buildWindows(sents) {
  const anchors = [];
  sents.forEach((s, i) => { if (INJECT_RE.test(s)) anchors.push(i); });
  if (!anchors.length) return [];

  // Convert anchors to [start,end] ranges, then merge overlaps.
  const ranges = anchors.map(i => [
    Math.max(0, i - WINDOW_BEFORE),
    Math.min(sents.length - 1, i + WINDOW_AFTER),
  ]);
  ranges.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged.map(([a, b]) => sents.slice(a, b + 1).join(' '));
}

// ── Per-paper extraction ────────────────────────────────────
function extractPaper(paper) {
  const fields = [
    ['methods',        paper.methods],
    ['results',        paper.results],
    ['figure_legends', paper.figure_legends],
    ['abstract',       paper.abstract],
  ].filter(([, v]) => v && v.trim());

  const passages = [];
  const ccfSet   = new Set();

  for (const [field, text] of fields) {
    const windows = buildWindows(sentences(text));
    for (const win of windows) {
      const regionHits = regionsIn(win);
      // Only keep windows that name at least one CCF region — an
      // injection with no anatomical target isn't useful for the RAG.
      if (!regionHits.length) continue;

      const hasCoords = COORD_RE.test(win);
      const ref = REF_RE.lambda.test(win) ? 'lambda'
                : REF_RE.bregma.test(win) ? 'bregma'
                : 'unknown';
      const inj = win.match(INJECTATE_RE);

      regionHits.forEach(h => ccfSet.add(h.acr));

      passages.push({
        region_terms:    regionTermsIn(win),
        ccf_regions:     regionHits.map(h => h.acr),
        text:            win.length > 1200 ? win.slice(0, 1200) + '…' : win,
        has_coords:      hasCoords,
        reference_point: ref,
        injectate_hint:  inj ? inj[0] : null,
        source_field:    field,
      });
    }
  }

  if (!passages.length) return null;
  return {
    pmid:        String(paper.pmid),
    pmcid:       paper.pmcid || null,
    title:       paper.title || null,
    year:        paper.year || null,
    ccf_regions: [...ccfSet],
    passages,
  };
}

// ── Main ────────────────────────────────────────────────────
function main() {
  const corpus = loadCorpus();
  console.log(`Loaded ${corpus.length} papers.\n`);

  const out = [];
  let totalPassages = 0;
  let coordPapers   = 0;
  let coordPassages = 0;
  const regionCount = {};
  let simPapers     = 0;

  for (const paper of corpus) {
    const rec = extractPaper(paper);
    if (!rec) continue;
    out.push(rec);
    totalPassages += rec.passages.length;

    const hasCoord = rec.passages.some(p => p.has_coords);
    if (hasCoord) coordPapers++;
    coordPassages += rec.passages.filter(p => p.has_coords).length;

    rec.ccf_regions.forEach(r => { regionCount[r] = (regionCount[r] || 0) + 1; });
    if (rec.ccf_regions.includes('SIM')) simPapers++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');

  console.log(`Papers with >=1 injection passage : ${out.length}`);
  console.log(`Total passages                    : ${totalPassages}`);
  console.log(`Passages carrying coord signal    : ${coordPassages}`);
  console.log(`Papers w/ coord-bearing passage   : ${coordPapers}`);
  console.log('');
  console.log('Top regions by paper count:');
  Object.entries(regionCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([r, n]) => console.log(`   ${r.padEnd(6)} ${n}`));
  console.log('');
  console.log(`SIM (cerebellar simplex) papers   : ${simPapers}`);
  console.log(`\nWrote ${OUT_FILE}`);
}

main();
