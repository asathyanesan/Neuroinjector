'use strict';
// ============================================================================
// coord-from-issue.js
// ============================================================================
// GitHub Actions intake: turns an "Add Injection Coordinates" issue into a
// staged change on injection-structured.json, then the workflow opens a PR.
//
// TWO INPUT PATHS (auto-detected from the issue body):
//   1. TSV table pasted from Excel  -> deterministic parser (NO LLM, no quota)
//   2. Free-text Methods paragraph  -> FlyerGPT single-paper extraction
//
// ONE PMID per issue (from the template's PMID field), applied to all rows.
//
// Env provided by the workflow:
//   WORKER_URL  (secret)  — FlyerGPT worker base URL (for the Methods path)
//   ISSUE_BODY            — the raw issue body markdown
//   ISSUE_NUM             — issue number (for messages)
//   GITHUB_OUTPUT         — Actions output file (set ok / pmid for the PR step)
//
// Output:
//   react-app/public/data/injection-structured.json  (canonical sorted write)
//   pr_body.md                                        (review table for the PR)
// ============================================================================

const fs    = require('fs');
const https = require('https');

const WORKER = process.env.WORKER_URL || '';
const BODY   = process.env.ISSUE_BODY || '';
const OUT    = 'react-app/public/data/injection-structured.json';
const MODEL  = 'gpt-5.4';

// ---------------------------------------------------------------- helpers ----
function set(name, val) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${val}\n`);
}
function fail(msg) {
  fs.writeFileSync('pr_body.md', '❌ ' + msg);
  set('ok', 'false');
  console.error(msg);
}

// Pull a field's value out of the GitHub issue-form markdown ("### Label\n\nvalue")
function field(label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?:\\n###|$)`, 'i');
  const m = BODY.match(re);
  const v = m ? m[1].trim() : '';
  return v === '_No response_' ? '' : v;
}

// number, range string ("2.61_2.63" / "-2.21_-2.46"), or null
function normVal(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\u2212/g, '-').trim();
  if (!s || /^na$/i.test(s) || s === '—') return null;
  // strip trailing parenthetical annotations for the numeric field (kept elsewhere)
  const annot = [];
  s = s.replace(/\(([^)]*)\)/g, (_, a) => { annot.push(a.trim()); return ''; }).trim();
  // underscore = range separator
  if (s.includes('_')) {
    const parts = s.split('_').map(p => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts.every(p => /^-?\d+\.?\d*$/.test(p))) {
      return { value: `${parts[0]} to ${parts[1]}`, annot };
    }
  }
  if (/^-?\d+\.?\d*$/.test(s)) return { value: parseFloat(s), annot };
  // not a clean number — keep verbatim (e.g. odd volume text)
  return { value: s || null, annot };
}

