/**
 * fetch-targeted-fulltext.js
 *
 * Targeted, single-region full-text fetch — companion to build-injection-db.js's
 * broad 13-region sweep, but for growing coverage of ONE region/query without
 * re-running (and overwriting) the entire pipeline.
 *
 * Resolves PMIDs -> Open Access PMCIDs -> PMC JATS XML -> methods section ->
 * condensed excerpt, then MERGES (upsert by PMID) into
 * react-app/public/data/stereotaxic-protocols.json instead of overwriting it.
 *
 * Usage:
 *   node scripts/fetch-targeted-fulltext.js "<region label>" <pmidSourceFile.json>
 *   node scripts/fetch-targeted-fulltext.js "<region label>" 123456,789012,345678
 *
 * API key: reads NCBI_API_KEY from repo-root .env (see eutils-manual-search.js), or
 * from the NCBI_API_KEY environment variable.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_PATH = path.join(__dirname, '../react-app/public/data/stereotaxic-protocols.json');
const IDCONV_BATCH = 200;
const MAX_METHODS_CHARS = 4000;

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

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return JSON.parse(body);
}

async function fetchXml(url) {
  const { status, body } = await httpGet(url);
  if (status !== 200 || !body) return null;
  return body;
}

const SURGICAL_SIGNALS = [
  /bregma/i, /lambda/i, /\bap\b/i, /\bml\b/i, /\bdv\b/i,
  /[-+]?\d+\.\d+\s*mm/i, /coordinates/i, /stereotax\w*/i, /flat\s*skull/i,
  /inject\w*/i, /infus\w*/i, /flow\s*rate/i,
  /\d+\s*nl\b/i, /\d+\s*nl\/min/i, /\d+(\.\d+)?\s*\u03bcl/i, /\d+(\.\d+)?\s*ul/i,
  /hamilton/i, /capillary/i, /needle/i, /gauge|g\b/i,
  /wait\w*/i, /diffus\w*/i, /\d+\s*min/i
];

function extractMethodsSection(xml) {
  if (!xml) return '';
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const chunks = [];
  const titlePatterns = ['method', 'procedure', 'surgery', 'stereotaxic', 'injection', 'animal', 'material'];

  let pos = 0;
  while (pos < doc.length) {
    const secStart = doc.indexOf('<sec', pos);
    if (secStart === -1) break;
    const tagEnd = doc.indexOf('>', secStart);
    if (tagEnd === -1) break;

    const titleSearch = doc.slice(tagEnd + 1, tagEnd + 300);
    const titleMatch = titleSearch.match(/<title>([\s\S]*?)<\/title>/);

    if (titleMatch) {
      const titleText = titleMatch[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
      const isMatch = titlePatterns.some((p) => titleText.includes(p));

      if (isMatch) {
        let depth = 1, scanPos = tagEnd + 1;
        while (depth > 0 && scanPos < doc.length) {
          const nextOpen = doc.indexOf('<sec', scanPos);
          const nextClose = doc.indexOf('</sec>', scanPos);
          if (nextClose === -1) break;
          if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            scanPos = nextOpen + 4;
          } else {
            depth--;
            if (depth === 0) {
              chunks.push(doc.slice(secStart, nextClose + 6));
              pos = nextClose + 6;
              break;
            }
            scanPos = nextClose + 6;
          }
        }
        if (depth > 0) break;
        continue;
      }
    }
    pos = tagEnd + 1;
  }

  return chunks.join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, ' ').replace(/&#x[0-9a-fA-F]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function scoreSentence(sentence) {
  let score = 0;
  for (const pattern of SURGICAL_SIGNALS) {
    if (pattern.test(sentence)) score += 1.0;
  }
  if (/\d/.test(sentence)) score += 0.5;
  return score;
}

