import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDb } from '../src/db.js';

// Wipes the JSON database back to empty: accounts, sessions, feed, everything.
// Backs the old file up first so an accidental `npm run reset` is never data
// loss. Guests are never on disk, so there is nothing here to clear for them.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'db.json');

if (!fs.existsSync(file)) {
  console.log('Nothing to reset — no database exists yet.');
  process.exit(0);
}

const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, JSON.stringify(emptyDb(), null, 2), 'utf8');

console.log('Database reset — every account has been removed.');
console.log(`Previous data saved to: ${path.relative(path.join(__dirname, '..'), backup)}`);
