# Neuroinjector Assistant — Corpus & Data Richness Improvement Plan

This document is a technical reference for a new LLM collaborator and the developer working on expanding the stereotaxic injection literature corpus that powers the RAG-grounded chat assistant. Read this before writing any code.

---

## 1. System Overview

The assistant is a React app deployed to GitHub Pages at `assistant/`. Its core value is grounding answers to stereotaxic injection questions in **real, citable mouse literature** instead of hallucinated facts.

```
PubMed (NCBI E-utils)
     │
     ▼
scripts/build-injection-db.js         ← broad 13-region sweep, overwrites corpus
scripts/fetch-targeted-fulltext.js    ← single-region upsert (non-destructive)
scripts/ingest-protocols.js           ← abstract-level, 78-region sweep
     │
     ▼
react-app/public/data/
  stereotaxic-protocols.json          ← 713 records, full PMC methods text (≤4 KB each)
  surgical-protocols.json             ← ~86-region keyed abstract snippets
     │
     ▼
scripts/extract-injection-data.js     ← offline regex pipeline, no network
     │
     ▼
react-app/public/data/
  injection-coordinates.json          ← 4805 PMIDs, with species/coords/injectate/CCF fields
     │
     ▼
react-app/src/App.jsx
  getMergedLiteraturePool()            ← merges both corpora by PMID
  isMousePaper()                       ← hard species filter (excludes rat-only)
  getRelevantRefs()                    ← token-scoring, returns top-18 mouse papers
  buildSystemPrompt()                  ← injects coordinate/injectate/CCF data into LLM context
```

### Key data files and what they contain

| File | Records | Source |
|---|---|---|
| `stereotaxic-protocols.json` | 713 | PMC full-text (JATS XML → methods section → condensed to ≤4 KB) |
| `surgical-protocols.json` | ~3,000+ entries across ~86 regions | PubMed abstract-level snippets via `ingest-protocols.js` |
| `injection-coordinates.json` | 4,805 PMIDs | Regex-extracted from both above; **this is what the LLM sees** |

---

## 2. Current Corpus Quality Stats (as of 2026-08-01)

All numbers are **mouse/mixed/unknown species only** (rat-only papers are hard-excluded from RAG).

| Metric | Count |
|---|---|
| Total mouse-eligible PMIDs | 1,250 |
| With extracted AP+ML coordinates | 105 |
| With at least one DV (depth) value | 75 |
| With extracted injectate (AAV/tracer/drug) | 198 |
| With both coordinates AND injectate | **41** |
| With full-text methods | 368 |
| Abstract-only (no full-text) | 882 |
| Average coordinate sets per paper (where present) | 1.44 |

**The critical number is 41.** Only 41 mouse papers in the entire corpus have both a specific injection site AND the reagent that was delivered. This is what the "TABLE" in the LLM answer draws from.

### Region coverage (mouse papers with extracted coordinates)

Sorted worst → best:

| Region | Mouse papers with coords |
|---|---|
| Cerebellar Cortex, Cerebellar Vermis, Insular Cortex, BLA, SCN, DG, CA3, NAcC, NAcS, M1, M2, S1, PVN, DMH, OFB | **1 each** |
| DRN, LC, CA2, CeA, ACC, EC, mPFC, GP | 2 each |
| SNc | 3 |
| VTA, LH, PAG | 4 each |
| Cerebellum (broad) | 5 |
| Amygdala & BNST, Brainstem, Thalamus | 9–10 |
| Hippocampus & Subiculum | 13 |
| Prefrontal Cortex | 14 |
| Striatum & NAc | 16 |
| Midbrain (VTA & SN) | 18 |
| Hypothalamus | **19** (best) |

Most clinically important regions (mPFC, BLA, DG, CA1, LC, ACC) have only 1–2 papers with usable coordinates. **This is the primary gap to close.**

---

## 3. The Pipeline — How to Run It

You need an NCBI API key for the network scripts (10 req/s limit vs 3 without). Store it in a `.env` file in the repo root (already gitignored):

```
# .env (repo root — gitignore entry already present)
NCBI_API_KEY=your_key_here
```

Get a free key at: https://www.ncbi.nlm.nih.gov/account/

### Step A — Targeted search (find PMIDs for one region)

```powershell
# Run from repo root
node scripts/eutils-manual-search.js "<pubmed query>" output.json
```

Example:
```powershell
node scripts/eutils-manual-search.js `
  '("basolateral amygdala"[Title/Abstract]) AND (stereotaxic[Title/Abstract] OR bregma[Title/Abstract]) AND (mouse OR mice)' `
  bla-hits.json
```

