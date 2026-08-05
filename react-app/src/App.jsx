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

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'for', 'and', 'or', 'to', 'is', 'are',
  'was', 'were', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'from', 'on', 'not',
  'but', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'about', 'which', 'what', 'how', 'when', 'where', 'who', 'i', 'we',
  'my', 'our', 'you', 'your']);

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreText(words, text) {
  if (!words.length) return 0;
  const lower = (text || '').toLowerCase();
  return words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
}

// Best-effort AP/ML/DV stereotaxic coordinate extraction from free-text methods/abstracts.
// Retained only as a last-resort fallback for the legacy coordinate index; the passage
// index is the primary source and the LLM parses coordinates from raw passage text.
function extractCoordinates(text) {
  if (!text) return null;
  const normalized = text.replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u00b1/g, '±');
  const AXES = { AP: 'AP', anteroposterior: 'AP', ML: 'ML', mediolateral: 'ML', DV: 'DV', dorsoventral: 'DV' };
  const axisPattern = Object.keys(AXES).join('|');
  const numPattern = '[\u00b1+-]?\\s?\\d+(?:\\.\\d+)?';
  const labelFirst = new RegExp(`\\b(${axisPattern})\\b[\\s:=]{0,3}(${numPattern})\\s*mm`, 'gi');
  const valueFirst = new RegExp(`(${numPattern})\\s*mm\\s*(${axisPattern})\\b`, 'gi');
  const found = {};
  let m;
  while ((m = labelFirst.exec(normalized))) {
    const axis = AXES[m[1].toUpperCase()] || AXES[m[1].toLowerCase()];
    if (axis && !found[axis]) found[axis] = m[2].replace(/\s+/g, '');
  }
  while ((m = valueFirst.exec(normalized))) {
    const axis = AXES[m[2].toUpperCase()] || AXES[m[2].toLowerCase()];
    if (axis && !found[axis]) found[axis] = m[1].replace(/\s+/g, '');
  }
  if (found.AP && found.ML && found.DV) return found;
  return null;
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
  const [passageIndex, setPassageIndex] = useState(new Map()); // PRIMARY RAG source
  const [dataError, setDataError] = useState('');

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [atlasTarget, setAtlasTarget] = useState(null);
  const chatContainerRef = useRef(null);

  useEffect(() => {
    fetch('data/hardware-kb.json').then((r) => r.json()).then(setHardwareKb).catch(() => {});
    fetch('data/hamilton-syringes.json').then((r) => r.json()).then(setSyringeDb).catch(() => {});
    // Full-text methods corpus (small, committable). Kept as a secondary pool.
    fetch('data/stereotaxic-protocols.json').then((r) => r.json()).then(setLiteraturePapers)
      .catch(() => setDataError((e) => e || 'Could not load stereotaxic-protocols.json'));
    // NOTE: surgical-protocols.json (the ~172MB raw ingest corpus) is deliberately NOT
    // fetched here. It is ingest INPUT only — full of abstract-only, non-surgical noise
    // (vaccine/zebrafish/pathology papers) with regions:[] and no coordinates. Its
    // surgery-relevant, context-gated, coordinate-bearing subset is injection-passages.json,
    // which is the primary RAG source below.
    // Offline-precomputed coordinates/injectate/CCF cross-reference, keyed by PMID
    // (scripts/extract-injection-data.js) — regex-parsed; kept as a fallback source.
    fetch('data/injection-coordinates.json').then((r) => r.json())
      .then((arr) => setInjectionIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => { /* optional, falls back to live extraction */ });
    // Passage-first index (scripts/extract-passages.js): the actual injection sentence(s)
    // with the region bound to its own text, context-gated (simplex→cerebellar, not HSV).
    // The LLM parses AP/ML/DV from the raw passage at answer time — no lossy pre-parsing.
    fetch('data/injection-passages.json').then((r) => r.json())
      .then((arr) => setPassageIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => setDataError((e) => e || 'Could not load injection-passages.json'));
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

  // Builds the retrieval pool from the small, committable sources:
  //   1. injection-passages.json  — PRIMARY: surgery-relevant, region-bound passages
  //   2. stereotaxic-protocols.json — secondary full-text methods corpus
  // The 172MB surgical-protocols.json is intentionally excluded (see fetch note above).
  function getMergedLiteraturePool() {
    const pool = new Map();

    // 1. Passage papers — the distilled, injection-relevant subset. Each carries its
    //    context-gated CCF regions and the raw passage text (which the LLM parses).
    passageIndex.forEach((rec, key) => {
      const passageText = (rec.passages || []).map((p) => p.text).join(' ');
      pool.set(key, {
        pmid: rec.pmid,
        regions: [...(rec.ccf_regions || [])],
        title: rec.title || null,
        methodsText: '',
        abstractText: passageText,
        passages: rec.passages || [],
      });
    });

    // 2. Full-text methods corpus — merge in, adding methods text and any regions
    //    the passage record didn't already carry.
    literaturePapers.forEach((p) => {
      const key = String(p.pmid);
      const existing = pool.get(key);
      if (existing) {
        existing.methodsText = p.methods || existing.methodsText;
        (p.regions || []).forEach((r) => { if (r && !existing.regions.includes(r)) existing.regions.push(r); });
      } else {
        pool.set(key, {
          pmid: p.pmid,
          regions: [...(p.regions || [])],
          title: null,
          methodsText: p.methods || '',
          abstractText: '',
          passages: [],
        });
      }
    });

    return [...pool.values()];
  }

  const RAT_SIGNALS = /\brats?\b|\bsprague[- ]dawley\b|\bwistar\b|\blong[- ]evans\b|\bfischer\s*344\b/i;
  const MOUSE_SIGNALS = /\bmice\b|\bmouse\b|\bc57bl[\\/\s-]/i;
  function isMousePaper(entry) {
    const indexed = injectionIndex.get(String(entry.pmid));
    // Prefer the pre-computed species tag from injection-coordinates.json.
    if (indexed?.species) return indexed.species !== 'rat';
    // Fallback: scan the available text directly.
    const t = `${entry.title || ''} ${entry.methodsText.slice(0, 800)} ${entry.abstractText.slice(0, 400)}`;
    const isRat = RAT_SIGNALS.test(t);
    const isMouse = MOUSE_SIGNALS.test(t);
    return !(isRat && !isMouse); // exclude rat-only; keep mouse, mixed, unknown
  }

  function getRelevantRefs(query, topN = 18) {
    const words = tokenize(query);
    const lowerQuery = (query || '').toLowerCase();
    const pool = getMergedLiteraturePool().filter(isMousePaper); // hard mouse-only constraint
    if (!pool.length) return [];
    const scored = pool.map((entry) => {
      const regionsText = entry.regions.join(' ');
      const text = `${entry.title || ''} ${regionsText} ${entry.methodsText.slice(0, 1500)} ${entry.abstractText.slice(0, 1200)}`;
      let score = scoreText(words, text);

      // Region-aware boosts using the passage-derived CCF regions and region terms.
      entry.regions.forEach((r) => {
        if (r && lowerQuery.includes(r.toLowerCase())) score += 10; // CCF acronym in query
      });
      (entry.passages || []).forEach((ps) => {
        (ps.region_terms || []).forEach((t) => {
          if (t && lowerQuery.includes(t.toLowerCase())) score += 6; // spelled-out region term
        });
      });

      // Coordinate-bearing passages are the highest-value evidence.
      const coordPassages = (entry.passages || []).filter((ps) => ps.has_coords);
      if (coordPassages.length) score += 3;
      else if ((entry.passages || []).length) score += 1;

      // Legacy pre-parsed coordinate index (fallback only).
      const indexed = injectionIndex.get(String(entry.pmid));
      const coords = indexed?.coordinates?.length
        ? indexed.coordinates
        : (() => {
            const single = extractCoordinates(entry.methodsText) || extractCoordinates(entry.abstractText);
            return single ? [{ ap: single.AP, ml: single.ML, dv: single.DV, source_sentence: '' }] : [];
          })();
      const injectates = indexed?.injectates || [];
      const ccfRegions = indexed?.ccf_regions || [];

      return { entry: { ...entry, coords, injectates, ccfRegions, coordPassages }, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (parseInt(b.entry.pmid, 10) || 0) - (parseInt(a.entry.pmid, 10) || 0))
      .slice(0, topN)
      .map((s) => s.entry);
  }

  function buildSystemPrompt(query) {
    const hwHits = getRelevantHardware(query);
    const relevantRefs = getRelevantRefs(query, 18);

    const syringeTable = syringeDb
      ? syringeDb.syringes.map((s) =>
        `${s.displayName}: ${s.divNlPerMm.toFixed(3)} nL/mm, barrel OD ${s.barrelOdMm} mm, stroke ${s.strokeLengthMm} mm, fits current hardware: ${s.hardwareCompatible ? 'YES' : 'NO'}`
      ).join('\n') +
        (syringeDb.genericReference || []).map((g) => `${g.series}: fits current hardware: NO${g.note ? ' — ' + g.note : ''}`).join('\n')
      : '(syringe database loading)';

    const hwContext = hwHits.length
      ? hwHits.map((h) => `[${h.category}] ${h.title}: ${h.content}`).join('\n\n')
      : '(no directly matching hardware KB entries — answer from the syringe table and general knowledge, and say so if unsure)';

    const citationPool = relevantRefs.length
      ? relevantRefs.map((r, i) => {
        // PRIMARY evidence: the raw injection passage(s). The LLM reads these and parses
        // AP/ML/DV itself — handling ranges, ±, reversed order, lambda/bregma, µm depths.
        const passageBlock = (r.passages && r.passages.length)
          ? r.passages.map((ps) => {
              const flags = [
                ps.reference_point && ps.reference_point !== 'unknown' ? `ref:${ps.reference_point}` : null,
                ps.has_coords ? 'has-coords' : 'no-explicit-coords',
                ps.injectate_hint ? `injectate:${ps.injectate_hint}` : null,
                ps.source_field ? `from:${ps.source_field}` : null,
              ].filter(Boolean).join(', ');
              const regs = (ps.ccf_regions || []).join('/') || (ps.region_terms || []).join('/') || 'region unclear';
              return `      • [${regs}${flags ? ` | ${flags}` : ''}] "${(ps.text || '').slice(0, 600).trim()}"`;
            }).join('\n')
          : null;

        // Fallback pre-parsed coordinate line (legacy index).
        const coordLine = r.coords.length
          ? r.coords.map((c) => `AP ${c.ap} mm, ML ${c.ml} mm${c.dv ? `, DV ${c.dv} mm` : ' (DV not stated)'}`).join(' | ')
          : null;

        const header = `[${i + 1}] PMID:${r.pmid}${r.title ? ` — "${r.title}"` : ''} (regions: ${r.regions.join(', ') || 'unspecified'})`;

        if (passageBlock) {
          return `${header}\n   Injection passage(s) — parse coordinates from THIS text; bind them to the region named in the SAME passage:\n${passageBlock}`;
        }
        // No passage — fall back to the legacy coordinate line if present.
        return `${header}\n   ${coordLine ? `Pre-parsed coordinates (verify against source): ${coordLine}` : 'No injection passage or coordinates indexed for this paper.'}`;
      }).join('\n\n')
      : '(no directly matching surgical literature indexed for this query — answer from general veterinary/stereotaxic knowledge and say so)';

    const firmwareRules = `
## ARDUINO FIRMWARE BEHAVIOR & KINEMATICS (.ino Specification)
- **Direct Volumetric Inputs:** The firmware natively prompts for **Flow Rate in nL/min** (0.1–1000 nL/min) and **Volume in nL** (0.1–500 nL) via Serial.
- **Automated Step Math:** Do NOT calculate or suggest manual linear plunger travel speeds (e.g., mm/min, mm/sec) to the user. The firmware automatically calculates motor kinematics using internal functions:
  * getsteps(vol) = (vol * 1600) / (syringe_div * 0.6096)
  * getsteppsec(flow) = ((flow / syringe_div) / 0.6096) / 60.0 * 1600
  * Lead Screw Pitch: 0.6096 mm/rev
  * Motor Resolution: 1600 steps/rev
- **Built-in Syringe Calibration Presets (syringe_div):**
  * Option 1: Hamilton 7000.5 (0.5 µL) -> 8.333 nL/mm (25.0 / 3.0)
  * Option 2: Hamilton 7001 (1.0 µL) -> 16.667 nL/mm (50.0 / 3.0)
  * Option 3: Custom calibration factor (1–1000 nL/mm)
- **Serial Menu Modes:** Mode 1 = Extraction Mode, Mode 2 = Injection Mode, Mode 3 = Manual Joystick Control (pin A2), Mode 4 = Syringe Selection.
- **Hardware Features:** Operation starts via physical button on Pin 13, displays a live 1 Hz percentage and remaining-time countdown, includes pause/resume drift compensation (Pin 13), and features an active end-stop safety switch on Pin 12.
`;

    const content = `You are the UD Neuroinjector Assistant: a troubleshooting helper for the open-source UD Neuroinjector automated stereotaxic injector, and a rodent stereotaxic surgery assistant for designing/troubleshooting microinjection procedures.

Only answer questions related to: (1) building, wiring, flashing, or troubleshooting the UD Neuroinjector hardware/firmware, (2) Hamilton syringe compatibility with this hardware, or (3) designing/troubleshooting rodent stereotaxic microinjection surgical procedures (coordinates, volumes, flow rates, animal prep). If a query is unrelated to these topics, say so briefly and decline.

Always ground hardware/firmware answers in the CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE and ARDUINO FIRMWARE BEHAVIOR below — do not invent part numbers, pin assignments, or dimensions not stated there.

IMPORTANT PROCEDURE GUIDANCE: When responding to surgical protocol queries, provide stereotaxic coordinates, total volume (nL), and flow rate (nL/min). Explicitly clarify that the user enters nL/min and nL directly into the device serial menu without needing manual plunger speed calculations.

## SURGICAL LITERATURE CITATION RULES — HARD CONSTRAINT
1. Cite ONLY PMIDs from the numbered RELEVANT SURGICAL LITERATURE list below. Never invent, guess, or recall a PMID from general training knowledge — if it isn't numbered below, don't cite it.
2. Format every citation as exactly [PMID:XXXXXXX] (no extra punctuation inside the brackets) — this is auto-converted into a clickable PubMed link, so never wrap it in markdown link syntax yourself.
3. COORDINATE PARSING: Each cited paper provides one or more "Injection passage(s)" — the actual sentence(s) from the paper's methods. Read AP/ML/DV, volume, flow rate, and reference point (bregma vs lambda) DIRECTLY from that passage text. Passages may state coordinates in any form — "AP -2.0", "-6.25 mm anterior-posterior", ranges like "1.7–1.07", ± values, or depths in µm. Parse them faithfully; do NOT round, invent, or fill gaps. If a passage marks "has-coords" it contains numeric coordinates; if it marks "no-explicit-coords", it does not — say "not stated in passage" for that field.
4. REGION-BINDING — CRITICAL: Coordinates belong ONLY to the region named in the SAME passage. If a passage describes Crus I/II, its coordinates are for Crus I/II — NEVER present them as simplex, or vice versa. If NO passage names the specific region the user asked about, say so plainly and do not substitute a different region's coordinates. Note the reference point: lambda-referenced coordinates are NOT interchangeable with bregma-referenced ones.
5. TABLE RULE: whenever the user asks about coordinates/targets/parameters for one or more brain regions, respond with a markdown table (GitHub-flavored pipes) with columns: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference (bregma/lambda) | Injected Material | Notes. Populate strictly from the passage text for that PMID. Multiple coordinate sets → separate rows. Missing values → "not stated in passage". List every relevant paper, most-relevant first.
6. If no papers in the pool are relevant to the requested region, say so plainly and offer general stereotaxic atlas guidance instead of fabricating citations.
7. Always close literature-grounded answers with a one-line reminder that this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## RELEVANT SURGICAL LITERATURE (passage-first index, ${relevantRefs.length} papers, most relevant first)
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

  // Converts the model's own [PMID:12345678] citation markers into clickable PubMed links.
  function linkifyPmids(text) {
    return (text || '').replace(/\[PMID:(\d{5,9})\](?!\()/g,
      (_, pmid) => `[[PMID:${pmid}]](https://pubmed.ncbi.nlm.nih.gov/${pmid}/)`);
  }

  async function handleChat(userMessage) {
    if (!userMessage.trim()) return;
    setIsLoading(true);
    setLoadingStatus(`Sending to ${selectedModel}...`);
    setChatInput('');
    const newMessage = { role: 'user', content: userMessage };
    const updatedMessages = [...chatMessages, newMessage];
    const streamingIdx = updatedMessages.length;
    setChatMessages([...updatedMessages, { role: 'assistant', content: '' }]);

    try {
      const recentContext = chatMessages.filter((m) => m.role !== 'system').slice(-4)
        .map((m) => m.content).join(' ');
      const ragQuery = `${recentContext} ${userMessage}`.trim();
      const systemPrompt = buildSystemPrompt(ragQuery);
      const messagesWithSystem = [systemPrompt, ...updatedMessages];

      const onToken = (partial) => {
        setChatMessages((prev) => {
          const next = [...prev];
          next[streamingIdx] = { role: 'assistant', content: partial };
          return next;
        });
      };

      setLoadingStatus('');
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
    if (window.confirm('Clear the conversation? This cannot be undone.')) setChatMessages([]);
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

  // Literature tab now lists passage papers (the surgery-relevant subset), not the raw corpus.
  const literatureList = [...passageIndex.values()];

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
                          : <div className="typing"><span /><span /><span /></div>}
                    </div>
                  </div>
                ))
              )}
              {isLoading && loadingStatus && <div className="loading-status">{loadingStatus}</div>}
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
            <p>{literatureList.length} papers with injection passages indexed for grounding chat answers.</p>
            <div className="paper-list">
              {literatureList.slice(0, 100).map((p) => (
                <div key={p.pmid} className="paper-card">
                  <div className="paper-meta">
                    <a href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`} target="_blank" rel="noreferrer">PMID:{p.pmid}</a>
                    <span>{(p.ccf_regions || []).join(', ')}</span>
                  </div>
                  <p>{((p.passages && p.passages[0] && p.passages[0].text) || p.title || '').slice(0, 300)}...</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
