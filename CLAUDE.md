# Working on this repo

## The test for any new feature
Does it move a client to the next step, or save the photographer real time? If neither, it doesn't go in.
Flashy is not a reason. Every feature has to fit with the others, not compete with them.

## Design rules
- Two surfaces only: `.glass` where people browse (nav, package cards over the background), `.panel` (solid) where
  people commit (time picker, details, payment, admin). Never glass on a form.
- One dark base, one accent (golden-hour amber, `--accent`), two typefaces (Instrument Serif for display and the name (matches the business card; the name is always upper-case), Space Grotesk for text).
  New colours go in `:root` as tokens.
- Motion only where it has a job: the background fade-in and short (≤ 300 ms) view transitions. No hover lifts, no
  animation libraries. Everything respects `prefers-reduced-motion`. Nothing waits on an animation to accept input.
- Tap targets at least 44 px. Safe-area insets on anything fixed. `tabular-nums` on prices, times and counts.
  `text-wrap: balance` on headings, `pretty` on paragraphs.
- No inline `style=""` or inline scripts: the Content-Security-Policy blocks them. Use classes in `styles.css`.

## Behaviour rules
- Times and prices are always fetched fresh. Only harmless lists (packages) use the cached-then-fresh helper.
- Anything that creates a record or takes money sends an Idempotency-Key and disables its button while it runs.
- No optimistic updates for bookings or payments: wait for the server.
- Reversible admin actions: act at once and show an Undo toast. Anything that emails a client waits `UNDO_MS` in
  the outbox first. Never undo after an email has left.
- Every email goes through `mail.queue` (one per kind per booking). Nothing sends inline.
- Uploads stream to disk (never whole in memory), are checked by their bytes (JPG/PNG/WebP), and the original is
  kept untouched for the client. Pages show the web copies, with width/height so nothing jumps.
- Client photos are private: only reachable through the booking's token, and only once it's delivered.
- Skeletons only where there's nothing cached, and only visible after 300 ms (the `.skeleton` class does this).

## Code style
- No dependencies unless there's no reasonable way without one. Node built-ins first.
- CommonJS, `'use strict'`, small modules with a plain-English header comment explaining what they do and why.
- User-facing messages are short, plain, and say what to do next.
- Run `npm test` after every change. Add a test for any rule about money, times or emails.
