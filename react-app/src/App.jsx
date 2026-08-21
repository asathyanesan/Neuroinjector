import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Wrench, BookOpen, Sun, Moon, Trash2, AlertTriangle, Compass } from 'lucide-react';
import MarkdownMessage from './MarkdownMessage.jsx';
import AllenAtlasViewer from './components/AllenAtlasViewer.jsx';

const WORKER_BASE = import.meta.env.VITE_WORKER_URL;

const TABS = [
  { id: 'chat', label: 'Assistant', icon: Sparkles },
  { id: 'atlas', label: 'Atlas Navigator', icon: Compass },
  { id: 'hardware', label: 'Hardware Reference', icon: Wrench },
  { id: 'literature', label: 'Surgical Literature', icon: BookOpen },
];

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION
// Rows are paginated GLOBALLY across all papers, not per paper. A user asking
// "show more" wants more coordinate rows — they don't care which paper each
// row came from. Per-paper pagination failed because a paper often has only
// 1-2 rows matching the query (<= page size), so nothing was ever "withheld"
// while whole papers sat outside the retrieval pool, unreachable.
// ─────────────────────────────────────────────────────────────────────────────
const ROW_PAGE_SIZE = 10;

// Retrieval pool size. Deliberately large: pagination walks the flattened row
// list, so the pool must hold every paper that could contribute a row.
const PAPER_POOL_SIZE = 60;

const MORE_REQUEST_RE =
  /^\s*(y|yes|yep|yeah|sure|ok|okay|please)\s*[.!]?\s*$|\bshow\s+more\b|\bmore\s+(rows|targets|coordinates|results|papers|entries)\b|\b(show|list|see|give|display)\s+(me\s+)?(the\s+)?(rest|remaining|others|next|all)\b|\bnext\s+(10|ten|page)\b|\bthe\s+rest\b/i;