// ------------------------------------------------------- TSV bulk parser ----
function parseTsv(tsv, pmid) {
  const rows = tsv.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (rows.length < 2) throw new Error('need a header row plus at least one data row');
  if (!rows[0].includes('\t'))
    throw new Error('input is not TAB-separated — copy the rows directly from Excel, do not retype');

  const header = rows[0].split('\t').map(h => h.trim());
  const H = header.map(h => h.toLowerCase());

  const findCol = (...keys) => H.findIndex(h => keys.some(k => h.includes(k)));
  const ci = {
    site:    findCol('injection site', 'site', 'region'),
    ap:      findCol('ap'),
    ml:      findCol('ml'),
    dv:      findCol('dv'),
    angle:   findCol('angle'),
    vol:     findCol('volume', 'vol'),
    tracer:  findCol('tracer', 'injectate', 'virus'),
  };
  if (ci.ap < 0 || ci.ml < 0 || ci.dv < 0)
    throw new Error(`could not find AP/ML/DV columns. Header seen: ${header.join(' | ')}`);

  // reference from the AP header, e.g. "AP (lambda)"
  const apHeader = header[ci.ap].toLowerCase();
  const reference = apHeader.includes('lambda') ? 'lambda'
                  : apHeader.includes('bregma') ? 'bregma'
                  : 'bregma';
  const refFlagged = !/lambda|bregma/.test(apHeader);

  const records = [];
  const review  = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].split('\t').map(c => c.trim());
    if (!cells.some(Boolean)) continue;

    const site   = ci.site   >= 0 ? cells[ci.site]   : '';
    const tracer = ci.tracer >= 0 ? cells[ci.tracer] : '';
    const angleR = ci.angle  >= 0 ? cells[ci.angle]  : '';
    const volR   = ci.vol    >= 0 ? cells[ci.vol]    : '';

    const ap = normVal(cells[ci.ap]);
    const ml = normVal(cells[ci.ml]);
    const dv = normVal(cells[ci.dv]);

    const annots = [...new Set([...(ap?.annot || []), ...(ml?.annot || []), ...(dv?.annot || [])])];
    const angle_deg = angleR && /^-?\d+\.?\d*$/.test(angleR) ? parseFloat(angleR) : (angleR || null);

    // volume kept VERBATIM (may be "20 for AAV, 100 for BDA")
    const volume_nl = volR ? volR.replace(/_/g, '-') : null;

    // flags
    const flags = [];
    const apv = ap?.value, mlv = ml?.value, dvv = dv?.value;
    if (apv == null && mlv == null && dvv == null) flags.push('no-coordinate (na)');
    if (typeof apv === 'number' && (apv < -8.5 || apv > 5.5)) flags.push(`AP ${apv} out of mouse range`);
    if (annots.length) flags.push(annots.join('/') + ' noted');
    // region: keep verbatim; flag if not a clean short CCF-style acronym
    const cleanAcr = /^[A-Z][A-Za-z0-9/]{0,6}$/.test(site.replace(/\s*\(.*\)\s*/, '').trim());
    const ccf = site.replace(/\s*\(.*\)\s*/, '').trim();
    if (!cleanAcr) flags.push('region-needs-ccf-review');

    const sq = `Supplementary table (${reference}-referenced): ${site || 'region'}`
      + ` | AP ${cells[ci.ap] || '—'} | ML ${cells[ci.ml] || '—'} | DV ${cells[ci.dv] || '—'}`
      + (angle_deg != null ? ` | angle ${angle_deg}°` : '')
      + (tracer ? ` | injectate: ${tracer}` : '')
      + (volume_nl ? ` | volume ${volume_nl}` : '')
      + (annots.length ? ` | note: ${annots.join(', ')}` : '');

    records.push({
      region_verbatim: site || null,
      ccf_region: ccf || null,
      ap_mm: apv, ml_mm: mlv, dv_mm: dvv,
      reference,
      angle_deg,
      injectate: tracer || null,
      volume_nl,
      rate_nl_min: null,
      source_quote: sq,
      added_via: 'csv',
    });

    review.push(`| ${site || '?'} | ${fmt(apv)} | ${fmt(mlv)} | ${fmt(dvv)} | ${reference} | `
      + `${angle_deg ?? '—'} | ${volume_nl || '—'} | ${tracer || '—'} | ${flags.join('; ') || 'ok'} |`);
  }

  let md = `## Bulk coordinate import — PMID ${pmid}\n\n`;
  md += `Parsed **${records.length}** coordinate rows from the pasted table `;
  md += `(reference: **${reference}**${refFlagged ? ' ⚠ not stated in header — defaulted, verify' : ''}). `;
  md += `**Merge to approve, Close to deny.**\n\n`;
  md += `| Region | AP | ML | DV | Ref | Angle | Volume | Injectate | ⚠ Flags |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;
  md += review.join('\n');
  md += `\n\nAll rows share PMID ${pmid}. Ranges preserved verbatim; volume kept as-stated; `;
  md += `(contra)/(angled) annotations noted in source_quote; regions kept verbatim `;
  md += `(⚠ region-needs-ccf-review = lab abbreviation, map by hand if desired).`;
  return { records, reviewMd: md };
}

function fmt(v) { return v == null ? '—' : String(v); }

// -------------------------------------------------- FlyerGPT (text path) ----
const SYSTEM = `You extract stereotaxic injection parameters from neuroscience methods text. Return ONLY valid JSON, no prose, no markdown. Schema:
{"targets":[{"region_verbatim":"","ccf_region":"","ap_mm":null,"ml_mm":null,"dv_mm":null,"reference":"","volume_nl":null,"rate_nl_min":null,"source_quote":""}]}
RULES:
- Scan ALL text; assemble the COMPLETE AP+ML+DV set per target even across sentences or reversed order. Coordinates may be VALUE-FIRST ("2.8 mm posterior","1.4 mm lateral"): posterior/caudal=negative ap_mm; anterior/rostral=positive; lateral=ml_mm; ventral/deep/below-surface=dv_mm. "2.8 mm posterior ... 1.4 mm lateral to lambda"=> ap_mm -2.8, ml_mm 1.4, reference "lambda". Also handle "AP: -2.8", "ML 1.4", "DV -2.0". Do NOT leave an axis null if its value appears anywhere in the text.
- "midline"=> ml_mm 0. "X mm below pial/dura/skull"=> dv_mm + reference; else reference "bregma"/"lambda" as stated.
- dv_mm depth; um->mm (500um=0.5); multiple depths at one site => range "0.1 to 0.5".
- VOLUME/RATE in nL: ul->nl x1000; ml->nl x1e6; nl as-is. Real injection never <1 nL.
- NEVER convert AP/ML/DV coordinates; mm as-is. ML=mediolateral not milliliters.
- MULTI-SITE: separate target per site. BILATERAL/±X: two targets ml +X and -X sharing AP/DV.
- "simplex" in "herpes simplex virus"/"HSV" is the VIRUS not the lobule; landmark-only mentions are not targets. ccf_region: "simple lobule"/"lobule simplex"=> SIM.
- Every number must appear verbatim in source_quote. Absent=null. Never guess.`;

function callLLM(text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      max_completion_tokens: 1500, stream: false,
    });
    const u = new URL(`${WORKER}/openai/deployments/${MODEL}/chat/completions?api-version=2024-10-21`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          let c = JSON.parse(d).choices[0].message.content
            .replace(/```json/g, '').replace(/```/g, '').trim();
          resolve(JSON.parse(c).targets || []);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload); req.end();
  });
}

// verify each numeric value appears in its own source_quote; flag implausible
function llmReviewTable(pmid, targets) {
  let anyFlag = false;
  const rows = targets.map((t) => {
    const q = (t.source_quote || '').replace(/\u2212/g, '-');
    const flags = [];
    for (const f of ['ap_mm', 'ml_mm', 'dv_mm', 'volume_nl', 'rate_nl_min']) {
      const v = t[f]; if (v == null) continue;
      const nums = String(v).match(/-?\d+\.?\d*/g) || [];
      if (nums.some(n => !q.includes(n))) flags.push(`${f} not in quote`);
      if (f === 'volume_nl' && typeof v === 'number' && v > 0 && v < 1) flags.push('volume <1 nL (uL not converted?)');
      if (f === 'rate_nl_min' && typeof v === 'number' && v > 0 && v < 0.1) flags.push('rate <0.1 (uL/min?)');
    }
    if (flags.length) anyFlag = true;
    return `| ${t.ccf_region || t.region_verbatim || '?'} | ${fmt(t.ap_mm)} | ${fmt(t.ml_mm)} | ${fmt(t.dv_mm)} | `
      + `${t.reference || '—'} | ${fmt(t.volume_nl)} | ${fmt(t.rate_nl_min)} | ${flags.join('; ') || 'ok'} |`;
  });

  let md = `## Extracted coordinates — PMID ${pmid}\n\n`;
  md += `FlyerGPT parsed **${targets.length}** target(s) from the pasted methods text. `;
  md += `**Merge to approve, Close to deny.**\n\n`;
  md += `| Region | AP | ML | DV | Ref | Volume nL | Rate nL/min | ⚠ Flags |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  md += rows.join('\n');
  md += `\n\n**Source quotes:**\n` + targets.map((t, i) => `${i + 1}. "${t.source_quote || ''}"`).join('\n');
  if (anyFlag) md += `\n\n⚠️ Some values were not found verbatim in their source quote or look implausible — verify before merging.`;
  return md;
}

// ------------------------------------------------------------------ main ----
(async () => {
  const pmid = (field('PMID').match(/\d{5,9}/) || [''])[0];
  const tsv  = field('TSV table \\(paste from Excel — optional\\)');
  const methods = field('Methods / coordinate text');

  if (!pmid) { fail('No valid PMID found in the issue.'); return; }

  let targets, reviewMd, via;

  if (tsv && tsv.includes('\t')) {
    // ── TSV BULK PATH — deterministic, no LLM ──
    try {
      const out = parseTsv(tsv, pmid);
      targets = out.records; reviewMd = out.reviewMd; via = 'csv';
    } catch (e) {
      fail(`TSV parse failed: ${e.message}\n\nCopy the rows directly from Excel (tab-separated) and include a header row.`);
      return;
    }
    if (!targets.length) { fail('TSV parsed but produced no coordinate rows.'); return; }
  } else if (methods) {
    // ── SINGLE-PAPER FLYERGPT PATH ──
    if (!WORKER) { fail('WORKER_URL secret not configured — cannot run the text extraction path.'); return; }
    targets = await callLLM(methods);
    if (!targets || !targets.length) {
      fail(`FlyerGPT returned no coordinates for PMID ${pmid}. Check the pasted text contains AP/ML/DV values, or the worker quota.`);
      return;
    }
    reviewMd = llmReviewTable(pmid, targets); via = 'llm';
  } else {
    fail('No input found — paste either a TSV table (from Excel) or the Methods text.');
    return;
  }

  // ── shared: canonical sorted write + PR body ──
  let db = {};
  try { db = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { db = {}; }
  const existed = Object.prototype.hasOwnProperty.call(db, pmid);
  db[pmid] = { pmid, targets, ok: true, added_via: via };

  const sorted = {};
  for (const k of Object.keys(db).sort()) sorted[k] = db[k];
  fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');

  if (existed) reviewMd += `\n\n⚠️ **PMID ${pmid} already existed and was OVERWRITTEN** — confirm this is intended before merging.`;
  reviewMd += `\n\n_Closes the intake issue on merge._`;
  fs.writeFileSync('pr_body.md', reviewMd);

  set('ok', 'true'); set('pmid', pmid);
  console.log(`OK — PMID ${pmid}, ${targets.length} target(s), via ${via}`);
})();
