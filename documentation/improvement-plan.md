# Neuroinjector Repository — General Improvement Plan

A technical reference for an LLM collaborator and the developer. Covers the full repo, not just the corpus. Read [documentation/corpus-improvement-plan.md](corpus-improvement-plan.md) for the corpus-specific deep-dive.

---

## 1. Repository Map

```
Neuroinjector/
├── react-app/                     ← Vite + React 18 assistant (the main product)
│   ├── src/
│   │   ├── App.jsx                ← Monolithic main file: UI + RAG + scoring + prompts
│   │   ├── MarkdownMessage.jsx    ← Renders LLM output with react-markdown + remark-gfm
│   │   ├── index.css              ← All styles (single file, ~430 lines + mobile breakpoints)
│   │   └── components/
│   │       └── AllenAtlasViewer.jsx  ← CCFv3 coronal slice navigator (inline styles)
│   ├── public/
│   │   ├── data/                  ← Runtime JSON data files (served statically)
│   │   └── atlas/                 ← CCFv3 manifest, structure list, coronal PNG slices
│   ├── vite.config.js             ← base: '/Neuroinjector-OSE/assistant/'
│   └── package.json
├── scripts/                       ← Node.js data pipeline (no bundler, no deps)
│   ├── build-injection-db.js      ← Full PubMed sweep → OVERWRITES stereotaxic-protocols.json
│   ├── fetch-targeted-fulltext.js ← Single-region upsert, SAFE (non-destructive)
│   ├── eutils-manual-search.js    ← PMID discovery for one query
│   ├── extract-injection-data.js  ← Offline regex → injection-coordinates.json
│   ├── ingest-protocols.js        ← 78-region abstract-level sweep
│   ├── publish-assistant.js       ← Copies dist/ → assistant/
│   └── sync-syringe-data.js       ← Copies shared data into react-app/public/
├── cloudflare-worker/
│   ├── worker.js                  ← Streaming LLM proxy (Azure APIM + FlyerGPT)
│   └── wrangler.toml
├── webapp/                        ← Legacy syringe configurator (static HTML/JS)
│   └── data/hamilton_syringes.json ← Single source of truth for syringe data
├── public/data/
│   └── surgical-protocols.json    ← Source of truth; synced to react-app/public/data/
├── injector_control_stepper/
│   └── injector_control.ino       ← Arduino firmware
├── assistant/                     ← Built output served by GitHub Pages (committed)
└── documentation/
    ├── corpus-improvement-plan.md ← Corpus-specific improvement plan
    └── improvement-plan.md        ← This file
```

### Key dependencies (react-app)
| Package | Version | Purpose |
|---|---|---|
| React | 18.3.1 | UI |
| Vite | 5.4.21 | Build |
| react-markdown | 9.0.1 | Render LLM markdown |
| remark-gfm | 4.0.0 | GFM table support in LLM output |
| lucide-react | 0.454.0 | Icons |

---

## 2. How the App Works (End to End)

1. User opens the GitHub Pages URL → static HTML/CSS/JS served from `assistant/`
2. On load, `App.jsx` fetches four JSON files from `public/data/`: `hardware-kb.json`, `hamilton-syringes.json`, `stereotaxic-protocols.json` + `surgical-protocols.json` (literature corpora), and `injection-coordinates.json` (pre-extracted index)
3. User types a question → `buildSystemPrompt()` assembles: firmware rules + hardware KB entries + syringe table + up to 18 mouse-only literature citations (with pre-extracted coordinates/injectates) → sent to the Cloudflare Worker proxy
4. Worker forwards to Azure APIM → LLM streams Server-Sent Events back → `App.jsx` renders the response via `MarkdownMessage.jsx`
5. Atlas Navigator tab: user navigates CCFv3 coronal slices, clicks a point, gets AP/ML/DV estimate, can pre-fill the chat input

---

## 3. Current Status

| Area | Status |
|---|---|
| Core chat functionality | ✅ Working |
| Hardware KB grounding | ✅ Working |
| Syringe table | ✅ Working |
| Literature RAG (mouse-only filter) | ✅ Working |
| Coordinate extraction from full-text | ✅ Working (231 papers) |
| Atlas Navigator (zoom, typable AP, click-to-coords) | ✅ Working |
| Mobile responsive layout | ✅ Done (bottom tab bar ≤767px) |
| Species filter (rat-only excluded) | ✅ Hard constraint in getRelevantRefs |
| Lambda vs bregma sign correction | ❌ Not done |
| DV depth phrasing gap | ❌ Not fully fixed |
| Volume/titer extraction | ❌ Not implemented |
| Offline PWA / service worker | ❌ Not implemented |

