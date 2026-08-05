'use strict';
// migrate-drop-legacy.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION — drop pre-two-track "old-format" papers.
//
// CONTEXT
//   The corpus went through two eras:
//     ERA 1 (old): abstract-only sweep. Records have
//                  `surgical_methods_summary` + `raw_abstract_snippet`,
//                  no `methods` / `results` / `figure_legends`.
//                  ~4,372 records, mostly rat, ~1 usable coordinate total.
//     ERA 2 (new): two-track PMC full-text + abstract fallback.
//                  Records have `methods` (or `abstract` for Track B).
//
//   The ERA 1 records now add pure noise: ~3,000 rat papers, inflated
//   unknown-species counts, and slower extraction — for near-zero coordinate
//   yield. This script removes them.
//
// SAFETY
//   • Writes a timestamped backup BEFORE modifying anything.
//   • Prints a full before/after breakdown.
//   • Idempotent: running twice is harmless (nothing left to drop).
//   • Reversible only by re-running ingest-protocols.js for the old queries.
//
// USAGE
//   node migrate-drop-legacy.js            # dry-run: report only, no writes
//   node migrate-drop-legacy.js --apply    # actually drop + save + backup
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const TARGET = path.resolve(
  __dirname,
  '../react-app/public/data/surgical-protocols.json'
);

const APPLY = process.argv.includes('--apply');

// ── A record is "legacy" if it has the old summary field and lacks all
//    of the new-format text fields. This is deliberately strict so we never
//    drop a new-format paper that happens to also carry a legacy field. ──
function isLegacy(p) {
  const hasNewText =
    (p.methods && p.methods.trim()) ||
    (p.results && p.results.trim()) ||
    (p.figure_legends && p.figure_legends.trim()) ||
    (p.abstract && p.abstract.trim());
  const hasOldSummary =
    (p.surgical_methods_summary && p.surgical_methods_summary.trim()) ||
    (p.raw_abstract_snippet && p.raw_abstract_snippet.trim());
  return !hasNewText && !!hasOldSummary;
}

function speciesOf(p) {
  const t = [
    p.methods, p.abstract, p.results, p.figure_legends,
    p.surgical_methods_summary, p.raw_abstract_snippet, p.title,
  ].filter(Boolean).join(' ').toLowerCase();
  const mouse = /\bmouse\b|\bmice\b|c57|bl\/6|bl6/.test(t);
  const rat   = /\brat\b|\brats\b|sprague|wistar|long.evans/.test(t);
  if (mouse && rat) return 'mixed';
  if (mouse) return 'mouse';
  if (rat)   return 'rat';
  return 'unknown';
}

function main() {
  const raw = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  if (!Array.isArray(raw)) {
    console.error('ERROR: expected a flat array in surgical-protocols.json.');
    console.error('This file looks region-keyed — aborting to avoid data loss.');
    process.exit(1);
  }

  const legacy = raw.filter(isLegacy);
  const keep   = raw.filter(p => !isLegacy(p));

  // Species breakdown of what's being dropped (for sanity)
  const dropSpecies = { mouse: 0, rat: 0, mixed: 0, unknown: 0 };
  legacy.forEach(p => { dropSpecies[speciesOf(p)]++; });

  console.log('─'.repeat(60));
  console.log('LEGACY DROP MIGRATION' + (APPLY ? '  [APPLY]' : '  [DRY RUN]'));
  console.log('─'.repeat(60));
  console.log(`Total records now      : ${raw.length}`);
  console.log(`Legacy (to drop)       : ${legacy.length}`);
  console.log(`  ↳ species dropped    : ${JSON.stringify(dropSpecies)}`);
  console.log(`Keep (new-format)      : ${keep.length}`);
  console.log('─'.repeat(60));

  if (!APPLY) {
    console.log('DRY RUN — no files written. Re-run with --apply to commit.');
    return;
  }

  // Backup first
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = TARGET.replace(/\.json$/, `.backup-${stamp}.json`);
  fs.copyFileSync(TARGET, backup);
  console.log(`Backup written : ${backup}`);

  fs.writeFileSync(TARGET, JSON.stringify(keep, null, 2), 'utf8');
  console.log(`Saved ${keep.length} papers → ${TARGET}`);
  console.log('');
  console.log('NEXT: re-run  node extract-injection-data.js  to regenerate');
  console.log('      injection-coordinates.json from the cleaned corpus.');
}

main();
