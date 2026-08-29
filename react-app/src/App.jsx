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
// PAGINATION — rows are paginated GLOBALLY across all papers. A single paper
// rarely has >10 rows matching one region, so per-paper paging left whole papers
// stranded outside the pool while "show more" had nothing to give.
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
// BROAD-REGION CLARIFICATION
//
// "coordinates for cerebellum" names a PARENT structure, not a target. Silently
// returning whichever cerebellar rows happen to rank highest is misleading — the
// answer differs wildly depending on whether SIM, Crus I, or the fastigial
// nucleus surfaces first. When a query names ONLY a broad structure, ask which
// substructure is meant, and list the ones actually present in the corpus.
//
// `child` matches labels belonging to that parent. `selfOnly` matches labels
// that are just the parent restated ("cerebellum", "cerebellar cortex") — those
// are offered as an explicit "whole structure" option rather than a target.
// ─────────────────────────────────────────────────────────────────────────────
const BROAD_REGIONS = {
  cerebellum: {
    label: 'cerebellum',
    test: /\bcerebell(um|ar|a)\b/i,
    child: /cerebell|purkinje|vermis|crus|simplex|simple lobule|lobule|paraflocc|flocc|uvula|nodulus|culmen|declive|folium|tuber|pyramis|fastigial|interpos|dentate nucle|ansiform|paramedian|copula/i,
    selfOnly: /^(cerebellum|cerebellar cortex|cerebellar|cerebellar nuclei|deep cerebellar nuclei)$/i,
  },
  cortex: {
    label: 'cerebral cortex',
    test: /\b(cerebral cortex|neocortex|isocortex|cortex)\b/i,
    child: /cortex|cortical|prelimbic|infralimbic|cingulate|orbitofrontal|insular|motor|somatosensory|visual|auditory|retrosplenial|entorhinal|piriform|barrel|prefrontal/i,
    selfOnly: /^(cortex|cerebral cortex|neocortex|isocortex|cortical)$/i,
  },
  thalamus: {
    label: 'thalamus',
    test: /\bthalam(us|ic)\b/i,
    child: /thalam|geniculate|habenul|reticular nucleus|parafascic|reuniens|pulvinar/i,
    selfOnly: /^(thalamus|thalamic|dorsal thalamus|thalamic nuclei)$/i,
  },
  hypothalamus: {
    label: 'hypothalamus',
    test: /\bhypothalam(us|ic)\b/i,
    child: /hypothalam|arcuate|suprachiasm|paraventricular hypo|mammillary|preoptic|lateral hypothalamic/i,
    selfOnly: /^(hypothalamus|hypothalamic)$/i,
  },
  hippocampus: {
    label: 'hippocampus',
    test: /\bhippocamp(us|al)\b|\bhippocampal formation\b/i,
    child: /hippocamp|\bca1\b|\bca2\b|\bca3\b|dentate gyrus|subiculum|entorhinal/i,
    selfOnly: /^(hippocampus|hippocampal|hippocampal formation)$/i,
  },
  striatum: {
    label: 'striatum',
    test: /\bstriat(um|al)\b|\bbasal ganglia\b/i,
    child: /striat|caudoputamen|accumbens|putamen|caudate|pallid|olfactory tubercle/i,
    selfOnly: /^(striatum|striatal|dorsal striatum|ventral striatum|basal ganglia)$/i,
  },
  amygdala: {
    label: 'amygdala',
    test: /\bamygdal(a|ar|oid)\b/i,
    child: /amygdal|basolateral|central nucle|medial nucle|intercalated|bed nucleus/i,
    selfOnly: /^(amygdala|amygdalar|amygdaloid|amygdaloid complex)$/i,
  },
  midbrain: {
    label: 'midbrain',
    test: /\bmidbrain\b|\bmesencephal/i,
    child: /midbrain|tegmental|substantia nigra|periaqueductal|collicul|red nucleus|interpeduncular|raphe/i,
    selfOnly: /^(midbrain|mesencephalon|ventral midbrain)$/i,
  },
  brainstem: {
    label: 'brainstem',
    test: /\bbrain\s*stem\b|\bhindbrain\b|\bmedulla\b(?!\s*oblongata\s+\w)|\bpons\b/i,
    child: /brainstem|medulla|pons|pontine|raphe|parabrachial|solitary|locus coeruleus|olivary|inferior olive|vestibular|trigeminal|ambiguus/i,
    selfOnly: /^(brainstem|brain stem|hindbrain|medulla|pons)$/i,
  },
};

