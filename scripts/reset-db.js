import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Wipes the JSON database back to empty. Backs the old file up first so an
// accidental `npm run reset` is never data loss.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'db.json');

if (!fs.existsSync(file)) {
  console.log('Nothing to reset — no database exists yet.');
  process.exit(0);
}

const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, JSON.stringify({ version: 1, createdAt: Date.now(), players: {}, feed: [], meta: { totalRolls: 0, biomeIndex: 0, biomeStartedAt: 0, nextPlayerId: 1 } }, null, 2), 'utf8');

console.log(`Database reset.`);
console.log(`Previous data saved to: ${path.relative(path.join(__dirname, '..'), backup)}`);
