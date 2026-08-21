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
// PAGINATION — rows are paginated GLOBALLY across all papers, because a single
// paper rarely has >10 rows matching one region. Paging per-paper meant "show
// more" had nothing to give while whole papers sat outside the pool.
// ─────────────────────────────────────────────────────────────────────────────
const ROW_PAGE_SIZE = 10;
const PAPER_POOL_SIZE = 60;

// A row must score at least this much to count as a match for a REGIONAL query.
// Label matches score 35–60; the source-quote signal is capped at +5 so a quote
// alone can NEVER qualify a row (that leak pulled "ventromedial striatum" into a
// "VM Thal" query because its quote says "the VM region of the striatum").
const MIN_ROW_SCORE = 30;

const MORE_REQUEST_RE =
  /^\s*(y|yes|yep|yeah|sure|ok|okay|please)\s*[.!]?\s*$|\bshow\s+more\b|\bmore\s+(rows|targets|coordinates|results|papers|entries)\b|\b(show|list|see|give|display)\s+(me\s+)?(the\s+)?(rest|remaining|others|next|all)\b|\bnext\s+(10|ten|page)\b|\bthe\s+rest\b/i;

function isMoreRequest(msg) {
  return MORE_REQUEST_RE.test(msg || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// REGION MATCHING
//
// ccf_region is FREE TEXT: "VM thal", "Ventral lateral nucleus", "VM", "VL/VM",
// "ventromedial striatum", "ventral midbrain". Matching therefore runs on TOKEN
// SETS with canonical-acronym resolution on BOTH the label and the query.
//
// RULE 1 — label resolution requires token-set EQUALITY (after dropping generic
//   filler words), NOT subset. Subset matching wrongly mapped "ventral posterior
//   medial nucleus" (VPM) and "ventral medial geniculate nucleus" (MGv) onto VM,
//   because {ventral, medial, nucleus} is a subset of both and the discriminative
//   tokens (posterior, geniculate) were ignored. Query resolution stays subset,
//   since a query legitimately carries extra words.
//
// RULE 2 — HARD DISQUALIFIERS run BEFORE any scoring. Anatomy reuses adjectives
//   ("ventral", "medial") across unrelated structures, so alias resolution alone
//   leaks. If the query resolves to VM and the label contains "striat" or
//   "midbrain", the row is rejected outright — no score, no tiebreak.
// ─────────────────────────────────────────────────────────────────────────────
const REGION_ALIASES = {
  // Cerebellum
  FN:    ['fn', 'fastigial nucleus', 'fastigial', 'medial cerebellar nucleus'],
  IP:    ['ip', 'interposed nucleus', 'interposed', 'interpositus', 'nucleus interpositus', 'anterior interposed'],
  DN:    ['dn', 'dentate nucleus', 'lateral cerebellar nucleus'],
  SIM:   ['sim', 'simplex lobule', 'simple lobule', 'lobulus simplex', 'lobule simplex', 'simplex'],
  CRUS1: ['crus 1', 'crus i'],
  CRUS2: ['crus 2', 'crus ii'],
  VERM:  ['vermis', 'cerebellar vermis'],
  IO:    ['io', 'inferior olive', 'inferior olivary', 'inferior olivary complex'],
  // Thalamus — VL and VM MUST stay distinct
  VAL:   ['val', 'vl', 'vlt', 'vl thal', 'vl thalamus', 'ventrolateral thalamus',
          'ventro lateral thalamus', 'ventral lateral thalamus', 'ventral lateral nucleus',
          'ventrolateral nucleus', 'ventrolateral thalamic nucleus', 'ventral lateral thalamic nucleus'],
  VM:    ['vm', 'vm thal', 'vm thalamus', 'ventromedial thalamus', 'ventro medial thalamus',
          'ventral medial thalamus', 'ventromedial thalamic nucleus', 'ventral medial thalamic nucleus',
          'ventromedial nucleus of the thalamus'],
  PF:    ['pf', 'parafascicular', 'parafascicular nucleus', 'pf thal'],
  CL:    ['central lateral nucleus', 'cl thal'],
  PO:    ['posterior complex', 'po thal', 'posterior thalamic nucleus'],
  PVT:   ['pvt', 'paraventricular thalamus', 'paraventricular nucleus of the thalamus'],
  MD:    ['md', 'mediodorsal thalamus', 'mediodorsal nucleus'],
  VPM:   ['vpm', 'ventral posteromedial nucleus', 'ventral posterior medial nucleus', 'vpm thal'],
  VPL:   ['vpl', 'ventral posterolateral nucleus', 'ventral posterior lateral nucleus'],
  LGN:   ['lgn', 'lateral geniculate', 'dorsal lateral geniculate'],
  MGN:   ['mgn', 'mgv', 'medial geniculate', 'medial geniculate nucleus',
          'ventral medial geniculate nucleus', 'medial geniculate nucleus ventral'],
  RT:    ['reticular nucleus of the thalamus', 'thalamic reticular nucleus'],
  // Hippocampus
  CA1:   ['ca1', 'field ca1', 'hippocampal ca1', 'dorsal hippocampus', 'ventral hippocampus'],
  CA2:   ['ca2', 'field ca2'],
  CA3:   ['ca3', 'field ca3'],
  DG:    ['dg', 'dentate gyrus'],
  ENT:   ['ent', 'entorhinal cortex', 'entorhinal'],
  SUB:   ['subiculum'],
  // Striatum / pallidum / basal forebrain
  ACB:   ['acb', 'nac', 'nucleus accumbens', 'accumbens', 'nac core', 'nac shell'],
  CP:    ['cp', 'caudoputamen', 'dorsal striatum', 'striatum'],
  VMSTR: ['ventromedial striatum', 'ventral medial striatum', 'vm striatum'],
  GPE:   ['gpe', 'globus pallidus external', 'external globus pallidus'],
  STN:   ['stn', 'subthalamic nucleus'],
  BST:   ['bnst', 'bed nucleus of the stria terminalis'],
  NBM:   ['nbm', 'nucleus basalis', 'nucleus basalis of meynert'],
  MS:    ['medial septum'],
  // Amygdala
  BLA:   ['bla', 'basolateral amygdala', 'basolateral amygdalar nucleus'],
  CEA:   ['cea', 'central amygdala', 'central amygdalar nucleus'],
  MEA:   ['mea', 'medial amygdala', 'medial amygdalar nucleus'],
  // Midbrain / brainstem
  VTA:   ['vta', 'ventral tegmental area'],
  VMB:   ['ventral midbrain'],
  SNC:   ['snc', 'substantia nigra pars compacta', 'substantia nigra compact part'],
  SNR:   ['snr', 'substantia nigra pars reticulata', 'substantia nigra reticular part'],
  PAG:   ['pag', 'periaqueductal gray', 'periaqueductal grey'],
  SC:    ['superior colliculus'],
  IC:    ['inferior colliculus', 'central nucleus of the inferior colliculus', 'cic'],
  LC:    ['lc', 'locus coeruleus'],
  DR:    ['dorsal raphe', 'dorsal raphe nucleus'],
  PB:    ['parabrachial nucleus'],
  NTS:   ['nts', 'nucleus of the solitary tract'],
  PN:    ['pontine nuclei'],
  RN:    ['red nucleus'],
  // Hypothalamus
  LHA:   ['lha', 'lateral hypothalamus', 'lateral hypothalamic area'],
  PVH:   ['pvn', 'paraventricular hypothalamic nucleus'],
  VMH:   ['vmh', 'ventromedial hypothalamus', 'ventromedial hypothalamic nucleus'],
  ARH:   ['arcuate nucleus'],
  SCH:   ['scn', 'suprachiasmatic nucleus'],
  LHB:   ['lhb', 'lateral habenula'],
  MHB:   ['mhb', 'medial habenula'],
  // Cortex / olfactory bulb
  PL:    ['prelimbic', 'prelimbic cortex'],
  ILA:   ['infralimbic', 'infralimbic cortex'],
  ACA:   ['acc', 'anterior cingulate', 'anterior cingulate cortex'],
  ORB:   ['ofc', 'orbitofrontal cortex'],
  AI:    ['insular cortex', 'insula', 'agranular insular'],
  MOP:   ['m1', 'primary motor cortex'],
  MOS:   ['m2', 'secondary motor cortex'],
  SSP:   ['s1', 'primary somatosensory', 'barrel cortex', 'barrel field'],
  VISP:  ['v1', 'primary visual cortex'],
  AUDP:  ['a1', 'primary auditory cortex'],
  RSP:   ['rsc', 'retrosplenial cortex'],
  PIR:   ['piriform cortex'],
  MOB:   ['olfactory bulb', 'main olfactory bulb'],
};

// ─────────────────────────────────────────────────────────────────────────────
// HARD DISQUALIFIERS — the layer that cannot leak.
// If the QUERY resolves to acronym A, and the ROW LABEL matches A's disqualifier
// pattern, the row is rejected before any scoring runs. This is what keeps
// "ventromedial striatum" and "ventral midbrain" out of a "VM Thal" query even
// if some alias or token path would otherwise score them.
// ─────────────────────────────────────────────────────────────────────────────
const REGION_DISQUALIFIERS = {
  // Thalamic targets: reject anything that is clearly NOT thalamus.
  VM:    /striat|midbrain|geniculate|hypothalam|pallid|accumb|tegment|posterior\s+medial|posteromedial/i,
  VAL:   /striat|midbrain|geniculate|hypothalam|pallid|accumb|tegment|posterior\s+lateral|posterolateral/i,
  VPM:   /striat|midbrain|geniculate|hypothalam|pallid|accumb/i,
  VPL:   /striat|midbrain|geniculate|hypothalam|pallid|accumb/i,
  PF:    /striat|midbrain|geniculate|hypothalam/i,
  CL:    /striat|midbrain|geniculate|hypothalam/i,
  PO:    /striat|midbrain|geniculate|hypothalam/i,
  MD:    /striat|midbrain|geniculate|hypothalam/i,
  PVT:   /striat|midbrain|geniculate|hypothalam/i,
  RT:    /striat|midbrain|geniculate|hypothalam/i,
  // Geniculate bodies: keep medial vs lateral apart, exclude non-thalamic.
  MGN:   /striat|midbrain|hypothalam|lateral\s+geniculate/i,
  LGN:   /striat|midbrain|hypothalam|medial\s+geniculate/i,
  // Non-thalamic structures that share the "ventromedial"/"ventral" adjectives.
  VMH:   /thalam|striat|midbrain|geniculate/i,
  VMSTR: /thalam|midbrain|geniculate|hypothalam/i,
  VMB:   /thalam|striat|geniculate|hypothalam/i,
  VTA:   /thalam|striat|geniculate|hypothalam/i,
  // Striatal / pallidal separation.
  CP:    /accumb|pallid|thalam|midbrain|hypothalam/i,
  ACB:   /caudoputamen|dorsal\s+striatum|pallid|thalam|midbrain/i,
  GPE:   /thalam|striat|midbrain|accumb/i,
  // Cerebellar "dentate nucleus" vs hippocampal "dentate gyrus".
  DG:    /cerebell|interpositus|interposed|dentate\s+nucleus/i,
  DN:    /gyrus|hippocamp/i,
  // Colliculus vs cerebellar interposed (the CIC / IP confusion).
  IC:    /interposed|interpositus|cerebellar\s+nucle/i,
  IP:    /collicul/i,
  SC:    /interposed|interpositus|cerebellar\s+nucle/i,
  // Hippocampal fields must not match cerebellar/striatal labels.
  CA1:   /cerebell|striat|thalam/i,
  CA2:   /cerebell|striat|thalam/i,
  CA3:   /cerebell|striat|thalam/i,
};

function isDisqualified(label, acronym) {
  const re = REGION_DISQUALIFIERS[acronym];
  return !!re && re.test(label || '');
}

// Filler words that carry no discriminative anatomical meaning.
const GENERIC_TOKENS = new Set([
  'nucleus', 'nuclei', 'area', 'region', 'complex', 'of', 'the', 'part',
  'division', 'field', 'body', 'formation', 'n', 'nu',
]);

function tokensOf(text) {
  return new Set(
    (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  );
}

function meaningful(tokenSet) {
  const out = new Set();
  tokenSet.forEach((t) => { if (!GENERIC_TOKENS.has(t)) out.add(t); });
  return out;
}

function isSubset(small, big) {
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function setsEqual(a, b) {
  return a.size === b.size && isSubset(a, b);
}

// Flattened alias index: [{ acr, tokens }]
const ALIAS_INDEX = (() => {
  const list = [];
  Object.entries(REGION_ALIASES).forEach(([acr, phrases]) => {
    phrases.forEach((p) => list.push({ acr, phrase: p, tokens: meaningful(tokensOf(p)) }));
  });
  return list;
})();

const ACRONYM_KEYS = new Set(Object.keys(REGION_ALIASES).map((k) => k.toLowerCase()));

// Query → canonical acronyms. PERMISSIVE (subset), because a query carries extra
// words: "coordinates for VM thal in mice" still resolves to VM.
function canonicalAcronyms(query) {
  const out = new Set();
  if (!query) return out;
  const raw = tokensOf(query);
  const qm = meaningful(raw);

  raw.forEach((t) => {
    const up = t.toUpperCase();
    if (REGION_ALIASES[up]) out.add(up);
  });
  ALIAS_INDEX.forEach(({ acr, tokens }) => {
    if (!tokens.size) return;
    if (isSubset(tokens, qm) || isSubset(tokens, raw)) out.add(acr);
  });
  return out;
}

// Label → canonical acronyms. STRICT (token-set equality) so discriminative
// tokens cannot be ignored. Handles multi-target labels like "VL/VM".
function canonicalAcronymsForLabel(label) {
  const out = new Set();
  if (!label) return out;

  const fragments = String(label).split(/[\/;,+&]| and /i).map((s) => s.trim()).filter(Boolean);
  const parts = fragments.length ? fragments : [label];

  parts.forEach((frag) => {
    const norm = frag.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ACRONYM_KEYS.has(norm)) {
      Object.keys(REGION_ALIASES).forEach((k) => { if (k.toLowerCase() === norm) out.add(k); });
    }
    const lt = meaningful(tokensOf(frag));
    if (!lt.size) return;
    ALIAS_INDEX.forEach(({ acr, tokens }) => {
      if (tokens.size && setsEqual(tokens, lt)) out.add(acr);
    });
  });
  return out;
}

// Score how well a free-text region label matches a query. 0 = no match.
function regionMatchScore(regionLabel, query) {
  if (!regionLabel || !query) return 0;

  const qAcrs = canonicalAcronyms(query);

  // ── HARD REJECT: runs before every scoring path. ──
  for (const acr of qAcrs) {
    if (isDisqualified(regionLabel, acr)) return 0;
  }

  const lAcrs = canonicalAcronymsForLabel(regionLabel);

  // Canonical acronym intersection — the strongest, most reliable signal.
  for (const a of lAcrs) {
    if (qAcrs.has(a)) return 60;
  }

  // Literal phrase containment ("ventromedial thalamus" inside the query).
  const lower = String(regionLabel).toLowerCase().trim();
  const qLower = String(query).toLowerCase();
  if (lower.length >= 4 && qLower.includes(lower)) return 45;

  // Token fallback for labels absent from the alias table. Requires EVERY
  // meaningful label token to hit a query token, so "VL thal" cannot match a
  // "VM" query on the shared "thal" token alone.
  const lt = meaningful(tokensOf(regionLabel));
  const qt = tokensOf(query);
  if (!lt.size || !qt.size) return 0;

  let all = true;
  lt.forEach((t) => {
    let hit = false;
    qt.forEach((q) => {
      if (t === q) hit = true;
      else if (t.length >= 4 && q.length >= 4 && (t.startsWith(q) || q.startsWith(t))) hit = true;
    });
    if (!hit) all = false;
  });
  return all ? 35 : 0;
}

// Score one coordinate target against the query.
function targetRelevance(target, query) {
  if (!target || typeof target !== 'object') return 0;

  const labels = [target.ccf_region, target.region_verbatim].filter(Boolean);
  if (!labels.length) return 0;

  // Any disqualified label rejects the whole row, even if a sibling label matched.
  const qAcrs = canonicalAcronyms(query);
  for (const l of labels) {
    for (const acr of qAcrs) {
      if (isDisqualified(l, acr)) return 0;
    }
  }

  let best = 0;
  labels.forEach((l) => { best = Math.max(best, regionMatchScore(l, query)); });
  if (best <= 0) return 0;

  // Source-quote signal is a TIEBREAK ONLY — capped, and only when the label
  // already matched. A quote can never qualify a row on its own.
  const quote = String(target.source_quote || '').toLowerCase();
  const words = tokenize(query);
  const hits = words.reduce((n, w) => n + (quote.includes(w) ? 1 : 0), 0);
  return best + Math.min(5, hits);
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'to', 'is', 'are',
  'was', 'were', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'on', 'not',
  'but', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'about', 'which', 'what', 'how', 'when', 'where', 'who', 'i', 'we',
  'my', 'our', 'you', 'your', 'show', 'more', 'give', 'list', 'please']);

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

// ─────────────────────────────────────────────────────────────────────────────
// Manual region corrections (region-corrections.json). Lets a human override a
// mis-assigned region WITHOUT re-running distillation. Fetched at runtime, so a
// correction goes live on next page load — no rebuild required.
// ─────────────────────────────────────────────────────────────────────────────
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

  // Pagination + query isolation state.
  const rowLimitRef = useRef(ROW_PAGE_SIZE);
  const lastQueryRef = useRef('');
  const totalRowsRef = useRef(0);

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

    // PRIMARY source + manual corrections, loaded together so a correction can
    // never race the data it patches.
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

  // Does the query name a specific brain region?
  function queryIsRegional(query) {
    return canonicalAcronyms(query).size > 0;
  }

  function getRelevantRefs(query, topN = PAPER_POOL_SIZE) {
    const words = tokenize(query);
    const regional = queryIsRegional(query);
    const pool = getMergedLiteraturePool().filter(isMousePaper);
    if (!pool.length) return [];

    const scored = pool.map((entry) => {
      const targets = entry.structuredTargets || [];
      const bestTarget = targets.reduce((m, t) => Math.max(m, targetRelevance(t, query)), 0);
      const bestRegion = entry.regions.reduce((m, r) => Math.max(m, regionMatchScore(r, query)), 0);
      const regionScore = Math.max(bestTarget, bestRegion);

      const passageText = (entry.passages || []).map((p) => p.text).join(' ');
      const text = `${entry.pmid} ${entry.title || ''} ${entry.regionText} ${passageText.slice(0, 1200)} ${entry.methodsText.slice(0, 800)}`;
      let score = scoreText(words, text) + regionScore;

      if (String(query).toLowerCase().includes(String(entry.pmid))) score += 100;

      const structWithCoords = targets.filter(
        (t) => t.ap_mm != null || t.ml_mm != null || t.dv_mm != null);
      if (structWithCoords.length) score += 3;

      const indexed = injectionIndex.get(String(entry.pmid));

      return {
        entry: {
          ...entry,
          structWithCoords,
          hasStructured: structWithCoords.length > 0,
          species: indexed?.species || null,
          regionScore,
        },
        score,
        regionScore,
      };
    });

    // For a regional query, a paper with ZERO matching rows must not appear at
    // all — otherwise the model cites it and says "no other targets".
    const filtered = scored.filter((s) => {
      if (s.score <= 0) return false;
      if (regional && s.regionScore <= 0) return false;
      return true;
    });

    return filtered
      .sort((a, b) => b.score - a.score || (parseInt(a.entry.pmid, 10) || 0) - (parseInt(b.entry.pmid, 10) || 0))
      .slice(0, topN)
      .map((s) => s.entry);
  }

  // Flatten every matching coordinate row across ALL papers into one globally
  // ranked list. Pagination slices this list, not per-paper targets.
  function buildRowList(query, refs) {
    const regional = queryIsRegional(query);
    const rows = [];
    refs.forEach((entry) => {
      (entry.structuredTargets || []).forEach((t) => {
        const hasCoord = t.ap_mm != null || t.ml_mm != null || t.dv_mm != null;
        if (!hasCoord) return;
        const s = targetRelevance(t, query);
        if (regional) { if (s < MIN_ROW_SCORE) return; }
        else if (s < 0) return;
        rows.push({ pmid: entry.pmid, title: entry.title, species: entry.species, target: t, score: s });
      });
    });
    rows.sort((a, b) => b.score - a.score
      || (parseInt(a.pmid, 10) || 0) - (parseInt(b.pmid, 10) || 0));
    return rows;
  }

  function buildSystemPrompt(query, rowLimit) {
    const hwHits = getRelevantHardware(query);
    const refs = getRelevantRefs(query);
    const allRows = buildRowList(query, refs);
    const total = allRows.length;
    totalRowsRef.current = total;

    const end = Math.min(rowLimit, total);
    const shown = allRows.slice(0, end);

    const syringeTable = syringeDb
      ? syringeDb.syringes.map((s) =>
        `${s.displayName}: ${s.divNlPerMm.toFixed(3)} nL/mm, barrel OD ${s.barrelOdMm} mm, stroke ${s.strokeLengthMm} mm, fits current hardware: ${s.hardwareCompatible ? 'YES' : 'NO'}`
      ).join('\n') +
        (syringeDb.genericReference || []).map((g) => `${g.series}: fits current hardware: NO${g.note ? ' — ' + g.note : ''}`).join('\n')
      : '(syringe database loading)';

    const hwContext = hwHits.length
      ? hwHits.map((h) => `[${h.category}] ${h.title}: ${h.content}`).join('\n\n')
      : '(no directly matching hardware KB entries — answer from the syringe table and general knowledge, and say so if unsure)';

    let rowBlock;
    if (shown.length) {
      rowBlock = shown.map((r, i) => {
        const t = r.target;
        const region = t.ccf_region || t.region_verbatim || 'unspecified region';
        const corr = t.corrected ? ' [human-corrected]' : '';
        const quote = String(t.source_quote || '').trim();
        return `ROW ${i + 1} | PMID:${r.pmid} | ${region}${corr} | AP ${fmtCoord(t.ap_mm)} | ML ${fmtCoord(t.ml_mm)} | DV ${fmtCoord(t.dv_mm)} | ref ${t.reference || 'not stated'} | volume ${fmtNum(t.volume_nl, ' nL')} | rate ${fmtNum(t.rate_nl_min, ' nL/min')}\n     source_quote: ${quote ? `"${quote}"` : '—'}\n     link: https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
      }).join('\n\n');
    } else {
      // No structured rows matched — fall back to passage text so the model can
      // at least reason from the indexed sentences.
      const fb = refs.slice(0, 8).map((r, i) => {
        const p = (r.passages || [])[0];
        const excerpt = (p?.text || r.methodsText || '').trim().slice(0, 400);
        return `[${i + 1}] PMID:${r.pmid} (regions: ${r.regions.join(', ') || 'unspecified'})\n   ${excerpt ? `"${excerpt}"` : 'No indexed passage.'}\n   link: https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
      }).join('\n\n');
      rowBlock = fb || '(no matching indexed coordinate rows or passages for this query)';
    }

    const paginationBlock = shown.length
      ? (total > end
        ? `PAGINATION STATE — read carefully:
- You have been given ROWS 1 THROUGH ${end} of ${total} total matching rows.
- RENDER ALL ${shown.length} ROWS LISTED ABOVE — every single one, in ONE table.
- Rows beyond ROW ${end} are NOT in your context. Do NOT guess, reconstruct, or reference them.
- Do NOT reference row numbers from any previous turn. Only the ROW numbers above are real.
- After the table, close with EXACTLY this one line:

> Showing rows 1–${end} of ${total} matching rows. Reply **"show more"** for the next ${ROW_PAGE_SIZE}.`
        : `PAGINATION STATE: ALL ${total} matching rows are listed above. RENDER ALL ${shown.length} OF THEM in one table. Do NOT mention pagination, do NOT mention row counts, and do NOT offer to show more.`)
      : 'PAGINATION STATE: no structured coordinate rows matched. Do NOT render an empty table and do NOT mention pagination.';

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
- Coordinates are in mm. "midline" ML = 0. "caudal/posterior to bregma" = negative AP; "anterior/rostral to bregma" = positive AP. DV is injection depth; "X mm below pial/dura/skull" sets the reference accordingly, otherwise the reference is bregma or lambda as stated.
- A value may be a single number OR a range string ("0.1 to 0.5", "-5 to -6") when the paper reports a span or multiple depths at one site — report ranges verbatim, do NOT average them.
- Volume and rate are normalized to nanoliters. A rodent brain injection is essentially never < 1 nL; treat any sub-1 nL volume as "not stated (source value unreliable)".
- BILATERAL: a bilateral injection appears as TWO rows, ML +X and ML −X, sharing AP/DV — that is correct, report both.
- MULTI-SITE: distinct sub-sites get SEPARATE rows — keep them separate.

## HARD CONSTRAINTS
1. Cite ONLY PMIDs that appear in the ROW list below. NEVER invent or recall a PMID from training. Format as exactly [PMID:XXXXXXX].
2. NEVER attach a coordinate, region, volume, or rate to a PMID unless it is explicitly on that PMID's ROW below. Do NOT transfer values between papers. Do NOT fabricate numbers.
3. TABLE RULE: for any coordinate/parameter query, respond with a GitHub-flavored markdown table with EXACTLY these columns: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference | Volume | Rate | Source quote. The Source quote column MUST contain that row's source_quote verbatim; use "—" if it is "—". Do NOT paraphrase quotes. Do NOT add a Notes column.
4. Report AP/ML/DV/reference/volume/rate EXACTLY as given on each ROW. Do NOT re-derive, round, or alter them. Write "not stated" ONLY when the ROW literally says "not stated".
5. REGION AUTHORITY: the region on each ROW is the validated structure for that coordinate. Report THAT specific region — do NOT downgrade it to a parent structure (never write "Cerebellum" for "SIM", never "Hippocampus" for "CA1", never "Thalamus" for "VM thal"). You may expand an acronym for clarity, e.g. "SIM (simplex lobule)".
6. RANGES: report the FULL range exactly as given — never collapse or average it.
7. REGION BINDING: a coordinate set belongs ONLY to the region on its own ROW. Lambda- and bregma-referenced values are NOT interchangeable — always report the Reference column.
8. If no ROW names the requested region, say so plainly and give general atlas guidance. Do NOT substitute another structure's coordinates. It is correct to say "the indexed literature does not contain a coordinate for X."
9. NEVER render an empty table. If nothing matched, answer in prose only.
10. Only cite a PMID if you actually display at least one of its ROWS in your table.
11. Close literature-grounded answers with one line reminding the user this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.

${paginationBlock}

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## MATCHING COORDINATE ROWS (${shown.length} shown of ${total} total; most relevant first)
${rowBlock}`;

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
      setLoadingStatus('Finding relevant papers…');

      // CRITICAL: the retrieval query is the USER'S MESSAGE ONLY. Previously it
      // concatenated the last 4 messages, which meant the prior assistant table
      // (every region name and PMID in it) polluted retrieval — so the same
      // question returned different papers depending on chat history, and
      // different users got different answers.
      const wantsMore = isMoreRequest(userMessage) && lastQueryRef.current;
      if (wantsMore) {
        rowLimitRef.current += ROW_PAGE_SIZE;
      } else {
        lastQueryRef.current = userMessage;
        rowLimitRef.current = ROW_PAGE_SIZE;
      }
      const ragQuery = wantsMore ? lastQueryRef.current : userMessage;

      setLoadingStatus('Reading validated coordinates…');
      const systemPrompt = buildSystemPrompt(ragQuery, rowLimitRef.current);
      // Don't let the limit run away past the real row count.
      if (totalRowsRef.current) {
        rowLimitRef.current = Math.min(rowLimitRef.current, Math.max(ROW_PAGE_SIZE, totalRowsRef.current));
      }
      const messagesWithSystem = [systemPrompt, ...updatedMessages];

      setLoadingStatus(`Composing answer with ${selectedModel}…`);

      let firstToken = true;
      const onToken = (partial) => {
        if (firstToken && partial) {
          firstToken = false;
          setLoadingStatus('');
        }
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
      lastQueryRef.current = '';
      totalRowsRef.current = 0;
    }
  }

  function askAboutAtlasTarget() {
    if (!atlasTarget) return;
    const regionLabel = atlasTarget.name ? `${atlasTarget.region} (${atlasTarget.name})` : atlasTarget.region;
    setChatInput(`What injection protocol, volume, and flow rate would you recommend for targeting ${regionLabel} in mice, around AP ${atlasTarget.ap} mm, ML ${atlasTarget.ml} mm, DV ${atlasTarget.dv} mm from Bregma?`);
    setActiveTab('chat');
  }

  // ── Console debug helpers ─────────────────────────────────────────────────
  //   niCheck('ventromedial striatum', 'VM Thal')  → why a label matches or not
  //   niDebug('VM Thal')                            → papers + rows + page slice
  useEffect(() => {
    window.niCheck = (label, query) => {
      const qA = [...canonicalAcronyms(query)];
      const lA = [...canonicalAcronymsForLabel(label)];
      const dq = qA.filter((a) => isDisqualified(label, a));
      const score = regionMatchScore(label, query);
      console.log(`niCheck("${label}", "${query}")`);
      console.log('  query acronyms :', qA.join(', ') || '(none)');
      console.log('  label acronyms :', lA.join(', ') || '(none)');
      console.log('  disqualified by:', dq.join(', ') || '(none)');
      console.log('  SCORE          :', score);
      return score;
    };

    window.niDebug = (query) => {
      const refs = getRelevantRefs(query);
      const rows = buildRowList(query, refs);
      console.log(`niDebug("${query}") → ${refs.length} papers, ${rows.length} matching rows`);
      console.log(`  regional query: ${queryIsRegional(query)} | acronyms: ${[...canonicalAcronyms(query)].join(', ') || '(none)'}`);
      rows.slice(0, 30).forEach((r, i) => {
        const t = r.target;
        console.log(`  ROW ${i + 1} (score ${r.score}) PMID:${r.pmid} | ${t.ccf_region || t.region_verbatim} | AP ${t.ap_mm} ML ${t.ml_mm} DV ${t.dv_mm} ref ${t.reference}`);
      });
      if (rows.length > 30) console.log(`  … ${rows.length - 30} more`);
      console.log(`  page 1 shows rows 1–${Math.min(ROW_PAGE_SIZE, rows.length)}`);
      return rows.length;
    };

    return () => { delete window.niDebug; delete window.niCheck; };
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
              {structuredCount} papers with validated structured stereotaxic coordinates
              {correctionCount ? ` · ${correctionCount} manual correction(s) applied` : ''}.
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
                        ? `${t.ccf_region || t.region_verbatim || 'region'} — AP ${fmtCoord(t.ap_mm)}, ML ${fmtCoord(t.ml_mm)}, DV ${fmtCoord(t.dv_mm)} mm (ref: ${t.reference || 'n/s'})${nMore ? ` · +${nMore} more target(s)` : ''}`
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
