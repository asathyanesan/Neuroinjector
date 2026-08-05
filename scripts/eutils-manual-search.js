/**
 * eutils-manual-search.js
 *
 * Standalone, manual-run NCBI E-utilities search helper.
 * Not wired into any build step — run it yourself from the command line.
 *
 * Usage:
 *   node scripts/eutils-manual-search.js "<pubmed query>" [outFile.json]
 *
 * API key resolution order:
 *   1. NCBI_API_KEY environment variable
 *   2. --key=XXXX CLI flag
 *
 * Examples:
 *   set NCBI_API_KEY=abcdef123456 (Windows cmd)
 *   $env:NCBI_API_KEY="abcdef123456"  (PowerShell)
 *   node scripts/eutils-manual-search.js "(\"cerebellar cortex\"[Title/Abstract]) AND (stereotaxic[Title/Abstract] OR stereotactic[Title/Abstract]) AND (mouse OR rat)" cerebellum-hits.json
 *
 *   node scripts/eutils-manual-search.js "\"basolateral amygdala\" AND AAV AND stereotaxic" --key=abcdef123456
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Loads KEY=VALUE lines from a repo-root .env into process.env (skips keys already set).
// Kept dependency-free instead of pulling in dotenv. Never prints values.
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

function parseArgs(argv) {
  const args = argv.slice(2);
  let apiKey = '';
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--key=')) {
      apiKey = a.slice('--key='.length);
    } else {
      positional.push(a);
    }
  }
  return { query: positional[0], outFile: positional[1], apiKey };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchJson(url) {
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  return JSON.parse(body);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { query, outFile, apiKey: cliKey } = parseArgs(process.argv);

  if (!query) {
    console.error('Usage: node scripts/eutils-manual-search.js "<pubmed query>" [outFile.json] [--key=YOUR_API_KEY]');
    process.exit(1);
  }

  const apiKey = process.env.NCBI_API_KEY || cliKey || '';
  const hasKey = apiKey.length > 0;
  const apiParam = hasKey ? `&api_key=${apiKey}` : '';
  const delayMs = hasKey ? 110 : 370; // NCBI limits: 10 req/s with key, 3 req/s without

  console.log(`Query: ${query}`);
  console.log(`API key: ${hasKey ? 'present (fast mode, 10 req/s)' : 'none (slow mode, 3 req/s)'}\n`);

  // 1. esearch -> list of PMIDs
  const searchUrl = `${ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(query)}&retmax=200&retmode=json${apiParam}`;
  const searchRes = await fetchJson(searchUrl);
  const pmids = searchRes.esearchresult?.idlist || [];
  const count = searchRes.esearchresult?.count || '0';

  console.log(`Total hits reported by PubMed: ${count}`);
  console.log(`PMIDs returned (retmax=200): ${pmids.length}\n`);

  if (!pmids.length) {
    console.log('No results. Exiting.');
    return;
  }

  await delay(delayMs);

  // 2. esummary -> title/journal/year per PMID (lightweight, no full text)
  const summaryUrl = `${ESUMMARY_URL}?db=pubmed&id=${pmids.join(',')}&retmode=json${apiParam}`;
  const summaryRes = await fetchJson(summaryUrl);

  const results = pmids.map((pmid) => {
    const rec = summaryRes.result?.[pmid] || {};
    return {
      pmid,
      title: rec.title || '',
      journal: rec.fulljournalname || rec.source || '',
      pubdate: rec.pubdate || '',
      authors: (rec.authors || []).map((a) => a.name).join(', ')
    };
  });

  console.log('--- Results ---');
  results.forEach((r) => {
    console.log(`[PMID:${r.pmid}] ${r.title} (${r.pubdate}, ${r.journal})`);
  });

  if (outFile) {
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nSaved ${results.length} records to ${outPath}`);
  }

  // Never print apiParam/apiKey verbatim — redact so the key can't leak into terminal scrollback or logs.
  console.log('\nTo fetch full abstract text for these PMIDs, use efetch, e.g.:');
  console.log(`  ${EFETCH_URL}?db=pubmed&id=${pmids.slice(0, 3).join(',')}&rettype=abstract&retmode=text${hasKey ? '&api_key=YOUR_API_KEY' : ''}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
