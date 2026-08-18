'use strict';
const fs = require('fs');
const https = require('https');

const WORKER = process.env.WORKER_URL;
const BODY   = process.env.ISSUE_BODY || '';
const OUT    = 'react-app/public/data/injection-structured.json';
const MODEL  = 'gpt-5.4';

// ---- parse the issue form (### headers from the yml) ----
function field(label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?:\\n###|$)`, 'i');
  const m = BODY.match(re);
  return m ? m[1].trim() : '';
}
const pmid    = (field('PMID').match(/\d{5,9}/) || [''])[0];
const methods = field('Methods / coordinate text');
const species = field('Species \\(optional\\)') || null;

const SYSTEM = `You extract stereotaxic injection parameters from neuroscience methods text. Return ONLY valid JSON, no prose. Schema:
{"targets":[{"region_verbatim":"","ccf_region":"","ap_mm":null,"ml_mm":null,"dv_mm":null,"reference":"","volume_nl":null,"rate_nl_min":null,"source_quote":""}]}
RULES:
- "midline" ml_mm=0. "caudal/posterior to bregma"=negative ap_mm. "anterior/rostral"=positive.
- dv_mm is depth; um->mm (500um=0.5). Ranges as "0.1 to 0.5".
- VOLUME/RATE in nL: ul->nl x1000, ml->nl x1e6. Never <1 nL for a real injection.
- Coordinates AS-IS in mm; never convert AP/ML/DV.
- MULTI-SITE: separate target per distinct site. BILATERAL: two targets, ml +X and -X.
- WORD-SENSE: "simplex" in "herpes simplex virus" is the VIRUS not the lobule; skip landmark-only mentions.
- Every number must appear verbatim in source_quote. Absent=null. Never guess.`;

function callLLM(text) {
  return new Promise((res) => {
    const payload = JSON.stringify({
      messages: [{ role:'system', content:SYSTEM }, { role:'user', content:text }],
      max_completion_tokens: 1500, stream: false,
    });
    const u = new URL(`${WORKER}/openai/deployments/${MODEL}/chat/completions?api-version=2024-10-21`);
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) } },
      (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
        try { let c=JSON.parse(d).choices[0].message.content.replace(/```json|```/g,'').trim();
          res(JSON.parse(c).targets||[]); } catch { res(null); } }); });
    req.on('error',()=>res(null)); req.write(payload); req.end();
  });
}

// ---- verify each value appears in its own quote ----
function verify(t) {
  const q = (t.source_quote||'').replace(/\u2212','-'/g,'-');
  const flags = [];
  for (const f of ['ap_mm','ml_mm','dv_mm','volume_nl','rate_nl_min']) {
    const v = t[f]; if (v==null) continue;
    const nums = String(v).match(/-?\d+\.?\d*/g) || [];
    if (nums.some(n => !q.includes(n))) flags.push(`${f}=${v} not in quote`);
    if ((f==='volume_nl'&&typeof v==='number'&&v>0&&v<1)) flags.push(`${f}=${v} implausibly small (uL not converted?)`);
  }
  return flags;
}

function set(name, val){ fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${val}\n`); }

(async () => {
  if (!pmid || !methods) {
    fs.writeFileSync('pr_body.md', '❌ Could not read PMID or methods text from the issue.');
    set('ok','false'); return;
  }
  const targets = await callLLM(methods);
  if (!targets || !targets.length) {
    fs.writeFileSync('pr_body.md', `❌ FlyerGPT returned no coordinates for PMID ${pmid}. Check the pasted text contains AP/ML/DV values, or the worker quota.`);
    set('ok','false'); return;
  }

  // build markdown review table
  let md = `## Extracted coordinates — PMID ${pmid}\n\nReview the values below against the source quotes. **Merge to approve, Close to deny.**\n\n`;
  md += `| Region | AP | ML | DV | Ref | Volume nL | Rate nL/min | ⚠ Flags |\n|---|---|---|---|---|---|---|---|\n`;
  let anyFlag = false;
  for (const t of targets) {
    const flags = verify(t); if (flags.length) anyFlag = true;
    md += `| ${t.ccf_region||t.region_verbatim||'?'} | ${t.ap_mm??'—'} | ${t.ml_mm??'—'} | ${t.dv_mm??'—'} | ${t.reference||'—'} | ${t.volume_nl??'—'} | ${t.rate_nl_min??'—'} | ${flags.join('; ')||'ok'} |\n`;
  }
  md += `\n**Source quotes:**\n` + targets.map((t,i)=>`${i+1}. "${t.source_quote||''}"`).join('\n');
  if (anyFlag) md += `\n\n⚠️ Some values were not found verbatim in their source quote or look implausible — verify carefully before merging.`;
  md += `\n\nCloses the intake issue on merge.`;
  fs.writeFileSync('pr_body.md', md);

  // write into the JSON
  const db = JSON.parse(fs.readFileSync(OUT,'utf8'));
  db[pmid] = { pmid, targets, ok: true, species, added_manually: true };
  fs.writeFileSync(OUT, JSON.stringify(db, null, 2));

  set('ok','true'); set('pmid', pmid);
})();
