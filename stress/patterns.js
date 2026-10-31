'use strict';
/* stress/patterns.js — runs every query in patterns.sql against a database copy and prints the tables.
   node stress/patterns.js <copy.sqlite> [--json out.json]   (opened read-only) */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) { console.error('node stress/patterns.js <copy.sqlite>'); process.exit(1); }
const d = new DatabaseSync(file, { readOnly: true });
const sql = fs.readFileSync(path.join(__dirname, 'patterns.sql'), 'utf8');
const out = {};
for (const block of sql.split(/^-- @/m).slice(1)) {
  const name = block.split(/[:\s]/)[0];
  const query = block.split('\n').slice(1).filter((l) => !l.trim().startsWith('--')).join('\n').trim();
  try { out[name] = d.prepare(query).all(); } catch (e) { out[name] = { error: e.message }; }
  console.log('\n## ' + name); console.table(out[name]);
}
const j = process.argv.indexOf('--json');
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 2));