function condenseMethods(text, maxChars = MAX_METHODS_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const sentences = text
    .replace(/(?<!\b(e\.g|i\.e|fig|ref|vs|dr|prof))\.\s+(?=[A-Z])/gi, '.\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const scored = sentences.map((sentence, idx) => ({ sentence, idx, score: scoreSentence(sentence) }));
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const selected = new Set();
  let used = 0;

  for (const item of sorted) {
    if (used + item.sentence.length + 1 > maxChars) continue;
    selected.add(item.idx);
    used += item.sentence.length + 1;
    if (used >= maxChars * 0.95) break;
  }

  return scored.filter((item) => selected.has(item.idx)).map((item) => item.sentence).join(' ');
}

async function pmidsToPmcids(pmids, apiParam, delayMs) {
  const map = new Map();
  for (let i = 0; i < pmids.length; i += IDCONV_BATCH) {
    const batch = pmids.slice(i, i + IDCONV_BATCH);
    const url = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${batch.join(',')}&format=json&tool=neuroinjector${apiParam}`;
    try {
      const res = await fetchJson(url);
      if (res && Array.isArray(res.records)) {
        res.records.forEach((rec) => {
          if (rec.pmid && rec.pmcid && !rec.errmsg) {
            map.set(String(rec.pmid), String(rec.pmcid).replace(/^PMC/i, ''));
          }
        });
      }
    } catch (e) {
      console.log(`  ID Converter batch failed: ${e.message}`);
    }
    await delay(delayMs);
  }
  return map;
}

function loadPmids(source) {
  if (fs.existsSync(source)) {
    const data = JSON.parse(fs.readFileSync(source, 'utf8'));
    return data.map((r) => String(r.pmid)).filter(Boolean);
  }
  return source.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const region = process.argv[2];
  const pmidSource = process.argv[3];
  if (!region || !pmidSource) {
    console.error('Usage: node scripts/fetch-targeted-fulltext.js "<region label>" <pmidSourceFile.json | comma,separated,pmids>');
    process.exit(1);
  }

  const pmids = loadPmids(pmidSource);
  if (!pmids.length) {
    console.log('No PMIDs to process. Exiting.');
    return;
  }

  const apiKey = process.env.NCBI_API_KEY || '';
  const hasKey = apiKey.length > 0;
  const apiParam = hasKey ? `&api_key=${apiKey}` : '';
  const delayMs = hasKey ? 110 : 370;

  console.log(`Region label: ${region}`);
  console.log(`PMIDs to process: ${pmids.length}`);
  console.log(`API key: ${hasKey ? 'present (fast mode)' : 'none (slow mode)'}\n`);

  console.log('Resolving Open Access PMCIDs...');
  const pmidToPmcid = await pmidsToPmcids(pmids, apiParam, delayMs);
  console.log(`Open Access PMC papers found: ${pmidToPmcid.size}/${pmids.length}\n`);

  const fetched = [];
  let processed = 0;
  for (const [pmid, pmcid] of pmidToPmcid.entries()) {
    processed++;
    process.stdout.write(`  [${processed}/${pmidToPmcid.size}] PMID:${pmid} (PMC${pmcid})... `);
    const xmlUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&retmode=xml${apiParam}`;
    try {
      const xml = await fetchXml(xmlUrl);
      const rawMethods = extractMethodsSection(xml);
      const condensed = condenseMethods(rawMethods);
      if (condensed && condensed.length > 150) {
        fetched.push({ pmid, pmcid, regions: [region], methods: condensed });
        console.log(`OK (${condensed.length} chars)`);
      } else {
        console.log('Skipped (no stereotaxic methods found)');
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }
    await delay(delayMs);
  }

  // Merge (upsert by PMID) into the existing corpus rather than overwriting it.
  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : [];
  const byPmid = new Map(existing.map((p) => [String(p.pmid), p]));
  let added = 0, updated = 0;

  for (const rec of fetched) {
    const key = String(rec.pmid);
    if (byPmid.has(key)) {
      const cur = byPmid.get(key);
      if (!cur.regions.includes(region)) cur.regions.push(region);
      if (!cur.methods || rec.methods.length > cur.methods.length) cur.methods = rec.methods;
      updated++;
    } else {
      byPmid.set(key, rec);
      added++;
    }
  }

  const merged = Array.from(byPmid.values());
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));

  console.log(`\n==================================================`);
  console.log(`New papers added:   ${added}`);
  console.log(`Existing merged:    ${updated}`);
  console.log(`Total corpus size:  ${merged.length}`);
  console.log(`Saved to ${OUT_PATH}`);
  console.log(`==================================================`);
  console.log('\nNext: node scripts/extract-injection-data.js  (regenerate coordinate/injectate index)');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