// Phrases that mean "don't ask, just show me everything" — bypasses clarification.
const BROAD_OVERRIDE_RE =
  /\b(all|any|every|entire|whole|overview|survey|list all|show all|across)\b/i;

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
//
// RULE 3 — if the QUERY resolves to a specific acronym, a label that does not
//   resolve to that acronym is a MISS. No loose token fallback. That fallback is
//   what let "cerebellum" and "cerebellar lobule VII" score on a query for
//   "cerebellar simplex lobule".
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
// If the QUERY resolves to acronym A and the ROW LABEL matches A's disqualifier
// pattern, the row is rejected before any scoring path runs.
// ─────────────────────────────────────────────────────────────────────────────
const REGION_DISQUALIFIERS = {
  VM:    /striat|midbrain|geniculate|hypothalam|pallid|accumb|tegment|posterior\s+medial|colliculus/i,
  VAL:   /striat|midbrain|geniculate|hypothalam|pallid|accumb|tegment|posterior\s+lateral|colliculus/i,
  VPM:   /striat|midbrain|geniculate|hypothalam|cerebell/i,
  VPL:   /striat|midbrain|geniculate|hypothalam|cerebell/i,
  MGN:   /striat|midbrain|hypothalam|lateral geniculate|cerebell/i,
  LGN:   /striat|midbrain|hypothalam|medial geniculate|cerebell/i,
  VMH:   /thalam|striat|midbrain|geniculate|cerebell/i,
  VMSTR: /thalam|midbrain|geniculate|hypothalam|cerebell/i,
  VMB:   /thalam|striat|geniculate|hypothalam|cerebell/i,
  CP:    /accumb|pallid|thalam|midbrain|cerebell/i,
  ACB:   /caudoputamen|pallid|thalam|midbrain|cerebell/i,
  DG:    /cerebell|interpositus|dentate nucleus/i,
  DN:    /gyrus|hippocamp/i,
  IC:    /interposed|interpositus|cerebellar nucle/i,
  IP:    /collicul/i,
  SIM:   /herpes|hsv|virus|striat|thalam|hippocamp|cortex(?!.*cerebell)/i,
  CA1:   /cerebell|thalam|striat/i,
  CA3:   /cerebell|thalam|striat/i,
  FN:    /thalam|striat|hippocamp|hypothalam/i,
  IO:    /superior olive|thalam|striat/i,
};

function isDisqualified(label, acronym) {
  const re = REGION_DISQUALIFIERS[acronym];
  return !!re && re.test(label || '');
}

// Words naming a parent structure or pure filler. A label made ONLY of these
// identifies no specific target, so it must never qualify a row on its own.
const GENERIC_TOKENS = new Set([
  'nucleus', 'nuclei', 'area', 'region', 'part', 'of', 'the', 'complex', 'formation',
  'field', 'zone', 'body', 'layer', 'division', 'subdivision', 'group', 'segment',
  'cerebellum', 'cerebellar', 'cerebral', 'cortex', 'cortical', 'lobule', 'lobe',
  'thalamus', 'thalamic', 'hypothalamus', 'hypothalamic', 'hippocampus', 'hippocampal',
  'striatum', 'striatal', 'amygdala', 'amygdalar', 'midbrain', 'brainstem', 'brain',
  'anterior', 'posterior', 'dorsal', 'ventral', 'medial', 'lateral', 'rostral', 'caudal',
  'left', 'right', 'ipsilateral', 'contralateral', 'bilateral',
]);

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'to', 'is', 'are',
  'was', 'were', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'on', 'not',
  'but', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'about', 'which', 'what', 'how', 'when', 'where', 'who', 'i', 'we',
  'my', 'our', 'you', 'your']);

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function tokenSet(text) {
  return new Set((text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean));
}

function contentTokens(text) {
  return [...tokenSet(text)].filter((t) => !GENERIC_TOKENS.has(t));
}

