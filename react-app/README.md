# Neuroinjector Assistant (react-app)

An experimental AI chat assistant for the UD Neuroinjector project, modeled after
[ds-research-tool-test](https://github.com/asathyanesan/ds-research-tool-test). It helps with:

1. **Hardware/firmware troubleshooting** and Hamilton syringe compatibility questions,
   grounded in [`public/data/hardware-kb.json`](public/data/hardware-kb.json) and the
   syringe database also used by the [Syringe Configurator](/webapp).
2. **Rodent stereotaxic microinjection procedure design/troubleshooting**, grounded in two
   literature corpora produced by [`scripts/build-injection-db.js`](/scripts/build-injection-db.js)
   (full-text PMC methods sections) and [`scripts/ingest-protocols.js`](/scripts/ingest-protocols.js)
   (abstract-level, organized by 86 brain regions).

There is **no vector database or embeddings** — relevance ranking is a simple client-side
keyword-overlap score (same trick the reference project uses), which keeps the whole app
static and cheap to host.

## Setup

```
cd react-app
npm install
cp .env.example .env   # then set VITE_WORKER_URL to your existing worker's URL
npm run dev
```

To publish: `npm run deploy` builds the app and copies `dist/` into the repo-root
`assistant/` folder — commit that folder to publish via GitHub Pages.

`npm run dev` / `npm run build` first run `scripts/sync-syringe-data.js` (via
`predev`/`prebuild`) to copy `webapp/data/hamilton_syringes.json` and
`public/data/surgical-protocols.json` into `react-app/public/data/`, so this app never
maintains its own hand-edited copies of those datasets.

## Requires a Cloudflare Worker (reusing the ds-research-tool-test worker)

The app calls `${VITE_WORKER_URL}/openai/deployments/<model>/chat/completions` and expects
an SSE streaming response, matching the Azure OpenAI/FlyerGPT chat completions API shape.

This project reuses the **same deployed Cloudflare Worker** as
[ds-research-tool-test](https://github.com/asathyanesan/ds-research-tool-test) rather than
standing up new infrastructure. Its `ALLOWED_ORIGINS` already includes
`https://asathyanesan.github.io` — since CORS only checks scheme+host (not path), this app
(hosted at `.../Neuroinjector-OSE/assistant/`) is already covered with **no changes needed on the
worker side**. Just set `VITE_WORKER_URL` in `.env` to that worker's `https://*.workers.dev` URL.

## Known limitations / follow-ups

- Both literature JSON files are fetched in full on load (~9 MB combined). Fine for local/
  low-traffic use; consider trimming or paginating before wide deployment.
- Deployed via `npm run deploy`, which builds and copies `dist/` into the repo-root
  `assistant/` folder (same "deploy from branch" mechanism GitHub Pages already uses to serve
  `webapp/`). Commit `assistant/` after running it to publish.
- Model deployment names (`gpt-5.5` / `gpt-5.4`) assume the same FlyerGPT APIM deployments as
  the reference project; adjust in `src/App.jsx` if yours differ.