function isMoreRequest(msg) {
  return MORE_REQUEST_RE.test(msg || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// REGION MATCHING
//
// ccf_region in the distilled data is FREE TEXT, not a clean acronym:
//   "VM thal", "VL thal", "Ventral lateral nucleus", "interposed nucleus", "FN"
// Normalizing by stripping punctuation ("VM thal" -> "vmthal") never matches a
// query tokenized as ["vm","thal"]. So we match on TOKEN SETS instead, and
// resolve BOTH the region label and the query to canonical CCF acronyms.
// ─────────────────────────────────────────────────────────────────────────────
const REGION_ALIASES = {
  // Cerebellum
  FN:    ['fastigial nucleus', 'fastigial', 'medial cerebellar nucleus'],
  IP:    ['interposed nucleus', 'interposed', 'interpositus', 'nucleus interpositus', 'anterior interposed'],
  DN:    ['dentate nucleus', 'lateral cerebellar nucleus'],
  SIM:   ['simplex lobule', 'simple lobule', 'lobulus simplex', 'lobule simplex', 'simplex'],
  CRUS1: ['crus 1', 'crus i'],
  CRUS2: ['crus 2', 'crus ii'],
  VERM:  ['vermis', 'cerebellar vermis'],
  IO:    ['inferior olive', 'inferior olivary', 'inferior olivary complex'],
  // Thalamus — VL and VM must stay DISTINCT
  VAL:   ['vl thal', 'vl thalamus', 'ventrolateral thalamus', 'ventro lateral thalamus',
          'ventral lateral nucleus', 'ventrolateral nucleus', 'ventral lateral thalamus',
          'ventrolateral thalamic nucleus', 'val', 'vlt'],
  VM:    ['vm thal', 'vm thalamus', 'ventromedial thalamus', 'ventro medial thalamus',
          'ventral medial nucleus', 'ventromedial nucleus of thalamus', 'ventral medial thalamus',
          'ventromedial thalamic nucleus'],
  PF:    ['parafascicular', 'parafascicular nucleus', 'pf thal'],
  CL:    ['central lateral nucleus', 'cl thal'],
  PO:    ['posterior complex', 'po thal', 'posterior thalamic nucleus'],
  PVT:   ['paraventricular thalamus', 'paraventricular nucleus of the thalamus'],
  MD:    ['mediodorsal thalamus', 'mediodorsal nucleus'],
  VPM:   ['ventral posteromedial nucleus', 'vpm thal'],
  LGN:   ['lateral geniculate', 'dorsal lateral geniculate'],
  MGN:   ['medial geniculate'],
  RT:    ['reticular nucleus of the thalamus', 'thalamic reticular nucleus'],
  // Hippocampus
  CA1:   ['field ca1', 'hippocampal ca1', 'dorsal hippocampus', 'ventral hippocampus'],
  CA2:   ['field ca2'],
  CA3:   ['field ca3'],
  DG:    ['dentate gyrus'],
  ENT:   ['entorhinal cortex', 'entorhinal'],
  SUB:   ['subiculum'],
  // Striatum / pallidum / basal forebrain
  ACB:   ['nucleus accumbens', 'accumbens', 'nac', 'nac core', 'nac shell'],
  CP:    ['caudoputamen', 'dorsal striatum', 'striatum'],
  GPE:   ['globus pallidus external', 'external globus pallidus'],
  STN:   ['subthalamic nucleus'],
  BST:   ['bed nucleus of the stria terminalis', 'bnst'],
  NBM:   ['nucleus basalis', 'nucleus basalis of meynert'],
  MS:    ['medial septum'],
  // Amygdala
  BLA:   ['basolateral amygdala', 'basolateral amygdalar nucleus'],
  CEA:   ['central amygdala', 'central amygdalar nucleus'],
  MEA:   ['medial amygdala', 'medial amygdalar nucleus'],
  // Midbrain / brainstem
  VTA:   ['ventral tegmental area'],
  SNC:   ['substantia nigra pars compacta', 'substantia nigra compact part'],
  SNR:   ['substantia nigra pars reticulata', 'substantia nigra reticular part'],
  PAG:   ['periaqueductal gray', 'periaqueductal grey'],
  SC:    ['superior colliculus'],
  IC:    ['inferior colliculus', 'central nucleus of the inferior colliculus', 'cic'],
  LC:    ['locus coeruleus'],
  DR:    ['dorsal raphe', 'dorsal raphe nucleus'],
  PB:    ['parabrachial nucleus'],
  NTS:   ['nucleus of the solitary tract'],
  PN:    ['pontine nuclei'],
  RN:    ['red nucleus'],
  // Hypothalamus
  LHA:   ['lateral hypothalamus', 'lateral hypothalamic area'],
  PVH:   ['paraventricular hypothalamic nucleus', 'pvn'],
  VMH:   ['ventromedial hypothalamus', 'ventromedial hypothalamic nucleus'],
  ARH:   ['arcuate nucleus'],
  SCH:   ['suprachiasmatic nucleus', 'scn'],
  LHB:   ['lateral habenula'],
  MHB:   ['medial habenula'],
  // Cortex / olfactory bulb
  PL:    ['prelimbic', 'prelimbic cortex'],
  ILA:   ['infralimbic', 'infralimbic cortex'],
  ACA:   ['anterior cingulate', 'anterior cingulate cortex'],
  ORB:   ['orbitofrontal cortex'],
  AI:    ['insular cortex', 'insula', 'agranular insular'],
  MOP:   ['primary motor cortex', 'm1'],
  MOS:   ['secondary motor cortex', 'm2'],
  SSP:   ['primary somatosensory', 'barrel cortex', 'barrel field'],
  VISP:  ['primary visual cortex', 'v1'],
  AUDP:  ['primary auditory cortex', 'a1'],
  RSP:   ['retrosplenial cortex'],
  PIR:   ['piriform cortex'],
  MOB:   ['olfactory bulb', 'main olfactory bulb'],
};

function tokensOf(text) {
  return new Set(
    (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  );
}

// Flattened alias index: every acronym AND every plain-language phrase, as token sets.
const ALIAS_ENTRIES = (() => {
  const out = [];
  Object.entries(REGION_ALIASES).forEach(([acr, names]) => {
    out.push({ acr, tokens: tokensOf(acr) });
    names.forEach((n) => out.push({ acr, tokens: tokensOf(n) }));
  });
  return out.filter((e) => e.tokens.size > 0);
})();

function isSubset(small, big) {
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

// Resolve free text ("VM thal", "Ventral lateral nucleus") to canonical CCF
// acronyms. An alias matches when ALL of its tokens are present — so {vm,thal}
// matches "VM thal" but NOT "VL thal".
function canonicalAcronyms(text) {
  const toks = tokensOf(text);
  const out = new Set();
  if (!toks.size) return out;
  ALIAS_ENTRIES.forEach((e) => { if (isSubset(e.tokens, toks)) out.add(e.acr); });
  return out;
}

function tokenHit(regionTok, queryToks) {
  if (queryToks.has(regionTok)) return true;
  if (regionTok.length >= 4) {
    for (const q of queryToks) {
      if (q.length >= 4 && (q.startsWith(regionTok) || regionTok.startsWith(q))) return true;
    }
  }
  return false;
}

// Score how well a region label answers a query. Higher = better.
//   60 canonical acronym intersection ("VM thal" <-> "ventromedial thalamus")
//   35 every region token present in the query (fallback for unaliased labels)
//   20 raw substring containment
function regionMatchScore(regionLabel, queryText) {
  if (!regionLabel || !queryText) return 0;
  const rTok = tokensOf(regionLabel);
  const qTok = tokensOf(queryText);
  if (!rTok.size || !qTok.size) return 0;

  const rAcr = canonicalAcronyms(regionLabel);
  const qAcr = canonicalAcronyms(queryText);
  for (const a of rAcr) if (qAcr.has(a)) return 60;

  let all = true;
  for (const t of rTok) if (!tokenHit(t, qTok)) { all = false; break; }
  if (all) return 35;

  const rl = regionLabel.toLowerCase();
  const ql = queryText.toLowerCase();
  if (ql.includes(rl) || rl.includes(ql)) return 20;

  return 0;
}

// Does the query name a brain region at all? If yes, papers with zero matching
// rows are dropped entirely — that's what stopped irrelevant PMIDs from being
// cited as "no other targets available".
function queryIsRegional(queryText) {
  return canonicalAcronyms(queryText).size > 0;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'to', 'is', 'are',
  'was', 'were', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'on', 'not',
  'but', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'about', 'which', 'what', 'how', 'when', 'where', 'who', 'i', 'we',
  'my', 'our', 'you', 'your']);

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function scoreText(words, text) {
  if (!words.length) return 0;
  const lower = (text || '').toLowerCase();
  return words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
}

// A coordinate value may be a number OR a range string ("0.1 to 0.5"), OR null.
function fmtCoord(v) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return String(v);
}
function fmtNum(v, unit) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return `${v}${unit || ''}`;
}

// ── Manual region corrections ────────────────────────────────────────────────
// region-corrections.json overrides a mis-assigned region without re-running
// distillation. Fetched at runtime, so a correction goes live on next load.
function looseEq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (String(a).trim().toLowerCase() === String(b).trim().toLowerCase()) return true;
  const an = Number(a), bn = Number(b);
  return Number.isFinite(an) && Number.isFinite(bn) && an === bn;
}