// Label -> acronyms. STRICT: an alias matches only if its content-token set
// EQUALS the label's content-token set (or the label is the bare acronym).
function canonicalAcronymsForLabel(label) {
  const out = new Set();
  if (!label) return out;
  const lc = label.toLowerCase().trim();
  const labelContent = new Set(contentTokens(lc));
  Object.entries(REGION_ALIASES).forEach(([acr, aliases]) => {
    if (lc === acr.toLowerCase()) { out.add(acr); return; }
    for (const alias of aliases) {
      const aliasContent = new Set(contentTokens(alias));
      if (!aliasContent.size) continue;
      if (aliasContent.size !== labelContent.size) continue;
      let equal = true;
      aliasContent.forEach((t) => { if (!labelContent.has(t)) equal = false; });
      if (equal) { out.add(acr); return; }
    }
  });
  return out;
}

// Query -> acronyms. SUBSET is correct here: a query legitimately carries extra
// words ("coordinates for VM thal in mice"), so an alias contained within the
// query's tokens counts as a hit.
function canonicalAcronyms(query) {
  const out = new Set();
  if (!query) return out;
  const lc = query.toLowerCase();
  const qTokens = tokenSet(lc);
  Object.entries(REGION_ALIASES).forEach(([acr, aliases]) => {
    for (const alias of aliases) {
      const aTokens = [...tokenSet(alias)];
      if (!aTokens.length) continue;
      if (aTokens.every((t) => qTokens.has(t))) { out.add(acr); return; }
    }
  });
  return out;
}

function regionMatchScore(regionLabel, query) {
  if (!regionLabel || !query) return 0;
  const label = String(regionLabel);

  const queryAcrs = canonicalAcronyms(query);

  // 1. HARD REJECT — runs before every scoring path.
  for (const acr of queryAcrs) {
    if (isDisqualified(label, acr)) return 0;
  }

  // 2. Canonical intersection — the authoritative match.
  const labelAcrs = canonicalAcronymsForLabel(label);
  for (const a of labelAcrs) if (queryAcrs.has(a)) return 60;

  // 3. If the query named a SPECIFIC structure, a non-matching label is a miss.
  //    No loose fallback — this is what let "cerebellum" / "cerebellar lobule VII"
  //    score on a "cerebellar simplex lobule" query.
  if (queryAcrs.size > 0) return 0;

  // 4. Fallback for unresolved queries: every DISCRIMINATIVE label token must hit.
  const qTokens = tokenSet(query);
  const disc = contentTokens(label);
  if (!disc.length) return 0;                 // label is entirely generic words
  const allHit = disc.every((t) =>
    [...qTokens].some((q) =>
      q === t || (t.length >= 4 && q.startsWith(t)) || (q.length >= 4 && t.startsWith(q))));
  return allHit ? 35 : 0;
}

// Row-level relevance. The source-quote signal is a capped TIEBREAK (+5) applied
// only when the label already matched — a quote can never qualify a row alone.
function targetRelevance(target, query) {
  if (!target || typeof target !== 'object') return 0;
  const ccf = target.ccf_region || '';
  const verb = target.region_verbatim || '';

  const queryAcrs = canonicalAcronyms(query);
  for (const acr of queryAcrs) {
    if (isDisqualified(ccf, acr) || isDisqualified(verb, acr)) return 0;
  }

  const s = Math.max(regionMatchScore(ccf, query), regionMatchScore(verb, query));
  if (s <= 0) return 0;

  const quote = (target.source_quote || '').toLowerCase();
  const qWords = tokenize(query).filter((w) => !GENERIC_TOKENS.has(w));
  const quoteHits = qWords.filter((w) => quote.includes(w)).length;
  return s + Math.min(5, quoteHits);
}

function queryIsRegional(query) {
  return canonicalAcronyms(query).size > 0;
}

function scoreText(words, text) {
  if (!words.length) return 0;
  const lower = (text || '').toLowerCase();
  return words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
}

function fmtCoord(v) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return String(v);
}
function fmtNum(v, unit) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return `${v}${unit || ''}`;
}

