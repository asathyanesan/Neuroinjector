/**
 * Copies data files that live outside react-app/ into react-app/public/data/
 * so the assistant app always reflects a single source of truth instead of
 * maintaining hand-kept duplicates:
 *  - webapp/data/hamilton_syringes.json (Syringe Configurator's own data)
 *  - public/data/surgical-protocols.json (abstract-level, 86-region corpus
 *    produced by scripts/ingest-protocols.js)
 *
 * Usage: node scripts/sync-syringe-data.js
 * Run automatically via react-app's "predev"/"prebuild" npm scripts.
 */
const fs = require('fs');
const path = require('path');

const copies = [
  [path.join(__dirname, '../webapp/data/hamilton_syringes.json'),
    path.join(__dirname, '../react-app/public/data/hamilton-syringes.json')],
  [path.join(__dirname, '../public/data/surgical-protocols.json'),
    path.join(__dirname, '../react-app/public/data/surgical-protocols.json')],
];

for (const [src, dest] of copies) {
  if (!fs.existsSync(src)) {
    console.warn(`Skipped (source missing): ${path.relative(process.cwd(), src)}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`Synced ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`);
}
