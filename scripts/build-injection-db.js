/**
 * build-injection-db.js
 * 
 * Searches PubMed across ALL major rodent brain regions for preclinical stereotaxic
 * injection literature, resolves PMCIDs, fetches PMC JATS XML full text, extracts
 * methods sections, and scores sentences based on coordinate & injection signals.
 * 
 * Interactively prompts for NCBI API key if not pre-set in environment.
 * Handles deduplication of multi-region paper hits automatically.
 * 
 * Output: react-app/public/data/stereotaxic-protocols.json
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const IDCONV_BATCH = 200;
const MAX_METHODS_CHARS = 4000;
const OUT_PATH = path.join(__dirname, '../react-app/public/data/stereotaxic-protocols.json');

// Comprehensive Rodent Brain Region Query Blocks
const RODENT_BRAIN_REGIONS = {
  'Prefrontal Cortex': '("prefrontal cortex" OR "mPFC" OR "PFC" OR "anterior cingulate" OR "ACC")',
  'Sensory & Motor Cortex': '("motor cortex" OR "somatosensory cortex" OR "visual cortex" OR "auditory cortex" OR "piriform cortex" OR "entorhinal cortex" OR "insular cortex")',
  'Olfactory Bulb': '("olfactory bulb" OR "MOB")',
  'Hippocampus & Subiculum': '("hippocampus" OR "dentate gyrus" OR "DG" OR "CA1" OR "CA2" OR "CA3" OR "subiculum")',
  'Amygdala & BNST': '("amygdala" OR "basolateral amygdala" OR "BLA" OR "central amygdala" OR "CeA" OR "bed nucleus of the stria terminalis" OR "BNST")',
  'Striatum & NAc': '("striatum" OR "dorsal striatum" OR "caudate putamen" OR "CPu" OR "nucleus accumbens" OR "NAc")',
  'Pallidum & Subthalamus': '("globus pallidus" OR "GPe" OR "GPi" OR "ventral pallidum" OR "subthalamic nucleus" OR "STN")',
  'Thalamus & Habenula': '("thalamus" OR "habenula" OR "LHb" OR "MHb")',
  'Hypothalamus': '("hypothalamus" OR "paraventricular nucleus" OR "PVN" OR "lateral hypothalamus" OR "LH" OR "arcuate nucleus" OR "ARC" OR "ventromedial hypothalamus" OR "VMH" OR "DMH")',
  'Midbrain (VTA & SN)': '("substantia nigra" OR "SNpc" OR "SNr" OR "ventral tegmental area" OR "VTA")',
  'Midbrain (PAG & Colliculi)': '("periaqueductal gray" OR "PAG" OR "superior colliculus" OR "inferior colliculus" OR "interpeduncular nucleus" OR "IPN")',
  'Brainstem & Raphe': '("locus coeruleus" OR "LC" OR "dorsal raphe" OR "DRN" OR "nucleus of the solitary tract" OR "NTS" OR "ventrolateral medulla" OR "VLM")',
  'Cerebellum': '("cerebellum" OR "deep cerebellar nuclei" OR "dentate nucleus" OR "purkinje")'
};

const INJECTION_QUALIFIER = 'AND (stereotaxic[Title/Abstract] OR stereotactic[Title/Abstract] OR microinjection[Title/Abstract] OR Bregma[Title/Abstract]) AND (mouse OR rat OR rodent)';

// Signal Scorer Regex Patterns
const SURGICAL_SIGNALS = [
  // Coordinates & Anatomy
  /bregma/i, /lambda/i, /\bap\b/i, /\bml\b/i, /\bdv\b/i,
  /[-+]?\d+\.\d+\s*mm/i, /coordinates/i, /stereotax\w*/i, /flat\s*skull/i,
  
  // Injection hardware & volumetric parameters
  /inject\w*/i, /infus\w*/i, /flow\s*rate/i,
  /\d+\s*nl\b/i, /\d+\s*nl\/min/i, /\d+(\.\d+)?\s*μl/i, /\d+(\.\d+)?\s*ul/i,
  /hamilton/i, /capillary/i, /needle/i, /gauge|g\b/i,
  /wait\w*/i, /diffus\w*/i, /\d+\s*min/i
];

// ---- CLI Interactive Prompt ----
function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

// ---- HTTP Helpers ----
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
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