// ── Manual region corrections ────────────────────────────────────────────────
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
        target = { ...target, ...(rule.set || {}), corrected: true,
          corrected_from: target.ccf_region || null, correction_note: spec.note || null };
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
  const [dataError, setDataError] = useState('');

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [atlasTarget, setAtlasTarget] = useState(null);
  const chatContainerRef = useRef(null);

  // Retrieval state. lastQueryRef keeps the ORIGINAL user query so "show more"
  // re-retrieves identically — assistant text must never enter the query.
  const lastQueryRef = useRef('');
  const rowLimitRef = useRef(ROW_PAGE_SIZE);
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
    Promise.all([
      fetch('data/injection-structured.json').then((r) => r.json()),
      fetch('data/region-corrections.json').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([obj, corr]) => {
        applyCorrections(obj, corr);
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
      entry, score: scoreText(words, entry.title + ' ' + entry.content + ' ' + entry.category),
    }));
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topN).map((s) => s.entry);
  }

  function getMergedLiteraturePool() {
    const pool = new Map();
    structuredIndex.forEach((rec, key) => {
      const targets = (rec.targets || []).filter((t) => t && typeof t === 'object');
      const regionText = targets.map((t) => `${t.ccf_region || ''} ${t.region_verbatim || ''}`).join(' ');
      pool.set(key, {
        pmid: rec.pmid,
        regions: [...new Set(targets.map((t) => t.ccf_region).filter(Boolean))],
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
          regionText: (rec.ccf_regions || []).join(' '), title: rec.title || null,
          methodsText: '', passageText: pText, passages: rec.passages || [], structuredTargets: [],
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

  // ── Broad-region detection ────────────────────────────────────────────────
  // Broad if: the query names a parent structure, does NOT resolve to any
  // specific acronym, and the user hasn't explicitly asked for everything.
  function detectBroadQuery(query) {
    if (!query) return null;
    if (BROAD_OVERRIDE_RE.test(query)) return null;
    if (canonicalAcronyms(query).size > 0) return null;   // named something specific
    for (const [key, spec] of Object.entries(BROAD_REGIONS)) {
      if (spec.test.test(query)) return { key, ...spec };
    }
    return null;
  }

  // Inventory the substructures ACTUALLY present in the corpus for a parent.
  // Grouped by canonical acronym where the label resolves, so "VM thal" and
  // "ventromedial thalamus" collapse into one option.
  function subregionsFor(spec, topN = 14) {
    const groups = new Map();   // displayKey -> { label, pmids:Set, rows:number }
    structuredIndex.forEach((rec) => {
      (rec.targets || []).forEach((t) => {
        if (!t || typeof t !== 'object') return;
        const label = String(t.ccf_region || t.region_verbatim || '').trim();
        if (!label) return;
        if (!spec.child.test(label)) return;
        if (spec.selfOnly && spec.selfOnly.test(label)) return;   // parent restated
        const hasCoord = t.ap_mm != null || t.ml_mm != null || t.dv_mm != null;
        if (!hasCoord) return;
        const acrs = [...canonicalAcronymsForLabel(label)];
        const display = acrs.length ? acrs[0] : label;
        const pretty = acrs.length ? `${acrs[0]} (${label})` : label;
        if (!groups.has(display)) groups.set(display, { label: pretty, pmids: new Set(), rows: 0 });
        const g = groups.get(display);
        g.pmids.add(String(rec.pmid));
        g.rows += 1;
      });
    });
    return [...groups.values()]
      .map((g) => ({ label: g.label, papers: g.pmids.size, rows: g.rows }))
      .sort((a, b) => b.papers - a.papers || b.rows - a.rows)
      .slice(0, topN);
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
        if (s > 0) regionMatched = true;
      });
      score += bestRegion;

      const structTargets = entry.structuredTargets || [];
      const structWithCoords = structTargets.filter(
        (t) => t.ap_mm != null || t.ml_mm != null || t.dv_mm != null);

      const matchingTargets = structWithCoords
        .map((t) => ({ t, s: targetRelevance(t, query) }))
        .filter((x) => (regional ? x.s >= MIN_ROW_SCORE : x.s > 0))
        .sort((a, b) => b.s - a.s);

      if (matchingTargets.length) { regionMatched = true; score += 5; }
      if (lowerQuery.includes(String(entry.pmid))) score += 50;

      return {
        entry: {
          ...entry, structWithCoords, matchingTargets,
          hasStructured: structWithCoords.length > 0,
          species: injectionIndex.get(String(entry.pmid))?.species || null,
          regionMatched,
        },
        score,
      };
    });

    // For a regional query, a paper with no matching row is NOISE — drop it so
    // it can never appear in the prompt claiming "no other targets".
    return scored
      .filter((s) => (regional ? s.entry.matchingTargets.length > 0 : s.score > 0))
      .sort((a, b) => b.score - a.score || (parseInt(b.entry.pmid, 10) || 0) - (parseInt(a.entry.pmid, 10) || 0))
      .slice(0, topN)
      .map((s) => s.entry);
  }

  // Flatten every matching row across all papers into one globally-ranked list.
  function buildRowList(query) {
    const refs = getRelevantRefs(query);
    const regional = queryIsRegional(query);
    const rows = [];
    refs.forEach((entry) => {
      const targets = regional
        ? entry.matchingTargets
        : (entry.structWithCoords || []).map((t) => ({ t, s: targetRelevance(t, query) }));
      targets.forEach(({ t, s }) => {
        if (regional && s < MIN_ROW_SCORE) return;
        rows.push({ pmid: entry.pmid, title: entry.title, species: entry.species, target: t, score: s });
      });
    });
    rows.sort((a, b) => b.score - a.score ||
      (parseInt(b.pmid, 10) || 0) - (parseInt(a.pmid, 10) || 0));
    return { rows, refs };
  }

  function buildSystemPrompt(query, rowLimit) {
    const hwHits = getRelevantHardware(query);

    const syringeTable = syringeDb
      ? syringeDb.syringes.map((s) =>
        `${s.displayName}: ${s.divNlPerMm.toFixed(3)} nL/mm, barrel OD ${s.barrelOdMm} mm, stroke ${s.strokeLengthMm} mm, fits current hardware: ${s.hardwareCompatible ? 'YES' : 'NO'}`
      ).join('\n') +
        (syringeDb.genericReference || []).map((g) => `${g.series}: fits current hardware: NO${g.note ? ' — ' + g.note : ''}`).join('\n')
      : '(syringe database loading)';

    const hwContext = hwHits.length
      ? hwHits.map((h) => `[${h.category}] ${h.title}: ${h.content}`).join('\n\n')
      : '(no directly matching hardware KB entries)';

    // ── BROAD QUERY → ask for clarification instead of guessing ──────────────
    const broad = detectBroadQuery(query);
    if (broad) {
      const subs = subregionsFor(broad);
      const options = subs.length
        ? subs.map((s) => `- **${s.label}** — ${s.papers} paper${s.papers === 1 ? '' : 's'}, ${s.rows} coordinate row${s.rows === 1 ? '' : 's'}`).join('\n')
        : '(no indexed substructures found for this parent region)';

      const content = `You are the UD Neuroinjector Assistant.

The user asked about **${broad.label}**, which is a LARGE PARENT STRUCTURE, not a single injection target. Stereotaxic coordinates differ substantially between its substructures, so answering with any particular substructure's coordinates would be misleading.

## YOUR TASK THIS TURN — ASK FOR CLARIFICATION. DO NOT GIVE COORDINATES.
1. In ONE short sentence, explain that "${broad.label}" spans multiple distinct targets with very different coordinates, so you need to know which one.
2. Present the list below EXACTLY as given — same labels, same counts — as a markdown bulleted list under a short heading like "Indexed ${broad.label} targets:".
3. Close with one line inviting the user to reply with a specific structure (or to say "all ${broad.label}" for a broad survey).
4. Output NO coordinate table this turn. Do NOT cite any PMID. Do NOT invent coordinates, regions, or counts. Do NOT add substructures that are not in the list.
5. Keep the whole reply under ~120 words.

## INDEXED SUBSTRUCTURES OF ${broad.label.toUpperCase()} (verbatim — do not alter)
${options}`;
      return { role: 'system', content, mode: 'clarify', total: 0 };
    }

    const { rows } = buildRowList(query);
    const total = rows.length;
    const end = Math.min(rowLimit, total);
    const shown = rows.slice(0, end);

    // Group shown rows by paper for a compact, unambiguous citation block.
    const byPaper = new Map();
    shown.forEach((r, i) => {
      if (!byPaper.has(r.pmid)) byPaper.set(r.pmid, { title: r.title, species: r.species, items: [] });
      byPaper.get(r.pmid).items.push({ n: i + 1, t: r.target });
    });

    const citationPool = byPaper.size
      ? [...byPaper.entries()].map(([pmid, g]) => {
        const header = `PMID:${pmid}${g.title ? ` — "${g.title}"` : ''}${g.species ? ` (${g.species})` : ''}`;
        const lines = g.items.map(({ n, t }) => {
          const region = t.ccf_region || t.region_verbatim || 'unspecified region';
          const corr = t.corrected ? ' [human-corrected]' : '';
          const quote = (t.source_quote || '').trim();
          return `   ROW ${n}: ${region}${corr} — AP ${fmtCoord(t.ap_mm)}, ML ${fmtCoord(t.ml_mm)}, DV ${fmtCoord(t.dv_mm)} mm (ref: ${t.reference || 'not stated'}); volume ${fmtNum(t.volume_nl, ' nL')}; rate ${fmtNum(t.rate_nl_min, ' nL/min')}` +
            (quote ? `\n      source_quote: "${quote}"` : '\n      source_quote: —');
        }).join('\n');
        return `${header}\n${lines}\n   Verify: https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
      }).join('\n\n')
      : '(no indexed coordinate rows match this query)';

    const paginationBlock = total > end
      ? `PAGINATION: You have been given ROWS 1–${end} of ${total} total matching rows.
RENDER ALL ${end} ROWS LISTED ABOVE — every single one, in one table.
Rows beyond ${end} are NOT in your context; do not guess them.
Do NOT reference row numbers from any previous turn — only the ROW numbers above are real.
After the table, close with exactly this line:

> Showing rows 1–${end} of ${total} matching rows. Reply **"show more"** for the next ${ROW_PAGE_SIZE}.`
      : `PAGINATION: All ${total} matching row(s) are listed above. RENDER ALL OF THEM.
Do NOT mention pagination, row counts, or offer to show more.`;

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

    const content = `You are the UD Neuroinjector Assistant: a troubleshooting helper for the open-source UD Neuroinjector automated stereotaxic injector, and a rodent stereotaxic surgery assistant.

Only answer questions about: (1) building/wiring/flashing/troubleshooting the UD Neuroinjector, (2) Hamilton syringe compatibility, or (3) designing/troubleshooting rodent stereotaxic microinjection procedures. Otherwise decline briefly.

PROCEDURE GUIDANCE: give stereotaxic coordinates, total volume (nL), and flow rate (nL/min). The user enters nL/min and nL directly in the device serial menu — no plunger-speed math.

## HOW THE COORDINATE DATA WAS EXTRACTED
- Coordinates are mm. "midline" ML = 0. Caudal/posterior to bregma = negative AP. DV is depth; "below pial/dura/skull" sets the reference accordingly, else bregma or lambda as stated.
- A value may be a single number OR a range string ("0.1 to 0.5") — report ranges verbatim, never average them.
- Volume/rate are normalized to nL. Treat sub-1 nL volumes as "not stated (source value unreliable)".
- BILATERAL injections appear as TWO rows (ML +X and −X) sharing AP/DV — report both.
- Each ROW is one physical injection site.

## CITATION RULES — HARD CONSTRAINTS
1. Cite ONLY PMIDs listed below. NEVER invent or recall a PMID. Format exactly [PMID:XXXXXXX].
2. NEVER attach a coordinate to a PMID unless listed under that PMID below. Never transfer values between papers.
3. TABLE RULE: for coordinate queries, output a GitHub markdown table with EXACTLY: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference | Volume | Rate | Source quote. The Source quote column MUST contain the verbatim source_quote for that row ("—" if none). No Notes column.
4. Report AP/ML/DV/reference/volume/rate EXACTLY as given. Never re-derive or round. Write "not stated" ONLY where the row literally says so.
5. REGION AUTHORITY: the region shown IS the validated structure. Report it specifically — never downgrade to a parent (not "Cerebellum" for SIM, not "Hippocampus" for CA1). You may expand an acronym for clarity.
6. Report range values in full, never collapsed to one endpoint.
7. REGION BINDING: coordinates belong ONLY to the region on their own row. Bregma- and lambda-referenced values are NOT interchangeable.
8. If no row matches the requested region, say so plainly in prose and give general atlas guidance. NEVER substitute a different structure's coordinates.
9. Never output an empty table. If there are no rows, answer in prose.
10. Only cite a PMID if you display at least one of its rows.
11. Close literature answers with a one-line reminder that this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.

${paginationBlock}

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## MATCHING COORDINATE ROWS (${end} of ${total} shown, most relevant first)
${citationPool}`;

    return { role: 'system', content, mode: 'answer', total };
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_completion_tokens: 4000, stream: true }),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const msg = (() => { try { return JSON.parse(raw)?.error?.message || ''; } catch { return raw; } })();
      throw new Error(`${deployment} error ${response.status}: ${msg || response.statusText}`);
    }
    let full = '';
    for await (const token of streamSSE(response)) { full += token; onToken(full); }
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

      // Retrieval uses ONLY the user's own words. Feeding prior assistant output
      // back in polluted the query with every region it mentioned, so identical
      // questions returned different papers depending on chat history.
      const wantsMore = isMoreRequest(userMessage) && lastQueryRef.current;
      const ragQuery = wantsMore ? lastQueryRef.current : userMessage;

      if (wantsMore) {
        if (rowLimitRef.current < totalRowsRef.current) rowLimitRef.current += ROW_PAGE_SIZE;
      } else {
        lastQueryRef.current = userMessage;
        rowLimitRef.current = ROW_PAGE_SIZE;
      }

      setLoadingStatus('Reading validated coordinates…');
      const systemPrompt = buildSystemPrompt(ragQuery, rowLimitRef.current);
      totalRowsRef.current = systemPrompt.total || 0;
      const messagesWithSystem = [
        { role: systemPrompt.role, content: systemPrompt.content },
        ...updatedMessages,
      ];

      setLoadingStatus(systemPrompt.mode === 'clarify'
        ? 'Narrowing the target region…'
        : `Composing answer with ${selectedModel}…`);

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
      lastQueryRef.current = '';
      rowLimitRef.current = ROW_PAGE_SIZE;
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
  useEffect(() => {
    window.niCheck = (label, query) => {
      const qAcrs = [...canonicalAcronyms(query)];
      const lAcrs = [...canonicalAcronymsForLabel(label)];
      const dq = qAcrs.filter((a) => isDisqualified(label, a));
      const score = regionMatchScore(label, query);
      console.log(`niCheck("${label}", "${query}")`);
      console.log(`   query acronyms : [${qAcrs.join(', ') || '—'}]`);
      console.log(`   label acronyms : [${lAcrs.join(', ') || '—'}]`);
      console.log(`   disqualified by: [${dq.join(', ') || 'none'}]`);
      console.log(`   SCORE          : ${score}`);
      return score;
    };

    window.niBroad = (query) => {
      const b = detectBroadQuery(query);
      if (!b) { console.log(`niBroad("${query}") → not broad (specific or override)`); return null; }
      const subs = subregionsFor(b);
      console.log(`niBroad("${query}") → BROAD: ${b.label}`);
      subs.forEach((s) => console.log(`   ${s.label} — ${s.papers} papers, ${s.rows} rows`));
      return subs;
    };

    window.niDebug = (query) => {
      const b = detectBroadQuery(query);
      if (b) { console.log(`"${query}" is BROAD (${b.label}) → would ask for clarification`); return window.niBroad(query); }
      const { rows, refs } = buildRowList(query);
      console.log(`niDebug("${query}") → ${refs.length} papers, ${rows.length} matching rows` +
        ` | page 1 shows rows 1–${Math.min(ROW_PAGE_SIZE, rows.length)}`);
      rows.slice(0, 25).forEach((r, i) => {
        const t = r.target;
        console.log(`  ${String(i + 1).padStart(2)}. [${r.score}] ${r.pmid}  ${t.ccf_region || t.region_verbatim} | AP ${t.ap_mm} ML ${t.ml_mm} DV ${t.dv_mm} ref ${t.reference}`);
      });
      if (rows.length > 25) console.log(`  … ${rows.length - 25} more`);
      return rows.length;
    };

    return () => { delete window.niDebug; delete window.niCheck; delete window.niBroad; };
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
            <p>{structuredCount} papers with validated structured stereotaxic coordinates (OSC-distilled).</p>
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