function targetMatches(target, match) {
  if (!match || match.all === true) return true;
  return Object.entries(match).every(([k, v]) => looseEq(target[k], v));
}

function applyCorrections(structuredObj, correctionsObj) {
  let applied = 0, dropped = 0;
  if (!correctionsObj || typeof correctionsObj !== 'object') return { applied, dropped };

  Object.entries(correctionsObj).forEach(([pmid, spec]) => {
    const rec = structuredObj[String(pmid)];
    if (!rec || !Array.isArray(rec.targets)) return;
    const rules = Array.isArray(spec?.corrections) ? spec.corrections : [];
    if (!rules.length) return;

    rec.targets = rec.targets.reduce((keep, t) => {
      if (!t || typeof t !== 'object') { keep.push(t); return keep; }
      let target = t, remove = false;
      rules.forEach((rule) => {
        if (!targetMatches(target, rule.match)) return;
        if (rule.drop) { remove = true; dropped++; return; }
        target = {
          ...target,
          ...(rule.set || {}),
          corrected: true,
          corrected_from: target.ccf_region || null,
          correction_note: spec.note || null,
        };
        applied++;
      });
      if (!remove) keep.push(target);
      return keep;
    }, []);
  });
  return { applied, dropped };
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'dark';
    return localStorage.getItem('ni-theme') || 'dark';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ni-theme', theme);
  }, [theme]);

  const [activeTab, setActiveTab] = useState('chat');
  const [selectedModel, setSelectedModel] = useState('gpt-5.5');

  const [hardwareKb, setHardwareKb] = useState([]);
  const [syringeDb, setSyringeDb] = useState(null);
  const [literaturePapers, setLiteraturePapers] = useState([]);
  const [injectionIndex, setInjectionIndex] = useState(new Map());
  const [passageIndex, setPassageIndex] = useState(new Map());
  const [structuredIndex, setStructuredIndex] = useState(new Map());
  const [correctionCount, setCorrectionCount] = useState(0);
  const [dataError, setDataError] = useState('');

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [atlasTarget, setAtlasTarget] = useState(null);
  const chatContainerRef = useRef(null);

  // Global row pagination state.
  const rowLimitRef  = useRef(ROW_PAGE_SIZE); // how many total rows to show
  const totalRowsRef = useRef(0);             // how many matched last turn
  const lastQueryRef = useRef('');            // verbatim query, replayed on "show more"

  useEffect(() => {
    fetch('data/hardware-kb.json').then((r) => r.json()).then(setHardwareKb).catch(() => {});
    fetch('data/hamilton-syringes.json').then((r) => r.json()).then(setSyringeDb).catch(() => {});
    fetch('data/stereotaxic-protocols.json').then((r) => r.json()).then(setLiteraturePapers).catch(() => {});
    fetch('data/injection-coordinates.json').then((r) => r.json())
      .then((arr) => setInjectionIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => {});
    fetch('data/injection-passages.json').then((r) => r.json())
      .then((arr) => setPassageIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => {});

    // PRIMARY RAG SOURCE + manual corrections, loaded together so a correction
    // can never race the data it patches.
    Promise.all([
      fetch('data/injection-structured.json').then((r) => r.json()),
      fetch('data/region-corrections.json').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([obj, corr]) => {
        const { applied, dropped } = applyCorrections(obj, corr);
        setCorrectionCount(applied + dropped);
        const entries = Object.entries(obj)
          .filter(([, rec]) => rec && Array.isArray(rec.targets))
          .map(([pmid, rec]) => [String(pmid), { ...rec, pmid: rec.pmid || pmid }]);
        setStructuredIndex(new Map(entries));
      })
      .catch(() => setDataError((e) => e || 'Could not load injection-structured.json'));
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatMessages, isLoading]);

  function getRelevantHardware(query, topN = 6) {
    const words = tokenize(query);
    const scored = hardwareKb.map((entry) => ({
      entry,
      score: scoreText(words, entry.title + ' ' + entry.content + ' ' + entry.category),
    }));
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topN).map((s) => s.entry);
  }

  function getMergedLiteraturePool() {
    const pool = new Map();

    structuredIndex.forEach((rec, key) => {
      const targets = (rec.targets || []).filter((t) => t && typeof t === 'object');
      const regionText = targets
        .map((t) => `${t.ccf_region || ''} ${t.region_verbatim || ''}`)
        .join(' ');
      pool.set(key, {
        pmid: rec.pmid, regions: [...new Set(targets.map((t) => t.ccf_region).filter(Boolean))],
        regionText, title: null, methodsText: '', passageText: '', passages: [],
        structuredTargets: targets,
      });
    });

    passageIndex.forEach((rec, key) => {
      const pText = (rec.passages || []).map((p) => p.text).join(' ');
      const existing = pool.get(key);
      if (existing) {
        existing.title = existing.title || rec.title || null;
        existing.passages = rec.passages || [];
        existing.passageText = pText;
        (rec.ccf_regions || []).forEach((r) => { if (r && !existing.regions.includes(r)) existing.regions.push(r); });
      } else {
        pool.set(key, {
          pmid: rec.pmid, regions: [...(rec.ccf_regions || [])],
          regionText: (rec.ccf_regions || []).join(' '),
          title: rec.title || null, methodsText: '', passageText: pText,
          passages: rec.passages || [], structuredTargets: [],
        });
      }
    });

    literaturePapers.forEach((p) => {
      const key = String(p.pmid);
      const existing = pool.get(key);
      if (existing) {
        existing.methodsText = p.methods || existing.methodsText;
        (p.regions || []).forEach((r) => { if (r && !existing.regions.includes(r)) existing.regions.push(r); });
      } else {
        pool.set(key, {
          pmid: p.pmid, regions: [...(p.regions || [])], regionText: (p.regions || []).join(' '),
          title: null, methodsText: p.methods || '', passageText: '', passages: [], structuredTargets: [],
        });
      }
    });

    return [...pool.values()];
  }

  const RAT_SIGNALS = /\brats?\b|\bsprague[- ]dawley\b|\bwistar\b|\blong[- ]evans\b|\bfischer\s*344\b/i;
  const MOUSE_SIGNALS = /\bmice\b|\bmouse\b|\bc57bl[\\/\s-]/i;
  function isMousePaper(entry) {
    const indexed = injectionIndex.get(String(entry.pmid));
    if (indexed?.species) return indexed.species !== 'rat';
    const structText = (entry.structuredTargets || []).map((t) => t.source_quote || '').join(' ');
    const t = `${entry.title || ''} ${entry.methodsText.slice(0, 800)} ${entry.passageText.slice(0, 400)} ${structText.slice(0, 400)}`;
    return !(RAT_SIGNALS.test(t) && !MOUSE_SIGNALS.test(t));
  }

  // Relevance of ONE coordinate row to the query.
  function targetRelevance(target, query) {
    if (!target) return 0;
    const ccf = target.ccf_region || '';
    const verb = target.region_verbatim || '';
    let score = Math.max(regionMatchScore(ccf, query), regionMatchScore(verb, query));
    if (score === 0) {
      const words = tokenize(query);
      const overlap = scoreText(words, `${ccf} ${verb}`);
      if (overlap > 0) score = overlap * 6;
      else if (scoreText(words, target.source_quote || '') > 1) score = 2;
    }
    return score;
  }

  function getRelevantRefs(query, topN = PAPER_POOL_SIZE) {
    const words = tokenize(query);
    const lowerQuery = (query || '').toLowerCase();
    const regional = queryIsRegional(query);
    const pool = getMergedLiteraturePool().filter(isMousePaper);
    if (!pool.length) return [];

    const scored = pool.map((entry) => {
      const passageText = (entry.passages || []).map((p) => p.text).join(' ');
      const text = `${entry.pmid} ${entry.title || ''} ${entry.regionText} ${passageText.slice(0, 1500)} ${entry.methodsText.slice(0, 1000)}`;
      let score = scoreText(words, text);

      let regionMatched = false;
      let bestRegion = 0;
      entry.regions.forEach((r) => {
        const s = regionMatchScore(r, query);
        if (s > bestRegion) bestRegion = s;
      });

      const structTargets = entry.structuredTargets || [];
      const scoredTargets = structTargets
        .map((t) => ({ target: t, score: targetRelevance(t, query) }))
        .sort((a, b) => b.score - a.score);
      const bestTarget = scoredTargets.length ? scoredTargets[0].score : 0;

      const regionScore = Math.max(bestRegion, bestTarget);
      if (regionScore > 0) { score += regionScore; regionMatched = true; }

      if (lowerQuery.includes(String(entry.pmid))) score += 50;

      const structWithCoords = structTargets.filter(
        (t) => t.ap_mm != null || t.ml_mm != null || t.dv_mm != null);
      if (structWithCoords.length) score += 5;

      const indexed = injectionIndex.get(String(entry.pmid));

      return {
        entry: {
          ...entry, structWithCoords, scoredTargets,
          hasStructured: structWithCoords.length > 0,
          species: indexed?.species || null,
          regionMatched, regionScore,
        },
        score,
      };
    });

    return scored
      .filter((s) => {
        if (s.score <= 0) return false;
        // Region query: a paper must contribute at least one matching row.
        if (regional && s.entry.regionScore <= 0) return false;
        return true;
      })
      .sort((a, b) =>
        b.entry.regionScore - a.entry.regionScore ||
        b.score - a.score ||
        (parseInt(b.entry.pmid, 10) || 0) - (parseInt(a.entry.pmid, 10) || 0))
      .slice(0, topN)
      .map((s) => s.entry);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Flatten every matching coordinate row across ALL retrieved papers into one
  // globally-ranked list. Pagination slices THIS list — so "show more" reaches
  // rows in papers 11, 12, 13... which per-paper pagination could never do.
  // ───────────────────────────────────────────────────────────────────────────
  function buildRowList(query) {
    const refs = getRelevantRefs(query);
    const regional = queryIsRegional(query);
    const rows = [];

    refs.forEach((ref) => {
      const scored = ref.scoredTargets || [];
      scored.forEach(({ target, score }) => {
        const hasCoord = target.ap_mm != null || target.ml_mm != null || target.dv_mm != null;
        if (!hasCoord) return;
        if (regional && score <= 0) return;   // row isn't about the asked region
        rows.push({ ref, target, score });
      });
    });

    rows.sort((a, b) =>
      b.score - a.score ||
      (parseInt(b.ref.pmid, 10) || 0) - (parseInt(a.ref.pmid, 10) || 0));

    return { rows, refs };
  }

  function buildSystemPrompt(query, rowLimit) {
    const hwHits = getRelevantHardware(query);
    const { rows, refs } = buildRowList(query);

    totalRowsRef.current = rows.length;
    const shown = rows.slice(0, rowLimit);
    const withheld = Math.max(0, rows.length - shown.length);

    // Group the shown rows back under their paper for readable citations.
    const byPmid = new Map();
    shown.forEach(({ ref, target }) => {
      const key = String(ref.pmid);
      if (!byPmid.has(key)) byPmid.set(key, { ref, targets: [] });
      byPmid.get(key).targets.push(target);
    });

    const syringeTable = syringeDb
      ? syringeDb.syringes.map((s) =>
        `${s.displayName}: ${s.divNlPerMm.toFixed(3)} nL/mm, barrel OD ${s.barrelOdMm} mm, stroke ${s.strokeLengthMm} mm, fits current hardware: ${s.hardwareCompatible ? 'YES' : 'NO'}`
      ).join('\n') +
        (syringeDb.genericReference || []).map((g) => `${g.series}: fits current hardware: NO${g.note ? ' — ' + g.note : ''}`).join('\n')
      : '(syringe database loading)';

    const hwContext = hwHits.length
      ? hwHits.map((h) => `[${h.category}] ${h.title}: ${h.content}`).join('\n\n')
      : '(no directly matching hardware KB entries — answer from the syringe table and general knowledge, and say so if unsure)';

    let citationPool;
    if (byPmid.size) {
      citationPool = [...byPmid.values()].map(({ ref, targets }, i) => {
        const pmidLink = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`;
        const header = `[${i + 1}] PMID:${ref.pmid}${ref.title ? ` — "${ref.title}"` : ''}${ref.species ? ` (${ref.species})` : ''}`;
        const lines = targets.map((t) => {
          const region = t.ccf_region || t.region_verbatim || 'unspecified region';
          const corr = t.corrected ? ' [human-corrected]' : '';
          const quote = (t.source_quote || '').trim();
          const quoteLine = quote ? `\n       source_quote: "${quote}"` : '';
          return `     • ${region}${corr} — AP ${fmtCoord(t.ap_mm)}, ML ${fmtCoord(t.ml_mm)}, DV ${fmtCoord(t.dv_mm)} mm (ref: ${t.reference || 'not stated'}); volume ${fmtNum(t.volume_nl, ' nL')}; rate ${fmtNum(t.rate_nl_min, ' nL/min')}${quoteLine}`;
        }).join('\n');
        return `${header}\n   ✓ Validated stereotaxic coordinates (OSC-distilled):\n${lines}\n   Verify full context: ${pmidLink}`;
      }).join('\n\n');
    } else {
      // No structured rows — fall back to passage text from the top papers.
      const fallback = refs.slice(0, 5).map((r, i) => {
        const p = (r.passages || [])[0];
        const excerpt = (p?.text || r.methodsText || '').trim().slice(0, 400);
        if (!excerpt) return null;
        return `[${i + 1}] PMID:${r.pmid} (regions: ${r.regions.join(', ') || 'unspecified'})\n   Injection passage: "${excerpt}${excerpt.length >= 400 ? '…' : ''}"\n   Verify: https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
      }).filter(Boolean);
      citationPool = fallback.length ? fallback.join('\n\n')
        : '(no matching indexed coordinates for this query — say so plainly and give general atlas guidance)';
    }

    const paginationBanner = withheld > 0
      ? `PAGINATION STATE: showing rows 1–${shown.length} of ${rows.length} matching coordinate rows. ${withheld} further matching row(s) exist but are NOT in your context. You MUST end your answer with exactly this line:

> Showing rows 1–${shown.length} of ${rows.length} matching rows. Reply **"show more"** to see the next ${Math.min(ROW_PAGE_SIZE, withheld)}.

Do NOT guess or reconstruct the withheld rows — you do not have them.`
      : `PAGINATION STATE: ALL ${rows.length} matching coordinate row(s) are shown. Do NOT mention pagination, row counts, or offer to show more.`;

    const firmwareRules = `
## ARDUINO FIRMWARE BEHAVIOR & KINEMATICS (.ino Specification)
- **Direct Volumetric Inputs:** The firmware natively prompts for **Flow Rate in nL/min** (0.1–1000 nL/min) and **Volume in nL** (0.1–500 nL) via Serial.
- **Automated Step Math:** Do NOT calculate manual plunger travel speeds. The firmware computes motor kinematics internally:
  * getsteps(vol) = (vol * 1600) / (syringe_div * 0.6096)
  * getsteppsec(flow) = ((flow / syringe_div) / 0.6096) / 60.0 * 1600
  * Lead Screw Pitch: 0.6096 mm/rev; Motor Resolution: 1600 steps/rev
- **Syringe Presets (syringe_div):** Opt1 Hamilton 7000.5 → 8.333 nL/mm; Opt2 Hamilton 7001 → 16.667 nL/mm; Opt3 Custom (1–1000 nL/mm).
- **Serial Modes:** 1=Extraction, 2=Injection, 3=Manual Joystick (A2), 4=Syringe Selection.
- **Hardware:** Start button Pin 13, live 1 Hz % + remaining-time countdown, pause/resume drift compensation (Pin 13), end-stop safety switch Pin 12.
`;

    const content = `You are the UD Neuroinjector Assistant: a troubleshooting helper for the open-source UD Neuroinjector automated stereotaxic injector, and a rodent stereotaxic surgery assistant for designing/troubleshooting microinjection procedures.

Only answer questions related to: (1) building, wiring, flashing, or troubleshooting the UD Neuroinjector hardware/firmware, (2) Hamilton syringe compatibility with this hardware, or (3) designing/troubleshooting rodent stereotaxic microinjection surgical procedures. If a query is unrelated, say so briefly and decline.

Ground hardware/firmware answers in the CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE and ARDUINO FIRMWARE BEHAVIOR below — do not invent part numbers, pins, or dimensions not stated there.

PROCEDURE GUIDANCE: For surgical protocol queries, provide stereotaxic coordinates, total volume (nL), and flow rate (nL/min). Clarify the user enters nL/min and nL directly into the device serial menu — no manual plunger-speed math needed.

## HOW THE COORDINATE DATA WAS EXTRACTED (interpret it the same way)
- Coordinates are in mm. "midline" ML = 0. "caudal/posterior to bregma" = negative AP; "anterior/rostral to bregma" = positive AP. DV is injection depth; "X mm below pial/dura/skull" sets the reference accordingly, otherwise reference is bregma or lambda as stated.
- A value may be a single number OR a range string ("0.1 to 0.5", "-5 to -6") — report ranges verbatim, do NOT average them.
- Volume and rate are normalized to nanoliters. A rodent brain injection is essentially never < 1 nL; treat any sub-1 nL volume as unreliable and report "not stated (source value unreliable)".
- MULTI-SITE: distinct sub-sites get SEPARATE rows. BILATERAL: appears as TWO rows, ML +X and ML −X, sharing AP/DV — report both.
- WORD-SENSE: "simplex" in "herpes simplex virus" is the VIRUS, not the cerebellar simplex lobule. A region named only as an anatomical LANDMARK is not an injection target.

## SURGICAL LITERATURE CITATION RULES — HARD CONSTRAINTS
1. Cite ONLY PMIDs from the numbered list below. NEVER invent or recall a PMID from training. Format as exactly [PMID:XXXXXXX].
2. NEVER attach a coordinate, region, volume, or rate to a PMID unless explicitly listed under that PMID below. Do NOT transfer values between papers. Do NOT fabricate numbers.
3. TABLE RULE: for any coordinate/parameter query, respond with a GitHub-flavored markdown table with EXACTLY these columns: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference | Volume | Rate | Source quote. The Source quote column MUST contain the verbatim source_quote for that row, or "—" if absent. Do NOT add a Notes column.
4. VALIDATED COORDINATES: report AP/ML/DV/reference/volume/rate EXACTLY as given — do NOT re-derive, round, or alter them. Report "not stated" ONLY when the line literally says so. Rows marked [human-corrected] are verified — report them with full confidence.
5. REGION AUTHORITY: the ccf_region value IS the validated region (Allen CCF acronym, e.g. "SIM" = simplex lobule, "CA1", "ACB", "CP"). Report THAT specific region — never downgrade to a parent structure ("Cerebellum" for "SIM", "Hippocampus" for "CA1"). You may expand the acronym for clarity but never replace the structure with its parent.
6. RANGES: report the FULL range exactly as given — never collapse to one endpoint or average.
7. REGION BINDING: a coordinate set belongs ONLY to the region named on its own row. Multiple targets = separate rows with their own source_quote. Lambda- and bregma-referenced values are NOT interchangeable — always report the Reference column.
8. If NONE of the listed rows name the requested region, say so plainly and give general atlas guidance — do NOT substitute another structure's coordinates. It is correct to say "the indexed literature does not contain a coordinate for X."
9. Every coordinate row must include its [PMID:XXXXXXX] link.
10. Close literature-grounded answers with a one-line reminder that this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.
11. PAGINATION: obey the PAGINATION STATE block below exactly. Rows are paginated GLOBALLY across all papers — a page may mix papers. If the state says all rows are shown, do NOT mention pagination or offer more. If it says rows are withheld, emit the specified line verbatim and nothing else about pagination.
12. NEVER render an empty table. If you have no rows to show for the requested region, answer in prose only — no table header, no blank rows.
13. Do NOT cite or name a PMID unless you display at least one of its coordinate rows in the table.

${paginationBanner}

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## RELEVANT SURGICAL LITERATURE — ${shown.length} coordinate row(s) across ${byPmid.size} paper(s), most relevant first
${citationPool}`;

    return { role: 'system', content };
  }

  async function* streamSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* skip malformed chunk */ }
      }
    }
  }

  async function callModel(deployment, messages, onToken) {
    if (!WORKER_BASE) throw new Error('VITE_WORKER_URL is not configured — see react-app/README.md.');
    const url = `${WORKER_BASE}/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_completion_tokens: 4000, stream: true }),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const msg = (() => { try { return JSON.parse(raw)?.error?.message || ''; } catch { return raw; } })();
      throw new Error(`${deployment} error ${response.status}: ${msg || response.statusText}`);
    }
    let full = '';
    for await (const token of streamSSE(response)) {
      full += token;
      onToken(full);
    }
    return full;
  }

  function linkifyPmids(text) {
    return (text || '').replace(/\[PMID:(\d{5,9})\](?!\()/g,
      (_, pmid) => `[[PMID:${pmid}]](https://pubmed.ncbi.nlm.nih.gov/${pmid}/)`);
  }

  async function handleChat(userMessage) {
    if (!userMessage.trim()) return;
    setIsLoading(true);
    setChatInput('');
    const newMessage = { role: 'user', content: userMessage };
    const updatedMessages = [...chatMessages, newMessage];
    const streamingIdx = updatedMessages.length;
    setChatMessages([...updatedMessages, { role: 'assistant', content: '' }]);

    try {
      const wantsMore = isMoreRequest(userMessage);

      // RETRIEVAL ISOLATION: the retrieval query is the USER'S message only.
      // Including prior assistant text polluted it with every region name and
      // PMID from the previous answer, so identical questions returned different
      // papers depending on conversation history (and differed between users).
      let ragQuery;
      if (wantsMore && lastQueryRef.current) {
        ragQuery = lastQueryRef.current;                 // replay verbatim
        rowLimitRef.current += ROW_PAGE_SIZE;            // reveal the next page
      } else {
        ragQuery = userMessage;
        lastQueryRef.current = userMessage;
        rowLimitRef.current = ROW_PAGE_SIZE;             // new query -> page 1
      }

      setLoadingStatus('Finding relevant coordinates…');
      const systemPrompt = buildSystemPrompt(ragQuery, rowLimitRef.current);

      // Don't let the limit run away past the available rows.
      if (rowLimitRef.current > totalRowsRef.current + ROW_PAGE_SIZE) {
        rowLimitRef.current = Math.max(ROW_PAGE_SIZE, totalRowsRef.current);
      }

      const messagesWithSystem = [systemPrompt, ...updatedMessages];
      setLoadingStatus(`Composing answer with ${selectedModel}…`);

      let firstToken = true;
      const onToken = (partial) => {
        if (firstToken && partial) { firstToken = false; setLoadingStatus(''); }
        setChatMessages((prev) => {
          const next = [...prev];
          next[streamingIdx] = { role: 'assistant', content: partial };
          return next;
        });
      };

      const responseText = await callModel(selectedModel, messagesWithSystem, onToken);
      setChatMessages((prev) => {
        const next = [...prev];
        next[streamingIdx] = { role: 'assistant', content: linkifyPmids(responseText) };
        return next;
      });
    } catch (error) {
      setChatMessages((prev) => {
        const next = [...prev];
        next[streamingIdx] = { role: 'assistant', content: `⚠️ **Error**: ${error.message}` };
        return next;
      });
    } finally {
      setIsLoading(false);
      setLoadingStatus('');
    }
  }

  function clearChat() {
    if (chatMessages.length === 0) return;
    if (window.confirm('Clear the conversation? This cannot be undone.')) {
      setChatMessages([]);
      rowLimitRef.current = ROW_PAGE_SIZE;
      totalRowsRef.current = 0;
      lastQueryRef.current = '';
    }
  }

  function askAboutAtlasTarget() {
    if (!atlasTarget) return;
    const regionLabel = atlasTarget.name ? `${atlasTarget.region} (${atlasTarget.name})` : atlasTarget.region;
    setChatInput(`What injection protocol, volume, and flow rate would you recommend for targeting ${regionLabel} in mice, around AP ${atlasTarget.ap} mm, ML ${atlasTarget.ml} mm, DV ${atlasTarget.dv} mm from Bregma?`);
    setActiveTab('chat');
  }

  // ── Console debug helper: window.niDebug('VM Thal') ───────────────────────
  // Verifies retrieval WITHOUT involving the LLM. Prints the global row list
  // exactly as pagination will slice it.
  useEffect(() => {
    window.niDebug = (query) => {
      const { rows, refs } = buildRowList(query);
      console.log(`niDebug("${query}") → ${refs.length} papers, ${rows.length} matching rows`);
      if (!rows.length) { console.log('  NO MATCHING ROWS'); return; }
      rows.slice(0, 30).forEach((r, i) => {
        const t = r.target;
        console.log(
          `  ${String(i + 1).padStart(2)}. score ${String(r.score).padStart(2)}  PMID:${r.ref.pmid}  ` +
          `${t.ccf_region || t.region_verbatim} | AP ${t.ap_mm} ML ${t.ml_mm} DV ${t.dv_mm} ref ${t.reference}`
        );
      });
      if (rows.length > 30) console.log(`  … ${rows.length - 30} more`);
      console.log(`  page 1 shows rows 1–${Math.min(ROW_PAGE_SIZE, rows.length)}`);
    };
    return () => { delete window.niDebug; };
  }, [structuredIndex, passageIndex, literaturePapers, injectionIndex]);

  const examplePrompts = [
    'My injector shows no serial output after flashing new firmware — what should I check?',
    'Will a Hamilton Neuros 65458-01 syringe fit my current build?',
    'What AP/ML/DV coordinates and infusion rate are typical for cerebellar simplex lobule injections in mice?',
    'The injected volume seems consistently too low — what could cause that?',
  ];

  const structuredCount = structuredIndex.size;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Sparkles size={20} />
          <span>Neuroinjector Assistant</span>
        </div>
        <nav className="tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} className={activeTab === tab.id ? 'tab active' : 'tab'}
                onClick={() => setActiveTab(tab.id)}>
                <Icon size={16} /> {tab.label}
              </button>
            );
          })}
        </nav>
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          <span className="theme-label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <p className="disclaimer">
          <AlertTriangle size={12} /> AI can make mistakes. Not a substitute for IACUC-approved
          protocols or veterinary guidance. Verify hardware steps against the assembly PDF.
        </p>
      </aside>

      <main className="main">
        {activeTab === 'chat' && (
          <div className="chat-view">
            <div className="chat-toolbar">
              <div className="model-picker">
                <button className={selectedModel === 'gpt-5.5' ? 'active' : ''} onClick={() => setSelectedModel('gpt-5.5')}>GPT-5.5</button>
                <button className={selectedModel === 'gpt-5.4' ? 'active' : ''} onClick={() => setSelectedModel('gpt-5.4')}>GPT-5.4</button>
              </div>
              {chatMessages.length > 0 && (
                <button className="icon-btn" onClick={clearChat} title="Clear chat"><Trash2 size={14} /> Clear</button>
              )}
            </div>

            <div className="messages" ref={chatContainerRef}>
              {chatMessages.length === 0 ? (
                <div className="empty-state">
                  <Sparkles size={40} />
                  <h2>UD Neuroinjector Assistant</h2>
                  <p>Ask about hardware troubleshooting, syringe compatibility, or rodent stereotaxic injection procedures.</p>
                  {dataError && <p className="error">{dataError}</p>}
                  <div className="example-prompts">
                    {examplePrompts.map((p, i) => (
                      <button key={i} onClick={() => setChatInput(p)}>{p}</button>
                    ))}
                  </div>
                </div>
              ) : (
                chatMessages.map((msg, idx) => (
                  <div key={idx} className={`bubble-row ${msg.role}`}>
                    <div className="bubble">
                      {msg.role === 'user'
                        ? <p className="msg-p">{msg.content}</p>
                        : msg.content
                          ? <MarkdownMessage content={msg.content} />
                          : (
                            <div className="typing-status">
                              <div className="typing"><span /><span /><span /></div>
                              {loadingStatus && <span className="typing-label">{loadingStatus}</span>}
                            </div>
                          )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="input-bar">
              <textarea
                rows={1}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
                    e.preventDefault();
                    handleChat(chatInput);
                  }
                }}
                placeholder="Ask about hardware, syringes, or surgical procedures..."
                disabled={isLoading}
              />
              <button onClick={() => handleChat(chatInput)} disabled={isLoading || !chatInput.trim()}>
                <Send size={16} />
              </button>
            </div>
          </div>
        )}

        {activeTab === 'atlas' && (
          <div className="atlas-view">
            <AllenAtlasViewer onTargetSelect={setAtlasTarget} />
            <div className="atlas-side-panel">
              <h2>Atlas Navigator</h2>
              <p className="atlas-help">
                Search a CCFv3 structure (e.g. CA1, BLA, CP) or click directly on a coronal slice to
                estimate Bregma-relative AP/ML/DV coordinates, then send the target straight to the
                assistant for an injection protocol recommendation.
              </p>
              {atlasTarget ? (
                <div className="atlas-target-summary">
                  <h3>{atlasTarget.region}{atlasTarget.name ? ` — ${atlasTarget.name}` : ''}</h3>
                  <p>AP {atlasTarget.ap} mm · ML {atlasTarget.ml} mm · DV {atlasTarget.dv} mm</p>
                  <button className="primary-btn" onClick={askAboutAtlasTarget}>Ask assistant about this target</button>
                </div>
              ) : (
                <p className="atlas-help">No target selected yet.</p>
              )}
              <p className="atlas-attribution">
                Coordinates are estimated from the Allen Institute Mouse Brain CCFv3 (2020) reference
                atlas and are approximate — always verify against a printed stereotaxic atlas before surgery.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'hardware' && (
          <div className="ref-view">
            <h2>Hardware Reference</h2>
            {hardwareKb.map((entry) => (
              <div key={entry.id} className="kb-card">
                <div className="kb-category">{entry.category}</div>
                <h3>{entry.title}</h3>
                <p>{entry.content}</p>
              </div>
            ))}
            {syringeDb && (
              <>
                <h2>Syringe Compatibility</h2>
                <table className="ref-table">
                  <thead><tr><th>Model</th><th>nL/mm</th><th>Barrel OD</th><th>Stroke</th><th>Fits current hardware</th></tr></thead>
                  <tbody>
                    {syringeDb.syringes.map((s) => (
                      <tr key={s.id}>
                        <td>{s.displayName}</td><td>{s.divNlPerMm.toFixed(3)}</td>
                        <td>{s.barrelOdMm} mm</td><td>{s.strokeLengthMm} mm</td>
                        <td>{s.hardwareCompatible ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                    {(syringeDb.genericReference || []).map((g, i) => (
                      <tr key={i}><td>{g.series}</td><td>—</td><td>{g.barrelOdMm ?? '—'} mm</td><td>{g.strokeLengthMm ?? '—'}</td><td>No</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {activeTab === 'literature' && (
          <div className="ref-view">
            <h2>Surgical Literature Corpus</h2>
            <p>
              {structuredCount} papers with validated structured stereotaxic coordinates (OSC-distilled).
              {correctionCount > 0 && ` ${correctionCount} manual region correction(s) applied.`}
            </p>
            <div className="paper-list">
              {[...structuredIndex.values()].slice(0, 100).map((rec) => {
                const t = (rec.targets || []).find((x) => x && (x.ap_mm != null || x.ml_mm != null || x.dv_mm != null)) || (rec.targets || [])[0];
                const nMore = Math.max(0, (rec.targets || []).length - 1);
                return (
                  <div key={rec.pmid} className="paper-card">
                    <div className="paper-meta">
                      <a href={`https://pubmed.ncbi.nlm.nih.gov/${rec.pmid}/`} target="_blank" rel="noreferrer">PMID:{rec.pmid}</a>
                      <span>{t ? (t.ccf_region || t.region_verbatim || '') : ''}</span>
                    </div>
                    <p>
                      {t
                        ? `${t.ccf_region || t.region_verbatim || 'region'} — AP ${fmtCoord(t.ap_mm)}, ML ${fmtCoord(t.ml_mm)}, DV ${fmtCoord(t.dv_mm)} mm (ref: ${t.reference || 'n/s'})${t.corrected ? ' [corrected]' : ''}${nMore ? ` · +${nMore} more target(s)` : ''}`
                        : 'No structured coordinate extracted.'}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
