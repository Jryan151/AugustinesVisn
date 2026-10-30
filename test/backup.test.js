'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('the daily backup is a readable copy, made once a day, and only 14 are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-backup-'));
  process.env.DB_FILE = path.join(dir, 'booking.sqlite');
  const db = require('../src/db');
  const jobs = require('../src/jobs');
  db.init(process.env.DB_FILE);
  const out = path.join(dir, 'backups');
  for (let i = 0; i < 16; i++) jobs.backup(new Date(Date.UTC(2026, 10, 1 + i, 12)), out, 14);
  assert.equal(jobs.backup(new Date(Date.UTC(2026, 10, 16, 18)), out, 14), null, 'not twice on one day');
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 14);
  assert.equal(files[0], 'booking-2026-11-03.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(out, files[13]));
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM packages').get().n, 3);
  copy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
