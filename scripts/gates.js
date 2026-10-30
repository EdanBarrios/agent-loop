#!/usr/bin/env node
// Usage: node scripts/gates.js <gates.json> [--before <wave>]
// Prints the open gate items (all, or those due at or before <wave>) and exits 1 if there are any.
// Exit codes: 0 nothing open, 1 open items, 2 usage or invalid file.
import { readFileSync } from 'node:fs';
import { loadGates, openBefore } from '../claude/lib/gates.js';

const args = process.argv.slice(2);
const file = args[0];
let wave = null;
if (!file || file.startsWith('--')) usage();
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--before' && args[i + 1] !== undefined) wave = args[++i];
  else usage();
}

let gates;
try {
  gates = loadGates(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`gates: ${file}: ${err.message}`);
  process.exit(2);
}

const open = wave === null ? openBefore(gates, '￿') : openBefore(gates, wave);
if (open.length === 0) {
  console.log(wave === null ? 'No open gate items.' : `No open gate items before wave ${wave}.`);
  process.exit(0);
}
console.log(wave === null ? `${open.length} open gate item(s):` : `${open.length} open gate item(s) before wave ${wave}:`);
for (const g of open) {
  console.log(`- ${g.id} [before ${g.before}, ${g.leadTime}] ${g.what}`);
  console.log(`  why: ${g.why}`);
}
process.exit(1);

function usage() {
  console.error('usage: node scripts/gates.js <gates.json> [--before <wave>]');
  process.exit(2);
}
