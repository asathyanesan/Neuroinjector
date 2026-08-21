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

// Coordinate rows shown per paper before pagination kicks in.
const TARGET_PAGE_SIZE = 10;

// Detects a follow-up asking for the next page of rows.
const MORE_REQUEST_RE =
  /^\s*(y|yes|yep|yeah|sure|ok|okay|please)\s*[.!]?\s*$|\bshow\s+more\b|\bmore\s+(rows|targets|coordinates|results|papers|entries)\b|\b(show|list|see|give|display)\s+(me\s+)?(the\s+)?(rest|remaining|others|next|all)\b|\bnext\s+(10|ten|page)\b|\bthe\s+rest\b/i;

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
          'ventral lateral nucleus', 'ventrolateral nucleus', 'ventral lateral thalamus', 'val'],
  VM:    ['vm thal', 'vm thalamus', 'ventromedial thalamus', 'ventro medial thalamus',
          'ventral medial nucleus', 'ventromedial nucleus of thalamus', 'ventral medial thalamus'],
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
  // Striatum / pallidum / BF
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
  IC:    ['inferior colliculus', 'central nucleus of the inferior colliculus'],
  LC:    ['locus coeruleus'],
  DR:    ['dorsal raphe', 'dorsal raphe nucleus'],
  PB:    ['parabrachial nucleus'],
  NTS:   ['nucleus of the solitary tract'],
  PN:    ['pontine nuclei'],
  // Hypothalamus
  LHA:   ['lateral hypothalamus', 'lateral hypothalamic area'],
  PVH:   ['paraventricular hypothalamic nucleus', 'pvn'],
  VMH:   ['ventromedial hypothalamus', 'ventromedial hypothalamic nucleus'],
  ARH:   ['arcuate nucleus'],
  SCH:   ['suprachiasmatic nucleus', 'scn'],
  LHB:   ['lateral habenula'],
  MHB:   ['medial habenula'],
  // Cortex / OB
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

// Resolve any free text ("VM thal", "Ventral lateral nucleus", "VL Thal") to the
// set of canonical CCF acronyms it implies. An alias matches when ALL of its
// tokens are present — so {vm,thal} matches "VM thal" but NOT "VL thal".
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

  // Require EVERY region token to hit, so "VL thal" cannot match a "VM thal"
  // query on the shared "thal" token alone.
  let all = true;
  for (const t of rTok) { if (!tokenHit(t, qTok)) { all = false; break; } }
  if (all) return 35;

  const lq = queryText.toLowerCase();
  const lr = regionLabel.toLowerCase();
  if (lr.length >= 3 && lq.includes(lr)) return 20;
  return 0;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'to', 'is', 'are',
  'was', 'were', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'on', 'not',
  'but', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'about', 'which', 'what', 'how', 'when', 'where', 'who', 'i', 'we',
  'my', 'our', 'you', 'your']);

// Keep 2-char tokens so region acronyms (FN, CP, IO, SC, DG, VM, VL) survive.
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

// ── Manual region corrections (runtime data file, no rebuild needed) ─────────
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
          ...target, ...(rule.set || {}),
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

