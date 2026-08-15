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

// A coordinate value may be a number OR a range string ("0.1 to 0.5", "-5 to -6"), OR null.
function fmtCoord(v) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return String(v);
}
function fmtNum(v, unit) {
  if (v === null || v === undefined || v === '') return 'not stated';
  return `${v}${unit || ''}`;
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
  const [injectionIndex, setInjectionIndex] = useState(new Map());   // legacy coords + species
  const [passageIndex, setPassageIndex] = useState(new Map());       // fallback passage text
  const [structuredIndex, setStructuredIndex] = useState(new Map()); // PRIMARY: OSC 92% coords
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
    fetch('data/stereotaxic-protocols.json').then((r) => r.json()).then(setLiteraturePapers)
      .catch(() => { /* optional secondary methods pool */ });
    fetch('data/injection-coordinates.json').then((r) => r.json())
      .then((arr) => setInjectionIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => { /* optional species tag */ });
    // Fallback passage text (region-bound injection sentences).
    fetch('data/injection-passages.json').then((r) => r.json())
      .then((arr) => setPassageIndex(new Map(arr.map((rec) => [String(rec.pmid), rec]))))
      .catch(() => { /* optional */ });
    // PRIMARY RAG SOURCE: OSC-distilled structured coordinates (object keyed by PMID).
    //   { "<pmid>": { pmid, targets: [{ region_verbatim, ccf_region, ap_mm, ml_mm, dv_mm,
    //     reference, volume_nl, rate_nl_min, source_quote }], ok } }
    // Coordinates pre-parsed & 92% validated vs human ground truth. Values may be a number
    // OR a range string ("0.1 to 0.5"). Bilateral papers carry two targets (+/-ML).
    fetch('data/injection-structured.json').then((r) => r.json())
      .then((obj) => {
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

  // Retrieval pool, merged in priority order:
  //   1. injection-structured.json  — PRIMARY: pre-parsed AP/ML/DV/ref/vol/rate (92% validated)
  //   2. injection-passages.json     — fallback region-bound passage text (+ title)
  //   3. stereotaxic-protocols.json  — fallback full-text methods
  function getMergedLiteraturePool() {
    const pool = new Map();

    // 1. Structured coordinates (skip papers with no usable target).
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

    // 2. Passages — add title + region tags + passage text.
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

    // 3. Stereotaxic methods — add methods text.
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
    return !(isRat && !isMouse); // exclude rat-only; keep mouse/mixed/unknown
  }

  function getRelevantRefs(query, topN = 10) {
    const words = tokenize(query);
    const lowerQuery = (query || '').toLowerCase();
    const pool = getMergedLiteraturePool().filter(isMousePaper);
    if (!pool.length) return [];

    const scored = pool.map((entry) => {
      const passageText = (entry.passages || []).map((p) => p.text).join(' ');
      const text = `${entry.title || ''} ${entry.regionText} ${passageText.slice(0, 1500)} ${entry.methodsText.slice(0, 1000)}`;
      let score = scoreText(words, text);

      // Strong boost for explicit region/acronym matches in the query.
      let regionMatched = false;
      entry.regions.forEach((r) => {
        if (r && lowerQuery.includes(r.toLowerCase())) { score += 10; regionMatched = true; }
      });
      // Also match query words against structured region text (ccf_region + verbatim).
      const regScore = scoreText(words, entry.regionText);
      if (regScore > 0) { score += regScore * 2; regionMatched = true; }

      // Structured targets with real coordinates are the highest-value evidence.
      const structTargets = entry.structuredTargets || [];
      const structWithCoords = structTargets.filter(
        (t) => t.ap_mm != null || t.ml_mm != null || t.dv_mm != null);
      if (structWithCoords.length) score += 5;

      const indexed = injectionIndex.get(String(entry.pmid));

      return {
        entry: {
          ...entry,
          structWithCoords,
          hasStructured: structWithCoords.length > 0,
          species: indexed?.species || null,
          regionMatched,
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

  function buildSystemPrompt(query) {
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

    const citationPool = relevantRefs.length
      ? relevantRefs.map((r, i) => {
        const pmidLink = `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
        const header = `[${i + 1}] PMID:${r.pmid}${r.title ? ` — "${r.title}"` : ''}${r.species ? ` (${r.species})` : ''}`;

        if (r.hasStructured) {
          // PRIMARY: emit the pre-parsed, validated coordinate fields directly.
          const lines = r.structWithCoords.map((t) => {
            const region = t.ccf_region || t.region_verbatim || 'unspecified region';
            const ap = fmtCoord(t.ap_mm), ml = fmtCoord(t.ml_mm), dv = fmtCoord(t.dv_mm);
            const ref = t.reference || 'not stated';
            const vol = fmtNum(t.volume_nl, ' nL');
            const rate = fmtNum(t.rate_nl_min, ' nL/min');
            return `     • ${region} — AP ${ap}, ML ${ml}, DV ${dv} mm (ref: ${ref}); volume ${vol}; rate ${rate}`;
          }).join('\n');
          return `${header}\n   ✓ Validated stereotaxic coordinates (OSC-distilled, 92% verified):\n${lines}\n   Verify full context: ${pmidLink}`;
        }

        // FALLBACK: region-bound passage text (LLM parses), for papers with no structured target.
        const p = (r.passages || [])[0];
        const excerpt = (p?.text || r.methodsText || '').trim().slice(0, 400);
        const evidence = excerpt
          ? `Injection passage${p?.reference_point ? ` [ref: ${p.reference_point}]` : ''}: "${excerpt}${excerpt.length >= 400 ? '…' : ''}"`
          : 'No structured coordinates or passage indexed for this paper.';
        return `${header} (regions: ${r.regions.join(', ') || 'unspecified'})\n   ${evidence}\n   Verify full context: ${pmidLink}`;
      }).join('\n\n')
      : '(no directly matching surgical literature indexed for this query — answer from general veterinary/stereotaxic knowledge and say so)';

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

## SURGICAL LITERATURE CITATION RULES — HARD CONSTRAINTS
1. Cite ONLY PMIDs from the numbered list below. NEVER invent, recall, or guess a PMID from training. Format as exactly [PMID:XXXXXXX] (auto-linked).
2. NEVER attach a coordinate, region, volume, or rate to a PMID unless it is explicitly listed under that PMID below. Do NOT transfer a value from one paper to another. Do NOT fabricate numbers. If a paper's line does not contain a value, it is "not stated".
3. TABLE RULE: for any coordinate/target/parameter query, respond with a GitHub-flavored markdown table: Paper (PMID) | Region(s) | AP (mm) | ML (mm) | DV (mm) | Reference | Volume | Rate | Notes.
4. VALIDATED COORDINATES: Entries marked "✓ Validated stereotaxic coordinates" are pre-parsed, human-verified fields. Report their AP/ML/DV/reference/volume/rate EXACTLY as given — do NOT re-derive, round, or alter them, and do NOT write "not stated" when a value is present. Report a value as "not stated" ONLY when the line literally shows "not stated".
5. REGION BINDING: A coordinate set belongs ONLY to the region named on its own line. If a paper lists multiple targets (e.g. simple lobule vs interposed nucleus), report them on SEPARATE rows. NEVER present one region's coordinates as another's. Lambda- and bregma-referenced values are NOT interchangeable — always report the Reference column.
6. If NONE of the listed papers name the requested region, say so plainly and give general atlas guidance — do NOT substitute a different structure's coordinates or invent one. It is correct and expected to say "the indexed literature does not contain a coordinate for X."
7. Every coordinate row must include its [PMID:XXXXXXX] link. Do not paste partial source-quote fragments as evidence — the validated fields + PMID link ARE the citation.
8. Close literature-grounded answers with a one-line reminder that this is not a substitute for IACUC-approved protocols or veterinary/atlas verification.

${firmwareRules}

## CURRENT NEUROINJECTOR HARDWARE KNOWLEDGE
${hwContext}

## HAMILTON SYRINGE COMPATIBILITY TABLE
${syringeTable}

## RELEVANT SURGICAL LITERATURE (structured-coordinate first, ${relevantRefs.length} papers, most relevant first)
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
      setLoadingStatus('Finding relevant papers…');
      const recentContext = chatMessages.filter((m) => m.role !== 'system').slice(-4)
        .map((m) => m.content).join(' ');
      const ragQuery = `${recentContext} ${userMessage}`.trim();

      setLoadingStatus('Reading validated coordinates…');
      const systemPrompt = buildSystemPrompt(ragQuery);
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
            <p>{structuredCount} papers with validated structured stereotaxic coordinates (OSC-distilled, 92% verified).</p>
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
