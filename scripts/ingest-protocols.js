'use strict';
// ingest-protocols.js
// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY: Two-track ingestion
//
//   Phase 1  Broad PubMed search — NO pmc filter, loosened terms
//            Target: ~6,000–8,000 candidates (was ~2,965 with pmc filter)
//
//   Phase 2  Metadata fetch — abstract pre-filter + PMCID detection
//            Papers split into two tracks:
//              Track A: has PMCID → full text fetch in Phase 3
//              Track B: no PMCID  → abstract stored directly
//
//   Phase 3  PMC full text (Track A only)
//            Quality gate: coordinate OR titer signal in any text field
//
//   Output   surgical-protocols.json — flat array, one object per paper
//            All Track B papers stored with abstract only (no coords possible
//            but still useful for RAG injectate/region matching)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const http = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const OUTPUT_FILE   = '../react-app/public/data/surgical-protocols.json';
const CURRENT_YEAR  = new Date().getFullYear();
const CHECKPOINT_N  = 50;
const BATCH_META    = 200;
const MAX_PER_PAGE  = 9999;

// API key from environment — register free at ncbi.nlm.nih.gov/account
// Raises rate limit from 3 req/s → 10 req/s
const API_KEY = process.env.NCBI_API_KEY || '';
let   RATE_MS = API_KEY ? 110 : 340;

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// ── Queries — NO pubmed pmc[sb] filter, loosened terms ───────────────────────
// Removing pmc filter doubles the candidate pool.
// Removing "brain" and "injection" from core query recovers papers where
// those words don't appear in the abstract (they're in Methods sections).
const BROAD_QUERIES = [
  {
    label: 'Core — mouse stereotaxic',
    query: `(mouse OR mice) AND (stereotaxic OR stereotactic) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Viral vectors — AAV / lentivirus mouse brain',
    query: `(mouse OR mice) AND (AAV OR "adeno-associated virus" OR lentivirus OR lentiviral) AND (stereotaxic OR stereotactic OR intracranial OR intracerebral) AND brain AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Chemogenetics — DREADD mouse brain',
    query: `(mouse OR mice) AND (DREADD OR hM3Dq OR hM4Di OR chemogenetic OR "designer receptor") AND (injection OR infusion OR stereotaxic OR stereotactic) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Optogenetics — channelrhodopsin mouse brain',
    query: `(mouse OR mice) AND (optogenetic OR channelrhodopsin OR ChR2 OR halorhodopsin OR ArchT) AND (injection OR virus OR AAV OR stereotaxic OR stereotactic) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Calcium imaging — fiber photometry mouse',
    query: `(mouse OR mice) AND ("fiber photometry" OR "fibre photometry" OR GCaMP OR jGCaMP OR "calcium imaging" OR miniscope OR "gradient index lens") AND (injection OR virus OR AAV OR stereotaxic OR stereotactic) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Cannula / microinjection mouse brain',
    query: `(mouse OR mice) AND (cannula OR "guide cannula" OR microinjection OR "micro-injection" OR "intracranial injection") AND brain AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Pharmacology / toxin stereotaxic mouse',
    query: `(mouse OR mice) AND (stereotaxic OR stereotactic) AND (6-OHDA OR MPTP OR "ibotenic acid" OR muscimol OR bicuculline OR kainic OR "6-hydroxydopamine" OR neurotoxin) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Anterograde / retrograde tracer mouse',
    query: `(mouse OR mice) AND (anterograde OR retrograde OR "tract tracing" OR "neural tracing" OR "axonal tracing") AND (stereotaxic OR stereotactic OR injection) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Rabies virus tracing mouse',
    query: `(mouse OR mice) AND ("rabies virus" OR EnvA OR TVA OR "monosynaptic tracing") AND (stereotaxic OR stereotactic OR intracranial OR injection) AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'shRNA / siRNA brain mouse',
    query: `(mouse OR mice) AND (shRNA OR siRNA OR "RNA interference" OR "gene silencing") AND (stereotaxic OR stereotactic OR intracranial OR "brain injection") AND 2000:${CURRENT_YEAR}[dp]`,
  },
  {
    label: 'Neuropeptide microinjection mouse',
    query: `(mouse OR mice) AND (microinjection OR "micro-injection") AND (neuropeptide OR peptide OR BDNF OR NGF OR "growth factor") AND brain AND 2000:${CURRENT_YEAR}[dp]`,
  },
];

// ── Region-targeted queries ──────────────────────────────────────────────────
// Anatomy-first: (mouse) AND (region synonyms) AND (injection technique) AND OA.
// These fill the systematic coverage gaps the broad technique queries miss —
// most importantly the cerebellar lobules (simplex/Crus/vermis) that returned
// ~0 before. Context guards prevent false positives (simplex→herpes,
// dentate gyrus vs dentate nucleus, ACC acronym collisions).
const REGION_SPECS = [
  // ── Cerebellar (the proven gap) ──
  { label: 'Cerebellar — simplex / lobule VI', region: '("simplex lobule" OR "simple lobule" OR "lobulus simplex" OR "lobule VI")', extra: 'AND (cerebell* OR purkinje OR lobule)' },
  { label: 'Cerebellar — Crus I / II',         region: '("Crus I" OR "Crus II" OR "crus 1" OR "crus 2")', extra: 'AND cerebell*' },
  { label: 'Cerebellar — named lobules',       region: '("lobule IV" OR "lobule V" OR "lobule VII" OR "lobule VIII" OR "lobule IX" OR "lobule X" OR culmen OR nodulus OR flocculus OR uvula OR pyramis)', extra: 'AND cerebell*' },
  { label: 'Cerebellar — vermis',              region: '(vermis OR "vermal" OR paravermis)', extra: 'AND cerebell*' },
  { label: 'Cerebellar — deep nuclei',         region: '("deep cerebellar nuclei" OR "fastigial nucleus" OR "dentate nucleus" OR "interposed nucleus" OR interpositus)', extra: 'AND cerebell*' },
  { label: 'Cerebellar — circuits',            region: '(Purkinje OR "climbing fiber" OR "mossy fiber" OR "parallel fiber" OR "granule cell")', extra: 'AND cerebell*' },
  { label: 'Cerebellar — cortex broad',        region: '("cerebellar cortex" OR "cerebellar hemisphere")', extra: '' },
  // ── Data-poor (§6d) ──
  { label: 'Amygdala — BLA / CeA / MeA',       region: '("basolateral amygdala" OR "central amygdala" OR "medial amygdala" OR BLA OR CeA)', extra: 'AND amygdal*' },
  { label: 'Hippocampus — DG / CA1-3',         region: '("dentate gyrus" OR CA1 OR CA3 OR "hippocampal CA")', extra: 'AND hippocamp*' },
  { label: 'Cortex — ACC / PL / IL',           region: '("anterior cingulate" OR prelimbic OR infralimbic OR "medial prefrontal")', extra: 'AND cort* ' },
  { label: 'Locus coeruleus',                  region: '("locus coeruleus" OR "locus ceruleus")', extra: '' },
  { label: 'Insular cortex',                   region: '("insular cortex" OR "insula")', extra: 'AND cort*' },
  { label: 'Motor cortex — M1 / M2',           region: '("primary motor cortex" OR "secondary motor cortex" OR "motor cortex M1" OR "motor cortex M2")', extra: 'AND cort*' },
  { label: 'Somatosensory — S1 / barrel',      region: '("somatosensory cortex" OR "barrel cortex" OR "S1 cortex")', extra: 'AND cort*' },
  { label: 'Dorsal raphe',                     region: '("dorsal raphe" OR "median raphe" OR "raphe nucleus")', extra: '' },
  // ── Systematic coverage ──
  { label: 'VTA',                              region: '("ventral tegmental area" OR VTA)', extra: '' },
  { label: 'Substantia nigra — SNc / SNr',     region: '("substantia nigra" OR "pars compacta" OR "pars reticulata" OR SNc OR SNr)', extra: '' },
  { label: 'Periaqueductal gray',              region: '("periaqueductal gray" OR "periaqueductal grey" OR PAG)', extra: '' },
  { label: 'Superior / inferior colliculus',   region: '("superior colliculus" OR "inferior colliculus")', extra: '' },
  { label: 'Hypothalamus — PVN / LH / VMH',    region: '("paraventricular nucleus" OR "lateral hypothalamus" OR "ventromedial hypothalamus" OR "arcuate nucleus")', extra: 'AND hypothalam*' },
  { label: 'SCN / preoptic',                   region: '("suprachiasmatic nucleus" OR "preoptic area" OR "medial preoptic")', extra: '' },
  { label: 'Thalamus — PVT / MD / RT',         region: '("paraventricular thalamus" OR "mediodorsal thalamus" OR "reticular thalamic" OR "thalamic reticular")', extra: 'AND thalam*' },
  { label: 'Habenula — LHb / MHb',             region: '("lateral habenula" OR "medial habenula" OR habenula)', extra: '' },
  { label: 'Nucleus accumbens',                region: '("nucleus accumbens" OR "accumbens shell" OR "accumbens core")', extra: '' },
  { label: 'Striatum — DMS / DLS',             region: '("dorsomedial striatum" OR "dorsolateral striatum" OR "caudate putamen" OR "dorsal striatum")', extra: 'AND striat*' },
  { label: 'Pallidum / STN',                   region: '("globus pallidus" OR "subthalamic nucleus" OR "ventral pallidum")', extra: '' },
  { label: 'BNST',                             region: '("bed nucleus of the stria terminalis" OR BNST)', extra: '' },
  { label: 'Basal forebrain — MS / NBM',       region: '("medial septum" OR "nucleus basalis" OR "diagonal band" OR "basal forebrain")', extra: '' },
  { label: 'Visual / auditory / RSC',          region: '("visual cortex" OR "auditory cortex" OR "retrosplenial cortex")', extra: 'AND cort*' },
  { label: 'Entorhinal / piriform',            region: '("entorhinal cortex" OR "piriform cortex" OR "perirhinal cortex")', extra: 'AND cort*' },
  { label: 'Olfactory bulb',                   region: '("olfactory bulb" OR "accessory olfactory")', extra: '' },
];

const INJECT_TECH = '(stereotax* OR stereotact* OR inject* OR infus* OR AAV OR "adeno-associated" OR lentivir* OR optogenet* OR DREADD OR cannula OR microinject* OR virus OR viral OR tracer OR GCaMP OR craniotom*)';

const REGION_QUERIES = REGION_SPECS.map(s => ({
  label: s.label,
  query: `(mouse OR mice) AND ${s.region} ${s.extra} AND ${INJECT_TECH} AND pubmed pmc[sb] AND 2000:${CURRENT_YEAR}[dp]`
    .replace(/\s+/g, ' ').trim(),
}));

const ALL_QUERIES = [...BROAD_QUERIES, ...REGION_QUERIES];

// ── Pre-filter (abstract level — Phase 2) ─────────────────────────────────────
const INJECTION_RE = /\b(inject|infus|implant|cannula|AAV|adeno.assoc|lentivir|DREADD|optogenet|channelrhodop|fiber.photom|GCaMP|chemogenet|stereotax|stereotact|microinjec|virus|viral|inocul|tracer|tracing|rabies|shRNA|siRNA)\w*/i;

// ── Quality gate (full text — Phase 3 Track A only) ───────────────────────────
const COORD_RE = /\bAP[\s:=]|\bML[\s:=]|\bDV[\s:=]|anteroposterior|mediolateral|dorsoventral|bregma|\d+\.\d*\s*mm/i;
const TITER_RE = /\d\s*[×xX\u00d7]\s*10|\b10\s*\^?\s*\d{1,2}|[0-9][eE][+]?\d{2}|titer|titre|vg\/m[lL]|GC\/m[lL]/i;

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function apiUrl(endpoint, params) {
  const p = new URLSearchParams(params);
  if (API_KEY) p.set('api_key', API_KEY);
  return `${BASE}/${endpoint}?${p.toString()}`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadExisting() {
  try {
    const abs = path.resolve(__dirname, OUTPUT_FILE);
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const arr = Array.isArray(raw) ? raw : Object.values(raw).flat();
    const map = {};
    arr.forEach(p => { if (p?.pmid) map[String(p.pmid)] = p; });
    return map;
  } catch { return {}; }
}

function saveDB(db) {
  const abs = path.resolve(__dirname, OUTPUT_FILE);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(Object.values(db), null, 2), 'utf8');
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function stripTags(xml) {
  return (xml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractAbstract(xml) {
  const blocks = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi)];
  if (!blocks.length) return null;
  return blocks.map(b => stripTags(b[1])).join(' ');
}

function parsePMCSections(xml) {
  // Honest body detection: publisher-blocked papers return only <front>
  // (abstract + journal metadata) with NO <body>. Do not fake methods from it.
  const bodyMatch = xml.match(/<body[\s\S]*?<\/body>/i);
  const hasBody = !!bodyMatch;
  const body = bodyMatch ? bodyMatch[0] : '';
  const methodsParts = [];
  const resultsParts = [];

  const secRe = /<sec\b[^>]*>([\s\S]*?)<\/sec>/gi;
  let m;
  while ((m = secRe.exec(body)) !== null) {
    const content  = m[1];
    const titleEl  = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titleTxt = titleEl ? stripTags(titleEl[1]).toLowerCase() : '';
    const text     = stripTags(content);
    if (/method|material|procedure|surgery|surgical|inject|protocol|subject|animal/i.test(titleTxt)) {
      methodsParts.push(text);
    } else if (/result|finding|outcome|data|effect|expression|histol/i.test(titleTxt)) {
      resultsParts.push(text);
    }
  }

  const methods = methodsParts.length
    ? methodsParts.join('\n')
    : (hasBody ? stripTags(body).slice(0, 8000) : null);

  const results = resultsParts.length ? resultsParts.join('\n') : null;

  const captionBlocks = [...body.matchAll(/<caption[^>]*>([\s\S]*?)<\/caption>/gi)];
  const figure_legends = captionBlocks.length
    ? captionBlocks.map(b => stripTags(b[1])).join('\n')
    : null;

  return { methods, results, figure_legends, hasBody };
}

// ── Phase 1: PubMed esearch (paginated) ───────────────────────────────────────
async function searchPubMed(query, label, idx, total) {
  const pmids = new Set();
  let retstart = 0;

  while (true) {
    const url = apiUrl('esearch.fcgi', {
      db: 'pubmed', retmode: 'json',
      retmax: MAX_PER_PAGE, retstart,
      term: query,
    });
    let json;
    try {
      const raw = await get(url);
      json = JSON.parse(raw);
    } catch (e) {
      console.error(`  esearch failed for "${label}":`, e.message);
      break;
    }
    const result = json?.esearchresult;
    if (!result) break;
    (result.idlist || []).forEach(id => pmids.add(id));
    const fetched = retstart + (result.idlist?.length || 0);
    const count   = parseInt(result.count || '0', 10);
    if (fetched >= count || !result.idlist?.length) break;
    retstart = fetched;
    await sleep(RATE_MS);
  }

  const count = pmids.size;
  console.log(`[${String(idx).padStart(2)}/${total}] ${label.padEnd(50)} → ${count.toLocaleString()} PMIDs`);
  return pmids;
}

// ── Phase 2: efetch metadata ───────────────────────────────────────────────────
async function fetchMetadata(pmids) {
  const results  = [];
  const list     = [...pmids];
  let   fetched  = 0;

  for (let i = 0; i < list.length; i += BATCH_META) {
    const batch = list.slice(i, i + BATCH_META);
    const url   = apiUrl('efetch.fcgi', {
      db: 'pubmed', retmode: 'xml', rettype: 'abstract',
      id: batch.join(','),
    });
    try {
      const xml = await get(url);
      const articles = [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/gi)];

      for (const [, art] of articles) {
        const pmid     = art.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
        const pmcid    = art.match(/<ArticleId IdType="pmc">(PMC\d+)<\/ArticleId>/)?.[1] || null;
        const title    = stripTags(art.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] || '');
        const abstract = extractAbstract(art);
        const year     = art.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1] || null;
        const journal  = stripTags(art.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] || '');

        if (!pmid) continue;

        // Abstract pre-filter — must mention injection/virus technique
        const passFilter = INJECTION_RE.test(abstract || '') || INJECTION_RE.test(title);
        if (!passFilter) continue;

        results.push({ pmid, pmcid, title, abstract, year, journal });
      }
    } catch (e) {
      console.error(`  metadata batch failed at ${i}:`, e.message);
    }

    fetched += batch.length;
    process.stdout.write(`\r   Metadata fetched : ${fetched} / ${list.length}`);
    await sleep(RATE_MS);
  }

  console.log();
  return results;
}

// ── Phase 3: PMC full text (Track A — has PMCID) ──────────────────────────────
async function fetchBioC(pmcid) {
  // PMC BioC API — serves OA-subset + author-manuscript full text as JSON,
  // sometimes available when efetch XML lacks a <body>. Docs:
  //   https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/<PMCID>/unicode
  const url = `https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/${pmcid}/unicode`;
  try {
    const raw = await get(url);
    if (!raw || raw.length < 200) return null;
    // BioC's error page is HTML/plain text starting with "[Error]".
    if (/^\s*\[Error\]/i.test(raw)) return null;
    let doc;
    try { doc = JSON.parse(raw); } catch { return null; }
    // Flatten every passage's text, tagged by section_type when present.
    const methodsParts = [], resultsParts = [], figParts = [], otherParts = [];
    const documents = doc?.documents || doc?.[0]?.documents || [];
    for (const d of documents) {
      for (const psg of (d.passages || [])) {
        const t = (psg.text || '').trim();
        if (!t) continue;
        const type = (psg.infons?.section_type || psg.infons?.type || '').toLowerCase();
        if (/method|material|procedure|surg/.test(type)) methodsParts.push(t);
        else if (/result|discuss/.test(type)) resultsParts.push(t);
        else if (/fig|caption|table/.test(type)) figParts.push(t);
        else otherParts.push(t);
      }
    }
    const joined = [...methodsParts, ...resultsParts, ...figParts, ...otherParts].join(' ');
    if (joined.length < 200) return null; // nothing usable
    return {
      methods: methodsParts.length ? methodsParts.join('\n')
             : (otherParts.length ? otherParts.join('\n').slice(0, 8000) : null),
      results: resultsParts.length ? resultsParts.join('\n') : null,
      figure_legends: figParts.length ? figParts.join('\n') : null,
      hasBody: true,
      source: 'bioc',
    };
  } catch { return null; }
}

async function fetchFullText(pmcid) {
  const url = apiUrl('efetch.fcgi', {
    db: 'pmc', retmode: 'xml', rettype: 'full',
    id: pmcid.replace('PMC', ''),
  });
  let sections = null;
  try {
    const xml = await get(url);
    if (xml && xml.length >= 500) sections = parsePMCSections(xml);
  } catch { sections = null; }

  // efetch gave a real body → done.
  if (sections && sections.hasBody) return sections;

  // No <body> (publisher-blocked or empty) → try BioC before giving up.
  const bioc = await fetchBioC(pmcid);
  if (bioc && bioc.hasBody) return bioc;

  // Neither path yielded full text. Return whatever efetch parsed (may be
  // null methods) so the caller can still downgrade to Track B on abstract.
  return sections;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Rate limit : ${RATE_MS}ms (${API_KEY ? 'API key active' : 'no API key — slower'})`);
  console.log(`🚀 Two-track ingestion — ${BROAD_QUERIES.length} broad + ${REGION_QUERIES.length} region queries\n`);

  const db = loadExisting();
  const existingPMIDs = new Set(Object.keys(db));
  console.log(`Loaded ${existingPMIDs.size} existing papers from disk.\n`);

  // ── Phase 1 ────────────────────────────────────────────────────────────────
  console.log('━━━ Phase 1: PubMed search ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const allPMIDs = new Set();
  for (let i = 0; i < ALL_QUERIES.length; i++) {
    const { query, label } = ALL_QUERIES[i];
    const pmids = await searchPubMed(query, label, i + 1, ALL_QUERIES.length);
    pmids.forEach(id => allPMIDs.add(id));
    await sleep(RATE_MS);
  }

  const newPMIDs = [...allPMIDs].filter(id => !existingPMIDs.has(id));
  console.log(`\n   Unique PMIDs across all queries : ${allPMIDs.size.toLocaleString()}`);
  console.log(`   Already in DB (will skip)       : ${(allPMIDs.size - newPMIDs.length).toLocaleString()}`);
  console.log(`   New PMIDs to process            : ${newPMIDs.length.toLocaleString()}`);

  if (newPMIDs.length === 0) {
    console.log('\n✅ Nothing new to fetch.');
    return;
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────────
  console.log('\n━━━ Phase 2: PubMed metadata ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const metaRecords = await fetchMetadata(new Set(newPMIDs));

  const trackA = metaRecords.filter(p => p.pmcid);  // full text available
  const trackB = metaRecords.filter(p => !p.pmcid); // abstract only

  console.log(`   With PMCID (Track A — full text) : ${trackA.length}`);
  console.log(`   No PMCID   (Track B — abstract)  : ${trackB.length}`);
  console.log(`   Filtered out by abstract check   : ${newPMIDs.length - metaRecords.length}`);

  // ── Track B — store abstract-only papers directly ─────────────────────────
  for (const p of trackB) {
    db[p.pmid] = {
      pmid:           p.pmid,
      pmcid:          null,
      regions:        [],
      title:          p.title,
      year:           p.year,
      journal:        p.journal,
      abstract:       p.abstract,
      methods:        null,
      results:        null,
      figure_legends: null,
      track:          'B',
    };
  }
  console.log(`   Track B stored directly: ${trackB.length} papers`);

  // ── Phase 3 — Track A full text ────────────────────────────────────────────
  console.log('\n━━━ Phase 3: PMC full text (Track A) ━━━━━━━━━━━━━━━━━━━━━━━━━━');
  let stored = 0, filtered = 0, downgraded = 0, checkpointCount = 0;

  for (let i = 0; i < trackA.length; i++) {
    const p = trackA[i];

    const sections = await fetchFullText(p.pmcid);
    await sleep(RATE_MS);

    // Quality gate — must have coordinate OR titer signal somewhere
    const allText = [p.abstract, sections?.methods, sections?.results, sections?.figure_legends]
      .filter(Boolean).join(' ');

    const hasBody   = !!(sections?.methods || sections?.results || sections?.figure_legends);
    const hasSignal = COORD_RE.test(allText) || TITER_RE.test(allText);

    if (hasBody && hasSignal) {
      // Track A — full text with coordinate/titer signal.
      stored++;
      db[p.pmid] = {
        pmid:           p.pmid,
        pmcid:          p.pmcid,
        regions:        [],
        title:          p.title,
        year:           p.year,
        journal:        p.journal,
        abstract:       p.abstract,
        methods:        sections?.methods   || null,
        results:        sections?.results   || null,
        figure_legends: sections?.figure_legends || null,
        track:          'A',
      };
    } else if (p.abstract && p.abstract.length > 80) {
      // Publisher-blocked (no <body>) OR no coord signal, but a usable
      // abstract remains → keep as Track B. NEVER delete — corpus only grows.
      stored++;
      downgraded++;
      db[p.pmid] = {
        pmid:           p.pmid,
        pmcid:          p.pmcid,
        regions:        [],
        title:          p.title,
        year:           p.year,
        journal:        p.journal,
        abstract:       p.abstract,
        methods:        sections?.methods   || null,
        results:        sections?.results   || null,
        figure_legends: sections?.figure_legends || null,
        track:          hasBody ? 'A' : 'B',
      };
    } else {
      filtered++; // genuinely nothing usable (no body, no abstract)
    }

    checkpointCount++;
    if (checkpointCount >= CHECKPOINT_N) {
      saveDB(db);
      checkpointCount = 0;
    }

    process.stdout.write(
      `\r   [${i + 1}/${trackA.length}] Fetching ${p.pmcid.padEnd(14)} (stored: ${stored}, TrackB: ${downgraded}, filtered: ${filtered})`
    );
  }

  saveDB(db);
  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  const all       = Object.values(db);
  const withMeth  = all.filter(p => p.methods).length;
  const withRes   = all.filter(p => p.results).length;
  const withFig   = all.filter(p => p.figure_legends).length;
  const withAbstr = all.filter(p => p.abstract && !p.methods).length;
  const trackAct  = all.filter(p => p.track === 'A').length;
  const trackBct  = all.filter(p => p.track === 'B').length;

  console.log(`\n✅ Done — ${path.resolve(__dirname, OUTPUT_FILE)}\n`);
  console.log('📊 Summary');
  console.log(`   Total papers stored      : ${all.length}`);
  console.log(`   Track A (full text)      : ${trackAct}`);
  console.log(`   Track B (abstract only)  : ${trackBct}`);
  console.log(`   With methods text        : ${withMeth}`);
  console.log(`   With results text        : ${withRes}`);
  console.log(`   With figure legends      : ${withFig}`);
  console.log(`   Abstract-only (no coords): ${withAbstr}`);
  console.log(`   Track B downgrade (blocked): ${downgraded}`);
  console.log(`   Filtered (no signal)     : ${filtered}`);
})();