// Relevance of a single coordinate row to the query — used to RANK rows within
// a paper before the page-size slice, so the matching row is never cut.
function targetRelevance(target, query) {
  if (!target || typeof target !== 'object') return 0;
  let score = 0;
  score += regionMatchScore(target.ccf_region, query);
  score += Math.round(regionMatchScore(target.region_verbatim, query) * 0.8);
  const words = tokenize(query);
  score += scoreText(words, `${target.ccf_region || ''} ${target.region_verbatim || ''}`) * 4;
  score += Math.min(6, scoreText(words, (target.source_quote || '').slice(0, 400)));
  if (target.ap_mm != null || target.ml_mm != null || target.dv_mm != null) score += 1;
  return score;
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

  // Pagination state
  const targetLimitRef = useRef(TARGET_PAGE_SIZE);
  const truncationRef = useRef({ truncated: false });

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
        pmid: rec.pmid,
        regions: [...new Set(targets.map((t) => t.ccf_region).filter(Boolean))],
        regionText,
        title: null,
        methodsText: '',
        passageText: '',
        passages: [],
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
          pmid: rec.pmid, regions: [...(rec.ccf_regions || [])], regionText: (rec.ccf_regions || []).join(' '),
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
    const isRat = RAT_SIGNALS.test(t);
    const isMouse = MOUSE_SIGNALS.test(t);
    return !(isRat && !isMouse);
  }

  function getRelevantRefs(query, topN = 10) {
    const words = tokenize(query);
    const lowerQuery = (query || '').toLowerCase();
    const pool = getMergedLiteraturePool().filter(isMousePaper);
    if (!pool.length) return [];

    const scored = pool.map((entry) => {
      const passageText = (entry.passages || []).map((p) => p.text).join(' ');
      const text = `${entry.pmid} ${entry.title || ''} ${entry.regionText} ${passageText.slice(0, 1500)} ${entry.methodsText.slice(0, 1000)}`;
      let score = scoreText(words, text);

      // Region matching — SAME scorer used for within-paper ranking, so the
      // paper score and the row score can never disagree.
      let bestRegion = 0;
      entry.regions.forEach((r) => { bestRegion = Math.max(bestRegion, regionMatchScore(r, query)); });
      (entry.structuredTargets || []).forEach((t) => {
        bestRegion = Math.max(bestRegion, regionMatchScore(t.ccf_region, query));
        bestRegion = Math.max(bestRegion, regionMatchScore(t.region_verbatim, query));
      });
      const regionMatched = bestRegion > 0;
      score += bestRegion;

      if (lowerQuery.includes(String(entry.pmid))) score += 50;

      const structTargets = entry.structuredTargets || [];
      const structWithCoords = structTargets.filter(
        (t) => t.ap_mm != null || t.ml_mm != null || t.dv_mm != null);
      if (structWithCoords.length) score += 5;
      if (structWithCoords.length && regionMatched) score += 3;

      const indexed = injectionIndex.get(String(entry.pmid));

      return {
        entry: {
          ...entry,
          structWithCoords,
          hasStructured: structWithCoords.length > 0,
          species: indexed?.species || null,
          regionMatched,
          regionScore: bestRegion,
        },
        score,
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (parseInt(b.entry.pmid, 10) || 0) - (parseInt(a.entry.pmid, 10) || 0))
      .slice(0, topN)
      .map((s) => s.entry);
  }

  // Console diagnostic: niDebug('VM Thal') — inspect scoring WITHOUT the LLM.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.niDebug = (q) => {
      const refs = getRelevantRefs(q, 8);
      console.log(`── niDebug("${q}") — ${refs.length} papers ──`);
      refs.forEach((r) => {
        const ranked = (r.structWithCoords || [])
          .map((t) => ({ t, s: targetRelevance(t, q) }))
          .sort((a, b) => b.s - a.s);
        const hits = ranked.filter((x) => x.s > 0);
        console.log(`${r.pmid}  regionScore ${r.regionScore}  matched ${hits.length}/${ranked.length} targets`);
        hits.slice(0, 5).forEach(({ t, s }) =>
          console.log(`   score ${s}  ${t.ccf_region} | AP ${fmtCoord(t.ap_mm)} ML ${fmtCoord(t.ml_mm)} DV ${fmtCoord(t.dv_mm)} ref ${t.reference || 'n/s'}`));
      });
      return refs;
    };
    return () => { try { delete window.niDebug; } catch { /* noop */ } };
  });

  function buildSystemPrompt(query, limit = TARGET_PAGE_SIZE) {
    const hwHits = getRelevantHardware(query);
    const relevantRefs = getRelevantRefs(query, 10);

    const syringeTable = syringeDb
      ? syringeDb.syringes.map((s) =>
        `${s.displayName}: ${s.divNlPerMm.toFixed(3)} nL/mm, barrel OD ${s.barrelOdMm} mm, stroke ${s.strokeLengthMm} mm, fits current hardware: ${s.hardwareCompatible ? 'YES' : 'NO'}`
      ).join('\n') +
        (syringeDb.genericReference || []).map((g) => `${g.series}: fits current hardware: NO${g.note ? ' — ' + g.note : ''}`).join('\n')
      : '(syringe database loading)';

    const hwContext = hwHits.length
      ? hwHits.map((h) => `[${h.category}] ${h.title}: ${h.content}`).join('\n\n')
      : '(no directly matching hardware KB entries — answer from the syringe table and general knowledge, and say so if unsure)';

    let anyRelevantWithheld = false;

    const citationPool = relevantRefs.length
      ? relevantRefs.map((r, i) => {
        const pmidLink = `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
        const header = `[${i + 1}] PMID:${r.pmid}${r.title ? ` — "${r.title}"` : ''}${r.species ? ` (${r.species})` : ''}`;

        if (r.hasStructured) {
          // Rank rows by relevance to THIS query, then slice — so the matching
          // row is on page 1 rather than buried at raw array position ~15.
          const ranked = [...r.structWithCoords]
            .map((t) => ({ t, rel: targetRelevance(t, query) }))
            .sort((a, b) => b.rel - a.rel);

          const total = ranked.length;
          const shown = ranked.slice(0, limit);
          const withheld = ranked.slice(limit);
          // Only rows that ACTUALLY match the query count as worth paginating.
          const relevantWithheld = withheld.filter((x) => x.rel > 0).length;
          if (relevantWithheld > 0) anyRelevantWithheld = true;

          const lines = shown.map(({ t }) => {
            const region = t.ccf_region || t.region_verbatim || 'unspecified region';
            const ap = fmtCoord(t.ap_mm), ml = fmtCoord(t.ml_mm), dv = fmtCoord(t.dv_mm);
            const ref = t.reference || 'not stated';
            const vol = fmtNum(t.volume_nl, ' nL');
            const rate = fmtNum(t.rate_nl_min, ' nL/min');
            const corrTag = t.corrected ? ' [human-corrected]' : '';
            const quote = (t.source_quote || '').trim();
            const quoteLine = quote ? `\n       source_quote: "${quote}"` : '';
            return `     • ${region} — AP ${ap}, ML ${ml}, DV ${dv} mm (ref: ${ref})${corrTag}; volume ${vol}; rate ${rate}${quoteLine}`;
          }).join('\n');

          const marker = relevantWithheld > 0
            ? `\n   [PAGINATED] Showing ${shown.length} of ${total} rows for this PMID. ${relevantWithheld} additional row(s) that ALSO match this query are withheld — the user must ask for more to see them.`
            : (total > shown.length
              ? `\n   [COMPLETE FOR THIS QUERY] All rows relevant to this query are shown. The remaining ${total - shown.length} row(s) are for OTHER regions — do NOT mention them and do NOT offer to show more.`
              : '');

          return `${header}\n   ✓ Validated stereotaxic coordinates (OSC-distilled, 92% verified):\n${lines}${marker}\n   Verify full context: ${pmidLink}`;
        }

        const p = (r.passages || [])[0];
        const excerpt = (p?.text || r.methodsText || '').trim().slice(0, 400);
        const evidence = excerpt
          ? `Injection passage${p?.reference_point ? ` [ref: ${p.reference_point}]` : ''}: "${excerpt}${excerpt.length >= 400 ? '…' : ''}"`
          : 'No structured coordinates or passage indexed for this paper.';
        return `${header} (regions: ${r.regions.join(', ') || 'unspecified'})\n   ${evidence}\n   Verify full context: ${pmidLink}`;
      }).join('\n\n')
      : '(no directly matching surgical literature indexed for this query — answer from general veterinary/stereotaxic knowledge and say so)';

    truncationRef.current = { truncated: anyRelevantWithheld };

    const paginationBanner = anyRelevantWithheld
      ? `PAGINATION STATE: at least one paper is marked [PAGINATED]. After the table, add ONE italic line per paginated paper:
    > Showing rows 1–N of M for [PMID:XXXXXXX]. Reply **"show more"** to see the next ${TARGET_PAGE_SIZE}.
   Do NOT mention pagination for papers marked [COMPLETE FOR THIS QUERY].`
      : `PAGINATION STATE: every row relevant to this query is already shown. Do NOT mention pagination, do NOT print row counts, and do NOT offer to show more.`;

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
- Volume and rate are normalized to nanoliters. A rodent brain injection is essentially never < 1 nL; treat any sub-1 nL volume or sub-0.1 nL/min rate as unreliable and report it as "not stated (source value unreliable)".
- MULTI-SITE: distinct sub-sites get a SEPARATE line each — keep them on separate rows.
- BILATERAL: appears as TWO lines, ML +X and ML −X, sharing AP/DV — report both.
- WORD-SENSE: "simplex" in "herpes simplex virus"/"HSV" is the VIRUS, not the cerebellar simplex lobule. A region named only as an anatomical LANDMARK is not an injection target.
- REGION LABELS ARE ABBREVIATED IN THE SOURCE DATA: "VL thal" = ventrolateral (ventral lateral) thalamic nucleus; "VM thal" = ventromedial (ventral medial) thalamic nucleus; "FN" = fastigial nucleus; "IP" = interposed nucleus; "SIM" = simplex lobule. Treat these abbreviations as EXACT matches for the user's plain-language query and report them as valid answers. VL and VM are DIFFERENT nuclei — never substitute one for the other.

## SURGICAL LITERATURE CITATION RULES — HARD CONSTRAINTS
1. Cite ONLY PMIDs from the numbered list below. NEVER invent, recall, or guess a PMID. Format as exactly [PMID:XXXXXXX].
2. NEVER attach a coordinate, region, volume, or rate to a PMID unless it is explicitly listed under that PMID below. Do NOT transfer values between papers. If a line lacks a value, it is "not stated".
3. TABLE RULE: for coordinate/target/parameter queries, respond with a GitHub-flavored markdown table with EXACTLY: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference | Volume | Rate | Source quote. The Source quote column MUST contain the verbatim source_quote for that line, copied exactly ("—" if none). No separate Notes column.
4. VALIDATED COORDINATES: entries marked "✓ Validated stereotaxic coordinates" are pre-parsed, human-verified fields. Report AP/ML/DV/reference/volume/rate EXACTLY as given — do NOT re-derive, round, or alter them, and do NOT write "not stated" when a value is present.
5. REGION AUTHORITY: the ccf_region value IS the validated region for that line. Report THIS specific region — do NOT downgrade it to a parent structure ("Cerebellum" for "SIM", "Thalamus" for "VM thal"). Expanding the abbreviation for clarity is encouraged ("VM thal (ventromedial thalamic nucleus)"). A row tagged [human-corrected] was manually verified — trust it over any conflicting text.
6. RANGES: report the FULL range exactly as given — never collapse or average.
7. REGION BINDING: coordinates belong ONLY to the region on their own line. Multiple targets go on SEPARATE rows with their own quotes. Lambda- and bregma-referenced values are NOT interchangeable — always report Reference.
8. If NONE of the listed rows name the requested region, say so plainly in PROSE and give general atlas guidance — do NOT substitute another structure's coordinates.
9. Every coordinate row must include its [PMID:XXXXXXX] link.
10. Close literature-grounded answers with a one-line reminder that this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.
11. PAGINATION: only papers explicitly marked [PAGINATED] have additional matching rows. Papers marked [COMPLETE FOR THIS QUERY] have no further relevant rows — never mention their hidden rows or offer to show more for them. If NO paper is marked [PAGINATED], do not mention pagination or row counts at all.
12. NEVER output an empty table (header row with no data). If there are no matching rows, answer in prose only.
13. Only cite a PMID if you display at least one of its coordinate rows. Do not reference a paper you are not showing data from.

${paginationBanner}

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## RELEVANT SURGICAL LITERATURE (rows ranked by relevance to this query; ${relevantRefs.length} papers)
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

  // "show more" grows the page only when rows were ACTUALLY withheld.
  function resolveTargetLimit(userMessage) {
    const wantsMore = MORE_REQUEST_RE.test(userMessage.trim());
    if (wantsMore && truncationRef.current.truncated) {
      targetLimitRef.current += TARGET_PAGE_SIZE;
    } else if (!wantsMore) {
      targetLimitRef.current = TARGET_PAGE_SIZE;
    }
    return targetLimitRef.current;
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
      setLoadingStatus('Finding relevant papers…');
      const recentContext = chatMessages.filter((m) => m.role !== 'system').slice(-4)
        .map((m) => m.content).join(' ');
      const wantsMore = MORE_REQUEST_RE.test(userMessage.trim());
      // On "show more", reuse the prior query — "more" is a meaningless retrieval
      // token and would otherwise shift which papers come back mid-pagination.
      const ragQuery = wantsMore ? recentContext.trim() : `${recentContext} ${userMessage}`.trim();
      const limit = resolveTargetLimit(userMessage);

      setLoadingStatus('Reading validated coordinates…');
      const systemPrompt = buildSystemPrompt(ragQuery, limit);
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
      targetLimitRef.current = TARGET_PAGE_SIZE;
      truncationRef.current = { truncated: false };
    }
  }

  function askAboutAtlasTarget() {
    if (!atlasTarget) return;
    const regionLabel = atlasTarget.name ? `${atlasTarget.region} (${atlasTarget.name})` : atlasTarget.region;
    setChatInput(`What injection protocol, volume, and flow rate would you recommend for targeting ${regionLabel} in mice, around AP ${atlasTarget.ap} mm, ML ${atlasTarget.ml} mm, DV ${atlasTarget.dv} mm from Bregma?`);
    setActiveTab('chat');
  }

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
              {structuredCount} papers with validated structured stereotaxic coordinates (OSC-distilled, 92% verified).
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