// ---- JATS XML Section Extractor ----
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
    const titleMatch  = titleSearch.match(/<title>([\s\S]*?)<\/title>/);

    if (titleMatch) {
      const titleText = titleMatch[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
      const isMatch = titlePatterns.some(p => titleText.includes(p));

      if (isMatch) {
        let depth = 1, scanPos = tagEnd + 1;
        while (depth > 0 && scanPos < doc.length) {
          const nextOpen  = doc.indexOf('<sec', scanPos);
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

// ---- Sentence Condenser ----
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
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const scored = sentences.map((sentence, idx) => ({
    sentence,
    idx,
    score: scoreSentence(sentence)
  }));

  const sorted = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const selected = new Set();
  let used = 0;

  for (const item of sorted) {
    if (used + item.sentence.length + 1 > maxChars) continue;
    selected.add(item.idx);
    used += item.sentence.length + 1;
    if (used >= maxChars * 0.95) break;
  }

  return scored
    .filter(item => selected.has(item.idx))
    .map(item => item.sentence)
    .join(' ');
}

// ---- Batched ID Converter ----
async function pmidsToPmcids(pmids, apiParam, delayMs) {
  const map = new Map();
  const totalBatches = Math.ceil(pmids.length / IDCONV_BATCH);

  for (let i = 0; i < pmids.length; i += IDCONV_BATCH) {
    const batch = pmids.slice(i, i + IDCONV_BATCH);
    const batchNum = Math.floor(i / IDCONV_BATCH) + 1;
    process.stdout.write(`  ID Converter batch ${batchNum}/${totalBatches} (${batch.length} PMIDs)... `);

    const url = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${batch.join(',')}&format=json&tool=neuroinjector${apiParam}`;
    try {
      const res = await fetchJson(url);
      let found = 0;
      if (res && Array.isArray(res.records)) {
        res.records.forEach(rec => {
          if (rec.pmid && rec.pmcid && !rec.errmsg) {
            map.set(String(rec.pmid), String(rec.pmcid).replace(/^PMC/i, ''));
            found++;
          }
        });
      }
      console.log(`Found ${found} Open Access PMC IDs`);
    } catch (e) {
      console.log(`Failed: ${e.message}`);
    }
    await delay(delayMs);
  }
  return map;
}

// ---- Main Pipeline ----
async function main() {
  console.log('\n==================================================');
  console.log('=== Building Stereotaxic Protocols JSON Database ===');
  console.log('==================================================\n');

  // Interactive Prompt for API Key
  let apiKey = process.env.NCBI_API_KEY || '';
  if (!apiKey) {
    apiKey = await promptUser('🔑 Please enter your NCBI API Key (or press Enter to skip): ');
  }

  const hasApiKey = apiKey.length > 0;
  const delayMs = hasApiKey ? 110 : 370; // 10 req/sec with key vs 3 req/sec without
  const apiParam = hasApiKey ? `&api_key=${apiKey}` : '';

  console.log(`\nRate Limit Mode: ${hasApiKey ? 'FAST (10 req/sec with key)' : 'FREE TIER (3 req/sec)'}\n`);

  // Map to store PMID -> Set of matched brain region categories
  const pmidToRegionsMap = new Map();

  // Step 1: Query PubMed across all rodent brain regions
  console.log('Searching PubMed across rodent brain region blocks...\n');
  for (const [regionName, regionQuery] of Object.entries(RODENT_BRAIN_REGIONS)) {
    const fullQuery = `${regionQuery}[Title/Abstract] ${INJECTION_QUALIFIER}`;
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(fullQuery)}&retmax=200&retmode=json${apiParam}`;
    
    try {
      const res = await fetchJson(url);
      const ids = res.esearchresult?.idlist || [];
      
      ids.forEach(id => {
        if (!pmidToRegionsMap.has(id)) {
          pmidToRegionsMap.set(id, new Set());
        }
        pmidToRegionsMap.get(id).add(regionName);
      });

      console.log(`  Region Block [${regionName}] → ${ids.length} hits`);
    } catch (e) {
      console.warn(`  Failed query for [${regionName}]: ${e.message}`);
    }
    await delay(delayMs);
  }

  const pmidList = Array.from(pmidToRegionsMap.keys());
  console.log(`\nTotal unique PMIDs collected across all brain regions: ${pmidList.length}`);

  if (!pmidList.length) {
    console.log('No PMIDs found. Exiting.');
    return;
  }

  // Step 2: Convert PMIDs to PMCIDs in Batches
  console.log('\nResolving PMCIDs for Open Access full text...');
  const pmidToPmcid = await pmidsToPmcids(pmidList, apiParam, delayMs);
  console.log(`Total Open Access PMC papers to fetch: ${pmidToPmcid.size}\n`);

  // Step 3: Fetch XML & Extract Methods (Deduplicated Processing)
  const protocols = [];
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
        protocols.push({
          pmid,
          pmcid,
          regions: Array.from(pmidToRegionsMap.get(pmid) || []),
          methods: condensed
        });
        console.log(`OK (${condensed.length} chars)`);
      } else {
        console.log('Skipped (no stereotaxic methods found)');
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    await delay(delayMs);
  }

  // Ensure output directory exists and save
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(protocols, null, 2));

  console.log(`\n==================================================`);
  console.log(`✅ Success! Saved ${protocols.length} extracted paper protocols to:`);
  console.log(`   ${OUT_PATH}`);
  console.log(`==================================================\n`);
}

main().catch(err => console.error('Fatal Error:', err));