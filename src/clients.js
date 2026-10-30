'use strict';
/* =====================================================================
   clients.js — who the clients are, worked out from their bookings.

   A client is everyone who has booked with the same email. Their name and phone are from their latest booking;
   sessions, packages, totals and dates are counted from all of them. Nothing is typed in twice, so the list can't
   drift from the bookings. The one thing kept separately is the photographer's private note on each client.

   Each client also gets a stage, the thing the photographer would want to know at a glance:
     upcoming   a session is coming up
     editing    shot, photos not sent yet
     delivered  their latest photos have been sent
     past       nothing open
   and "repeat" when they've had more than one session.
   ===================================================================== */
const db = require('./db');
const mail = require('./mail');
const { HttpError } = require('./http');

// Bookings that count: paid and not cancelled.
const COUNTED = ['booked', 'prepped', 'shot', 'editing', 'delivered'];

function stageOf(bs, now) {
  if (bs.some((b) => ['booked', 'prepped'].includes(b.status) && new Date(b.end_at) > now)) return 'upcoming';
  if (bs.some((b) => ['booked', 'prepped', 'shot', 'editing'].includes(b.status))) return 'editing';
  const last = bs[bs.length - 1];
  if (last && last.status === 'delivered') return 'delivered';
  return 'past';
}

/** Every client, most recently active first. */
function list(now = new Date()) {
  const marks = COUNTED.map(() => '?').join(',');
  const rows = db.all(`SELECT b.*, p.name AS package_name FROM bookings b JOIN packages p ON p.id = b.package_id
    WHERE b.status IN (${marks}) ORDER BY b.start_at`, COUNTED);
  const notes = new Map(db.all('SELECT email, notes FROM clients').map((r) => [r.email, r.notes]));
  const byEmail = new Map();
  for (const b of rows) {
    const k = b.client_email.toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(b);
  }
  const out = [];
  for (const [email, bs] of byEmail) {
    const latest = bs.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const next = bs.find((b) => ['booked', 'prepped'].includes(b.status) && new Date(b.start_at) > now);
    const pkgs = [...new Set(bs.map((b) => b.package_name))];
    out.push({
      email, name: latest.client_name, phone: latest.client_phone,
      stage: stageOf(bs, now), repeat: bs.length > 1,
      sessions: bs.length, packages: pkgs,
      totalCents: bs.reduce((s, b) => s + b.price_cents, 0),
      firstAt: bs[0].start_at, lastAt: bs[bs.length - 1].start_at, nextAt: next ? next.start_at : null,
      notes: notes.get(email) || '',
      bookings: bs.slice().reverse().map((b) => ({ id: b.id, when: mail.when(b), package: b.package_name, status: b.status, priceCents: b.price_cents, token: b.token })),
      lastActive: bs.reduce((m, b) => (b.updated_at > m ? b.updated_at : m), ''),
    });
  }
  return out.sort((a, b) => (b.lastActive > a.lastActive ? 1 : -1));
}

function saveNotes(email, notes) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !db.get('SELECT 1 FROM bookings WHERE lower(client_email) = ?', [e])) throw new HttpError(404, 'No client with that email.');
  db.run('INSERT INTO clients (email, notes, updated_at) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at',
    [e, String(notes || '').slice(0, 5000), db.nowIso()]);
}

module.exports = { list, saveNotes };