Output: `bla-hits.json` — array of `{pmid, title, journal, pubdate, authors}`. **Review the titles manually** before proceeding. Discard off-topic hits (e.g. EEG electrode papers, slice electrophysiology papers, papers that used "stereotaxic" to describe surgical access but didn't inject anything).

#### PowerShell quoting rule
Inside a PowerShell command, use **single-quote outer** with **literal double-quotes inside**:
```powershell
node scripts/eutils-manual-search.js '("some term"[Title]) AND ...' out.json
```
Never use `\"` inside a double-quoted string in PowerShell — it breaks silently.

### Step B — Fetch full-text for those PMIDs (non-destructive merge)

```powershell
# Run from repo root
node scripts/fetch-targeted-fulltext.js "Region Label" bla-hits.json
```

This:
1. Resolves PMIDs → Open Access PMCIDs (only ~20–40% of papers are OA on PMC)
2. Fetches PMC JATS XML → extracts methods/surgery/animal sections
3. Scores sentences by surgical signal density → keeps top ≤4 KB
4. **Upserts** each paper into `stereotaxic-protocols.json` by PMID (never overwrites existing papers)
5. Reports: `New papers added: N`, `Existing merged: M`, `Total corpus size: X`

### Step C — Regenerate the coordinate/injectate index

```powershell
# Run from repo root
node scripts/extract-injection-data.js
```

This is fast (<5s), offline, and rewrites `injection-coordinates.json` from scratch every time. Always run after Step B.

### Step D — Build and deploy

```powershell
cd react-app
npm run deploy
```

This runs: prebuild (sync syringe data) → `vite build` → `publish-assistant.js` (copies `dist/` → `assistant/`). Then commit the `assistant/` folder and push to publish via GitHub Pages.

### Full workflow summary

```
eutils-manual-search.js  →  fetch-targeted-fulltext.js  →  extract-injection-data.js  →  npm run deploy
      (find PMIDs)              (fetch full text)              (regenerate index)            (publish)
```

---

## 4. Known Extraction Limitations (Current Extractor Bugs / Gaps)

### 4a. Depth-from-skull phrasing not captured

The extractor catches:
- `AP -1.5 mm, ML ±1.0 mm, DV -2.3 mm`
- `2.5 mm posterior, 1.0 mm lateral`
- `at a depth of 3.0 mm`

It does **not** yet catch:
- `"depth from the skull surface was 3.0 mm"` → needs pattern: `depth from (?:the )?skull(?: surface)? (?:was|of) (NUM) mm`
- `"3.0 mm below the dura"` → needs: `(NUM) mm (?:below|ventral to) (?:the )?dura`
- `"inserted to a depth of 3.0 mm"` → similar

**Fix**: Add 3–4 more DV-phrasing patterns to the `DEPTH_PATTERN` logic in `extract-injection-data.js` (around line 50).

### 4b. Lambda-referenced coordinates not sign-corrected

The extractor captures the raw numeric value from lambda-referenced papers (e.g. "2.85 mm posterior from lambda") but stores it as positive `AP: "2.85"` when it should arguably be negative relative to bregma (lambda is ~4 mm behind bregma in mice). This means lambda-referenced and bregma-referenced coordinates both appear as positive AP values in the index, and the LLM has no way to distinguish them.

**Fix option 1 (recommended)**: Add a `reference_point: "bregma" | "lambda" | "unknown"` field to each coordinate set during extraction, so the LLM can display a warning to the user.

**Fix option 2 (harder)**: Automatically convert lambda → bregma by adding +3.9 mm to the AP coordinate (average mouse lambda–bregma distance). But this introduces a ±0.5 mm population-level error and should be clearly flagged.

### 4c. "Both hemispheres" ML values

Some papers report bilateral injections as `"±1.5 mm ML"`, which the extractor stores as `ml: "±1.5"`. This is correct and intentional — the `±` prefix signals bilaterality. The LLM prompt should instruct the assistant to interpret `±` ML values as bilateral.

### 4d. Coordinates spread across multiple sentences

The extractor uses a 3-sentence sliding window. Some papers report coordinates in a table or list format, e.g.:
```
Injection site: mPFC
  AP: +2.0 mm
  ML: ±0.4 mm
  DV: -2.5 mm
```
These are sometimes missed because the AP/ML/DV values are in different sentences without a nearby `mm` unit. **Fix**: Add a list-format coordinate pattern: `\b(AP|ML|DV)\s*:\s*([+-]?\d+(?:\.\d+)?)` (no `mm` required if surrounded by the other axis labels).

### 4e. Injectate titer/promoter not captured

The extractor captures the virus name (e.g. `AAV2/8-hSyn-EGFP-WPRE-pA`) but not volume or titer (e.g. `1×10¹² GC/mL, 200 nL`). Titer and volume are highly useful for protocol planning.

**Fix**: Add patterns for:
- Volume: `(\d+(?:\.\d+)?)\s*nL` / `(\d+(?:\.\d+)?)\s*μL`
- Titer: `(\d+(?:\.\d+)?\s*[×x]\s*10\^?\d+)\s*(?:GC|vg|TU|IU)\/(?:mL|ml)`

And store as `volume_nl` and `titer` sub-fields under each injectate record.

---

## 5. Corpus Growth Strategy

### Priority 1: Get more Open Access mouse papers with full-text

The single highest-leverage action. Currently only ~30% of relevant papers are Open Access on PMC. Focus searches on:
- **Recent papers (2020–present)**: NIH mandate means most federally-funded papers since 2022 are OA.
- **JoVE (Journal of Visualized Experiments)**: Almost every JoVE neuroscience paper is OA and has extremely detailed surgical protocols. PubMed query filter: add `AND ("Journal of visualized experiments"[Journal])` to any region query.
- **eLife, PLOS ONE, Frontiers, Cell Reports**: All fully OA.
- **bioRxiv preprints**: Not indexed by PubMed/PMC but are fully accessible; would require a separate Biorxiv API integration.

### Priority 2: Region-by-region targeted sweeps

Run the `eutils-manual-search.js → fetch-targeted-fulltext.js` workflow for each data-poor region. Priority order (1 = worst coverage):

1. Basolateral Amygdala (BLA) — critical fear circuit target
2. Dentate Gyrus (DG) / CA1 — hippocampal subfield injections
3. Anterior Cingulate Cortex (ACC)
4. Locus Coeruleus (LC)
5. Insular Cortex
6. Nucleus Accumbens Shell/Core (NAcS, NAcC)
7. Primary/Secondary Motor Cortex (M1, M2)
8. Somatosensory Cortex (S1 / barrel)
9. Dorsal Raphe (DRN)
10. Cerebellar Cortex / Vermis

**Suggested PubMed query template per region:**
```
("REGION NAME"[Title/Abstract]) AND (stereotaxic[Title/Abstract] OR bregma[Title/Abstract] OR microinjection[Title/Abstract]) AND (mouse OR mice) AND ("open access"[filter] OR "pmc"[sb])
```
Adding `AND ("open access"[filter] OR "pmc"[sb])` upfront dramatically increases the fraction of papers that are actually fetchable.

### Priority 3: Manual entry for high-value paywalled papers

Some landmark papers (e.g. specific Deisseroth/Bhatt lab protocols for BLA-mPFC circuits) are behind paywalls. Options:
1. The developer can manually paste the methods section text into a local JSON file and import it via `fetch-targeted-fulltext.js` with a custom XML stub.
2. Add a `scripts/add-manual-entry.js` script that takes a PMID + pasted methods text and upserts it directly into `stereotaxic-protocols.json`.

### Priority 4: Broader `build-injection-db.js` query improvements

The current `INJECTION_QUALIFIER` in `build-injection-db.js` requires the word "stereotaxic", "stereotactic", "microinjection", or "Bregma" in the title/abstract. This misses papers that describe injections in the body of the text but not the abstract. Consider relaxing to just include the brain region term + `(mouse OR mice)` and increasing the retmax.

Also: the current 13 `RODENT_BRAIN_REGIONS` blocks use broad category labels. Split the cerebellum block into:
- `"Cerebellar Cortex"`: Purkinje cell layer, granule cell layer, molecular layer
- `"Deep Cerebellar Nuclei"`: dentate nucleus, interposed nucleus, fastigial nucleus

### Priority 5: Structured atlas reference annotation

Currently `ccf_regions` in `injection-coordinates.json` is matched by text similarity against CCFv3 structure names. A better approach would be to:
1. Store the exact CCF structure ID (integer) for the injection target alongside the coordinate.
2. Compute the nearest structure from the coordinate itself using a CCF lookup: given AP/ML/DV, find which structure's centroid is closest.

This requires the full CCF annotation volume or a centroid table — the `ccfv3_structures.json` already has `ap_mm`/`ml_mm`/`dv_mm` centroid fields, so the nearest-centroid approach is feasible with a Euclidean distance search in `extract-injection-data.js`.

---

## 6. Architecture Constraints to Be Aware Of

### `build-injection-db.js` is destructive
Every run **overwrites** `stereotaxic-protocols.json` entirely. Do not run this unless you want to redo the full sweep. Use `fetch-targeted-fulltext.js` for all incremental additions.

### `extract-injection-data.js` is idempotent
Safe to re-run any time. It reads both corpora and regenerates `injection-coordinates.json` from scratch. Always run after modifying `stereotaxic-protocols.json`.

### The app reads `injection-coordinates.json` at runtime
`App.jsx` fetches `data/injection-coordinates.json` on load and stores it in `injectionIndex` (a `Map` keyed by PMID). Adding new papers requires: Step B → Step C → Step D (deploy).

### Species filter is hard in `App.jsx`
`isMousePaper()` uses the pre-tagged `species` field from `injection-coordinates.json`. Papers tagged `"rat"` are excluded before scoring. Papers tagged `"unknown"` are included — this is intentional since species text can appear later in a paper. The filter errs on the side of inclusion for unknowns.

### RAG context window for citations is capped at 18 papers
`getRelevantRefs(query, 18)` — increasing this increases the token cost per query. The papers are scored by keyword overlap + region-name boost, so the most relevant 18 are usually good. Consider increasing to 25 as the corpus grows and relevance scoring matures.

### Coordinate sign conventions are NOT normalized
Papers use different conventions: some treat posterior-to-bregma as negative AP, others as positive. The LLM prompt includes a disclaimer to verify sign conventions. This is intentional — do not attempt to normalize signs automatically without knowing each paper's atlas (Franklin & Paxinos vs. Paxinos & Franklin vs. Allen CCFv3).

---

## 7. Files Reference

```
Neuroinjector/
├── .env                                  ← NCBI_API_KEY (gitignored)
├── scripts/
│   ├── build-injection-db.js             ← Full 13-region PubMed sweep → OVERWRITES stereotaxic-protocols.json
│   ├── fetch-targeted-fulltext.js        ← Single-region upsert, SAFE
│   ├── eutils-manual-search.js           ← PMID discovery for one query → JSON hit list
│   ├── extract-injection-data.js         ← Offline regex → injection-coordinates.json
│   ├── ingest-protocols.js               ← 78-region abstract-level sweep → surgical-protocols.json
│   ├── extract-coordinates.js            ← DEPRECATED (older version of extract-injection-data.js)
│   ├── publish-assistant.js              ← Copies dist/ → assistant/
│   └── sync-syringe-data.js              ← Copies shared data files into react-app/public/
├── react-app/
│   ├── src/
│   │   ├── App.jsx                       ← Main assistant UI + RAG logic
│   │   └── components/
│   │       └── AllenAtlasViewer.jsx      ← CCFv3 atlas navigator
│   └── public/
│       ├── data/
│       │   ├── stereotaxic-protocols.json   ← 713 records (full methods)
│       │   ├── surgical-protocols.json      ← Abstract-level corpus
│       │   ├── injection-coordinates.json   ← Extracted index (regenerate after any corpus change)
│       │   └── hamilton-syringes.json       ← Syringe compatibility table
│       └── atlas/
│           ├── ccfv3_manifest.json          ← Slice index (AP mm → PNG filename)
│           ├── ccfv3_structures.json        ← CCF structure list with centroids
│           └── *.png                        ← 50µm coronal slice images
└── documentation/
    └── corpus-improvement-plan.md          ← This file
```

---

## 8. Suggested Next Steps (Ordered by Impact)

1. **Fix the depth-phrasing gap** in `extract-injection-data.js` (Section 4a) — immediate improvement to DV coverage.
2. **Add `reference_point` field** to coordinate records (Section 4b) — prevents sign confusion in the LLM answer.
3. **Add volume_nl and titer fields** to injectate records (Section 4e) — makes protocol planning answers far more specific.
4. **Run targeted sweeps for top-5 data-poor regions** (Section 5, Priority 2) — each sweep takes ~10 minutes.
5. **Focus queries on OA-only papers** by adding `AND "pmc"[sb]` to eutils queries — doubles the full-text hit rate.
6. **Add list-format coordinate pattern** (Section 4d) — likely captures many missed tabular coordinate presentations.
7. **Implement nearest-CCF-centroid lookup** (Section 5, Priority 5) — higher-quality atlas cross-referencing.
8. **Add volume/titer to RAG prompt** — update `buildSystemPrompt()` in `App.jsx` to surface `volume_nl` and `titer` in the citation pool text.
