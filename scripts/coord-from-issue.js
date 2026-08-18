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

const SYSTEM = `You extract stereotaxic injection parameters from neuroscience methods text. Return ONLY valid JSON, no prose, no markdown. Schema:
{"targets":[{"region_verbatim":"","ccf_region":"","ap_mm":null,"ml_mm":null,"dv_mm":null,"reference":"","volume_nl":null,"rate_nl_min":null,"source_quote":""}]}
RULES:
- A paper OFTEN states AP, ML, DV in SEPARATE sentences or in reversed order. Scan ALL text and assemble the COMPLETE AP+ML+DV set per target. Do NOT stop after one axis, and do NOT leave an axis null if its value appears anywhere in the text.
- COORDINATES MAY BE WRITTEN VALUE-FIRST: "2.8 mm posterior", "1.4 mm lateral", "2.0 mm ventral", "0.35 mm below the surface" all give coordinates. Map them: posterior/caudal => negative ap_mm; anterior/rostral => positive ap_mm; lateral => ml_mm (magnitude, or the stated sign); ventral/deep/below-surface => dv_mm. "2.8 mm posterior ... 1.4 mm lateral to lambda" => ap_mm -2.8, ml_mm 1.4, reference "lambda".
- Also handle axis-first forms ("AP: -2.8", "ML 1.4", "DV -2.0") and coordinate triples in any order.
- "midline" => ml_mm 0. "X mm below pial/dura/skull/surface" => dv_mm, set reference accordingly; otherwise reference is "bregma" or "lambda" as stated in the text.
- dv_mm is injection DEPTH; depths in micrometers (um/µm) convert to mm (500 um => 0.5). If multiple depths at one site (e.g. 500, 380, 250, 100 um) report a range string "0.1 to 0.5".
- VOLUME & RATE in nanoliters: microliter (ul/µl) => x1000 (1 ul = 1000 nl); milliliter => x1e6; nanoliter as-is. A real injection is never < 1 nL — if your value is < 1 you failed to convert a ul value.
- NEVER convert AP/ML/DV coordinates; they are mm as-is. ML means mediolateral, not milliliters.
- MULTI-SITE: distinct sites => separate target objects. BILATERAL ("bilateral", "both hemispheres", "±X"): emit TWO targets, ml_mm +X and -X, sharing AP/DV/reference.
- ccf_region: best Allen CCF name. "simple lobule"/"lobule simplex" => SIM. "simplex" in "herpes simplex virus"/"HSV" is the VIRUS, not a region — do not tag it. A structure named only as a landmark is not an injection target.
- source_quote: the sentence(s) the values came from, verbatim. Every reported number must appear in the text. Absent => null. Never guess.`;

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
