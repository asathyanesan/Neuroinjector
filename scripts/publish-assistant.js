/**
 * Copies react-app/dist/* into a root-level assistant/ folder so GitHub Pages
 * (deploy-from-branch, same mechanism that already serves webapp/) can serve
 * the built assistant at https://asathyanesan.github.io/Neuroinjector/assistant/.
 *
 * Usage: node scripts/publish-assistant.js
 * Run automatically via react-app's "npm run deploy" (after "npm run build").
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../react-app/dist');
const DEST = path.join(__dirname, '../assistant');

if (!fs.existsSync(SRC)) {
  console.error('react-app/dist not found — run "npm run build" in react-app/ first.');
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });
console.log(`Published ${path.relative(process.cwd(), SRC)} -> ${path.relative(process.cwd(), DEST)}`);
console.log('Commit the assistant/ folder to publish it via GitHub Pages.');
