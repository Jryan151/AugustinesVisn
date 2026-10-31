'use strict';
/* =====================================================================
   packagefill.js — suggested details for the photographer's own packages, matched by name (names are never changed).

   Sized for one person shooting on the side: sessions under an hour, a handful of finished photos, prices a friend of
   a friend says yes to. For reference (2026): Snappr's on-demand US rates start at $89 for a first hour (about 3
   edited portraits an hour) and $169 all-inclusive; general guides put amateurs at $25-100 an hour.
   The descriptions only promise what's true every time. The card already shows the length, photo count and
   turnaround beside them, so the description says who it's for and what happens.

   Used by scripts/fill-packages.js (asks before changing the real site) and by the demo (its copy of the packages).
   ===================================================================== */
const FILL = {
  portrait: { summary: 'Just you, at one spot you pick, at sunrise or sunset. Seniors, profile pictures, or just because.', minutes: 30, photos: 10, turnaround_days: 7, price_cents: 7500, deposit_cents: 2500 },
  couples: { summary: 'The two of you, at one spot you pick. Relaxed and mostly candid: walking, talking, a few posed.', minutes: 45, photos: 15, turnaround_days: 7, price_cents: 11000, deposit_cents: 3500 },
  sports: { summary: 'One athlete in uniform or gear, at a spot you pick. Posed shots plus a few in motion.', minutes: 45, photos: 12, turnaround_days: 7, price_cents: 9000, deposit_cents: 3000 },
};
const FIELDS = ['summary', 'minutes', 'photos', 'turnaround_days', 'price_cents', 'deposit_cents'];

/** The suggested details for a package, by its name (any case), or null if there's no suggestion for it. */
const forName = (name) => FILL[String(name || '').trim().toLowerCase()] || null;

module.exports = { FILL, FIELDS, forName };