---

## 4. UI / Frontend Improvements

### 4a. Atlas viewer inline styles → CSS classes
`AllenAtlasViewer.jsx` uses a large `styles` object of inline styles. This makes theming and responsive overrides harder (CSS media queries can't override inline styles without `!important`). The canvas container's `maxHeight: '65vh'` currently requires a `!important` hack in the mobile CSS breakpoint.

**Fix**: Move all inline styles into `index.css` using BEM-style class names. This also reduces the component file size.

### 4b. Break up the monolithic App.jsx
`App.jsx` is ~560 lines and contains: state initialization, data fetching, scoring/RAG logic, system prompt construction, chat submit handler, atlas target handler, and the full JSX render tree for all four tabs. This is hard to maintain.

**Suggested split**:
- `hooks/useLiteraturePool.js` — data fetching + getMergedLiteraturePool + getRelevantRefs
- `hooks/useChat.js` — chat state, handleChat, streaming
- `lib/prompts.js` — buildSystemPrompt, firmwareRules
- `components/ChatView.jsx` — the chat tab JSX
- `components/HardwareView.jsx` — hardware + syringe tab JSX
- `components/LiteratureView.jsx` — literature tab JSX

### 4c. Chat input auto-resize
The `<textarea rows={1}` currently has a `max-height: 200px` in CSS but doesn't auto-resize as the user types. Add a small `useEffect` or `onInput` handler that sets `element.style.height = 'auto'; element.style.height = element.scrollHeight + 'px'`.

### 4d. Streaming response rendering lag
The current implementation appends the full streamed content as one string update per chunk. For long responses with tables, this causes visible jank. Consider using a `requestAnimationFrame` debounce or batching updates every 50ms.

### 4e. Chat history persistence
Currently chat history is lost on page refresh. Saving to `localStorage` (with a size cap, e.g. last 20 messages) would significantly improve the returning-user experience.

### 4f. Mobile: atlas canvas too small
On phones the coronal slice is compressed to ~45vw (roughly 170px wide on a 380px phone). Adding a full-screen mode button (expand atlas to 100vw × 100dvh) would make it usable.

### 4g. Coordinate table: copy-to-clipboard
The RAG output tables include AP/ML/DV values. A small "copy coordinates" button on the table row (rendered by `MarkdownMessage.jsx`) would be a practical UX win for users at the bench.

### 4h. Dark/light theme: atlas is always dark
`AllenAtlasViewer.jsx` hardcodes dark colors (`#0f172a`, `#1e293b`, etc.) in its inline styles. In light mode the atlas panel looks wrong. Fix: move to CSS variables (`var(--panel)`, `var(--border)`, etc.) once styles are moved to CSS (see 4a).

### 4i. Manual coordinate input for ML and DV
The atlas viewer already has a typable AP input, but ML and DV are **read-only** in the `targetCard` display. Users frequently know the coordinates they want to target but have to awkwardly click the slice image to get the cursor near the right spot.

**Fix**: Replace the three read-only text rows in the `targetCard` with three `<input type="number">` fields (AP already exists in the slider section; add matching ML and DV inputs). On change:
- AP: reuse existing `handleApInput` to jump the slice
- ML + DV: update `clickedTarget.ml` / `clickedTarget.dv` in state and call `onTargetSelect` with the updated target so the side panel and chat pre-fill reflect the typed values
- Update the crosshair marker on the SVG by recomputing `xRatio = (ml_mm / CCF_VOXEL_SIZE_MM + MIDLINE_ML_VOXEL) / 1140` and `yRatio = (dv_mm / CCF_VOXEL_SIZE_MM + BREGMA_DV_VOXEL) / 800`

All three inputs should be grouped in a `\"Manual coordinate entry\"` row with step=0.05 and a clear `mm` label. This makes the atlas useful as a coordinate calculator even without clicking.

### 4j. Coronal slice gridlines at 1 mm scale (Paxinos-style)
The CCFv3 SVG viewBox is `0 0 1140 800`, where each SVG unit = 1 voxel = 0.01 mm (10 µm). Therefore **1 mm = 100 SVG units**. The existing midline and DV-surface reference lines are already rendered; adding a full Paxinos-style 1 mm grid only requires adding `<line>` elements to the SVG before the crosshair overlay.

**Implementation** (inside the `<svg>` in `AllenAtlasViewer.jsx`):
```jsx
{/* 1 mm gridlines — ML axis (vertical), centered on midline voxel 570) */}
{Array.from({ length: 13 }, (_, i) => i - 6).map((n) => (
  n !== 0 && <line key={`ml${n}`} x1={570 + n * 100} y1={0} x2={570 + n * 100} y2={800}
    stroke="#334155" strokeWidth="1" strokeDasharray="3 5" />
))}
{/* 1 mm gridlines — DV axis (horizontal), origin at bregma-surface voxel 44 */}
{Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
  <line key={`dv${n}`} x1={0} y1={44 + n * 100} x2={1140} y2={44 + n * 100}
    stroke="#334155" strokeWidth="1" strokeDasharray="3 5" />
))}
```
Grid labels (e.g. `−2 mm`, `+1 mm`) can be added as `<text>` elements at the slice edges. Add a `\"Show grid\"` toggle checkbox alongside the existing `\"Show boundaries\"` toggle.

### 4k. Click-to-region identification from CCFv3 structure centroids
Currently `handleSvgClick` sets `region: 'Custom Click'` with no structure name — so when the user forwards a custom click to the assistant, the prompt says `\"region: Custom Click\"` which gives the LLM no anatomical context.

**Phase 1 — centroid-based nearest-structure lookup (feasible now):**
`ccfv3_structures.json` already has `ap_mm`, `ml_mm`, `dv_mm` centroid fields for every CCF structure. On click:
1. Get clicked AP (from current slice), ML, DV
2. Filter structures to those within ±1.5 mm AP of `activeSlice.ap_mm` to avoid matching a distant nucleus
3. Compute 2D Euclidean distance in the coronal plane: `d = √((s.ml_mm − clickedML)² + (s.dv_mm − clickedDV)²)`
4. Take the closest structure
5. Set `region: closest.acronym, name: closest.name` in `targetData` instead of `'Custom Click'`

Limitation: centroid matching is coarse (~1–2 mm error for small nuclei). But it's vastly better than no region name, and it is already fully offline with no extra data.

**Phase 2 — pixel-perfect annotation overlay (requires pre-rendered PNGs):**
The CCFv3 annotation volume at 50 µm resolution could be pre-rendered into per-slice PNG images with each pixel color-coded by structure ID. On click, read the pixel under the cursor using `canvas.getImageData()` → look up structure ID → get the name. This is accurate to 50 µm. The annotation volume export can be generated with the AllenSDK (`allensdk.core.reference_space_cache`). Storage cost: ~same as existing template PNGs.

**What to pass to the assistant:** Update `askAboutAtlasTarget()` in `App.jsx` to include both `atlasTarget.region` (CCF acronym) and `atlasTarget.name` (full structure name) in the pre-filled chat message, e.g.: `\"...targeting [CCF: SIM — Simplex lobule] around AP −2.0 mm, ML +1.5 mm, DV −2.0 mm...\"`. The RAG region-scoring in `getRelevantRefs()` should also boost papers whose `region_categories` contain the identified structure name.

---

## 5. Backend / Worker Improvements

### 5a. Model selector not reflected in the API call
The `selectedModel` state (GPT-5.5 / GPT-5.4 buttons) is stored in `App.jsx` state but the actual model name sent to the worker is hardcoded in `handleChat()`. Wire the state to the request body.

### 5b. Worker: no rate limiting per IP
The Cloudflare Worker has a query counter (KV-based) but no per-IP rate limit. A burst of queries from one client could exhaust the Azure APIM quota. Add a simple per-IP token bucket using Cloudflare's `env.RATE_LIMITER` (Durable Object) or a KV TTL trick.

### 5c. Error handling in the worker stream
If the upstream Azure APIM returns a 429 or 5xx mid-stream, the worker currently passes the partial response through. The client receives a truncated answer with no error signal. Add an error sentinel in the SSE stream and handle it in `App.jsx` to show a user-visible retry message.

### 5d. Allowed origins list is hardcoded
`ALLOWED_ORIGINS` in `worker.js` is a hardcoded Set. It should be pulled from a Cloudflare Worker secret (`env.ALLOWED_ORIGINS`) so it can be updated without a redeploy.

---

## 6. Data Pipeline Improvements

See [documentation/corpus-improvement-plan.md](corpus-improvement-plan.md) for full details. Summary of highest-impact items:

### 6a. Fix remaining DV depth-phrasing gaps
Add patterns to `extract-injection-data.js` for:
- `"depth from the skull surface was X mm"` → `depth from (?:the )?skull(?: surface)? (?:was|of) (NUM) mm`
- `"X mm below the dura"` → `(NUM) mm (?:below|ventral to) (?:the )?dura`
- `"inserted to a depth of X mm"` — already caught by current `depth of` pattern

### 6b. Add `reference_point` field to coordinate records
Tag each coordinate set with `bregma`, `lambda`, or `unknown` based on proximity of the words in the source sentence. Lambda-referenced AP values need to be flagged to avoid sign confusion.

### 6c. Add volume and titer extraction
Capture injection volume (nL/μL) and virus titer from the methods text and store alongside each coordinate set. Patterns:
- Volume: `(\d+(?:\.\d+)?)\s*(?:nL|nl)` / `(\d+(?:\.\d+)?)\s*[μu]L`
- Titer: `(\d+(?:\.\d+)?\s*[×x]\s*10\^?\d+)\s*(?:GC|vg|TU|IU)\/(?:mL|ml)`

### 6d. Targeted sweeps for data-poor regions
Priority: BLA, DG, ACC, LC, Insular Cortex, M1/M2, S1, DRN. Query template:
```
("REGION"[Title/Abstract]) AND (bregma[Title/Abstract] OR stereotaxic[Title/Abstract]) AND (mouse OR mice) AND "pmc"[sb]
```
Adding `AND "pmc"[sb]` restricts to Open Access papers, dramatically increasing the full-text hit rate.

### 6e. `build-injection-db.js` is all-or-nothing
The full 13-region rebuild currently takes several minutes and overwrites everything. Consider adding a `--regions` CLI flag to rebuild just selected regions, reducing the risk of accidental data loss.

### 6f. Cerebellar lobule coverage — named lobules absent from corpus
The current corpus has broad `"Cerebellum"` and `"Cerebellar Cortex"` region tags but no queries for individual named lobules. Regions like **SIM (Simplex / lobule VI)**, **Crus I**, **Crus II**, **lobule IV/V (motor), lobule IX (uvula), lobule X (nodulus/flocculus)** return zero or near-zero results because the search queries don't include lobule-specific terminology.

High-priority lobules for injection research:
| CCF acronym | Full name | Why it matters |
|---|---|---|
| SIM | Simplex | Sensorimotor integration; climbing fiber inputs |
| CUL | Culmen (lobule V) | Forelimb motor cortex input zone |
| CRU1, CRU2 | Crus I, Crus II | Cognitive cerebellum, prefrontal connections |
| NOD | Nodulus (lobule X) | Vestibular processing |
| FL | Flocculus | Oculomotor/vestibulo-ocular reflex |
| CENT | Central lobule (II/III) | — |

**Fix**: Add targeted query blocks to `ingest-protocols.js` and run `fetch-targeted-fulltext.js` sweeps for each:
```
("simplex lobule"[Title/Abstract] OR "lobule VI"[Title/Abstract] OR "SIM"[Title/Abstract]) 
AND (stereotaxic[Title/Abstract] OR bregma[Title/Abstract]) AND (mouse OR mice) AND "pmc"[sb]
```
Also update the `RODENT_BRAIN_REGIONS` block in `build-injection-db.js` to split the current generic `'Cerebellum'` block into `'Cerebellum (vermis)'`, `'Cerebellum (hemispheres/Crus)'`, and `'Deep Cerebellar Nuclei'` with lobule-specific search terms.

---

## 7. Firmware / Hardware

### 7a. Hardware KB is hardcoded in App.jsx
The hardware knowledge base (wiring diagrams, part numbers, pin assignments) is loaded from a JSON file but the content was manually assembled. Consider a proper `hardware-kb.json` structured data file in `public/data/` so updates don't require touching App.jsx.

### 7b. Syringe configurator (webapp/) is a separate product
`webapp/` is a standalone static app (legacy syringe configurator). It shares `hamilton_syringes.json` with the assistant via `scripts/sync-syringe-data.js`. If new syringe models are added, update `webapp/data/hamilton_syringes.json` — the sync script will propagate the change on next `npm run build`.

### 7c. Firmware docs not embedded
The firmware `.ino` file is in `injector_control_stepper/` but is not parsed or embedded in the assistant's context. An LLM can answer firmware questions from the `firmwareRules` string in `buildSystemPrompt()`, but this is manually maintained. A better approach: parse the `.ino` at build time to extract constants and pin assignments, then auto-generate a firmware facts object.

---

## 8. Infrastructure / DevOps

### 8a. Deployment is manual
After `npm run deploy` the developer must `git add assistant/ && git commit && git push` to publish. A GitHub Actions workflow could automate this: push to `main` → build → commit updated `assistant/` → push.

**Example `.github/workflows/deploy.yml` trigger:**
```yaml
on:
  push:
    branches: [main]
    paths:
      - 'react-app/src/**'
      - 'react-app/public/**'
      - 'scripts/publish-assistant.js'
```

### 8b. No CI/tests
There are no tests of any kind. At minimum:
- A smoke test for each script (`node scripts/extract-injection-data.js` exits 0 without writing garbage)
- A snapshot test of the coordinate extraction output for a known PMID (regression guard for future regex changes)
- A Playwright test that loads the deployed app, types a question, and checks for a non-empty response

### 8c. Large binary files in git
The `public/atlas/` directory contains ~hundreds of PNG files (CCFv3 coronal slices). These are committed directly to git, which bloats the repository clone. Consider:
- Git LFS for the PNG files
- Or hosting the PNGs on a CDN (e.g. Cloudflare R2) and fetching via URL at runtime

### 8d. .env is gitignored but no .env.example
New contributors have no guidance on what environment variables are needed. Add a `.env.example` file:
```
NCBI_API_KEY=      # Get free key at https://www.ncbi.nlm.nih.gov/account/
```

---

## 9. Ordered Priority List

These are ordered roughly by impact vs effort:

| # | Task | Impact | Effort | Area |
|---|---|---|---|---|
| 1 | Fix DV depth phrasing gap (Section 6a) | High | Low | Data |
| 2 | Add reference_point field to coords (Section 6b) | High | Low | Data |
| 3 | Volume + titer extraction (Section 6c) | High | Low | Data |
| 4 | Targeted sweeps — BLA, DG, ACC, LC (Section 6d) | High | Medium | Data |
| 5 | Click-to-region: centroid-based lookup (Section 4k, Phase 1) | High | Low | UI |
| 6 | Manual ML + DV typed inputs in atlas (Section 4i) | High | Low | UI |
| 7 | Cerebellar lobule corpus sweeps — SIM, Crus, NOD etc. (Section 6g) | High | Medium | Data |
| 8 | 1 mm gridlines on atlas coronal slice (Section 4j) | High | Low | UI |
| 9 | Chat input auto-resize (Section 4c) | Medium | Low | UI |
| 10 | Chat history persistence in localStorage (Section 4e) | Medium | Low | UI |
| 11 | Wire model selector to actual API call (Section 5a) | Medium | Low | Backend |
| 12 | Atlas dark theme fix — use CSS variables (Sections 4a, 4h) | Medium | Medium | UI |
| 13 | Add .env.example (Section 8d) | Low | Very Low | DX |
| 14 | GitHub Actions auto-deploy (Section 8a) | Medium | Medium | DevOps |
| 15 | Worker per-IP rate limiting (Section 5b) | Medium | Medium | Backend |
| 16 | Streaming render debounce (Section 4d) | Low | Low | UI |
| 17 | Component split of App.jsx (Section 4b) | Low | High | UI |
| 18 | Atlas full-screen mode on mobile (Section 4f) | Medium | Low | UI |
| 19 | Click-to-region: annotation PNG overlay (Section 4k, Phase 2) | High | High | UI |
| 20 | Git LFS for atlas PNGs (Section 8c) | Low | Medium | DevOps |
| 21 | `build-injection-db.js` --regions flag (Section 6f) | Low | Medium | Data |
| 22 | CI/tests (Section 8b) | Medium | High | DevOps |
