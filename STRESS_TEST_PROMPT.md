# Stress-test prompt — AugustinesVisn

Paste everything below the line into Claude Code (or any coding agent) opened on the `AugustinesVisn` repo.

---

You are stress-testing **AugustinesVisn**, a single-photographer booking site (Node 22, no dependencies, `node:sqlite` in WAL mode, CommonJS). Read `CLAUDE.md`, `README.md`, `src/bookings.js`, `src/routes.js`, `src/availability.js`, `src/mail.js` and `public/admin.js` before you write anything. The rules in `CLAUDE.md` are the standard every finding is judged against.

My values are **efficiency and effectiveness**. The test for any feature is: *does it move a client to the next step, or save the photographer real time?* I want to find out what earns its place, what breaks under load, and what's wasted motion.

## Ground rules (non-negotiable)
- **Never touch production** (`book.jasonryean.pro`) or its database. Run everything against a local copy: fresh `DATA_DIR` in a temp folder, `PORT` of your choosing, Stripe unset or in test mode only, mail pointed at nothing (or a local sink) so **no real client is ever emailed**.
- Use the `/api/dev/*` pay endpoints and test credentials only. Admin password comes from a local `.env` you create.
- Don't add dependencies to the app. Write the load tooling as plain Node scripts in a new `stress/` folder (built-in `fetch`, `worker_threads`/`Promise.all`, `node:sqlite` to inspect results).
- Don't change app code during the test. Record findings; propose fixes at the end.
- `npm test` must still pass when you're done.

## Part 1 — Order volume

Remember the real shape of this business: one photographer, a limited number of golden-hour slots a day. "High volume" here means **many people competing for few slots at once**, plus a pipeline that keeps growing for months. Test both.

Build `stress/seed.js` and `stress/load.js` that can run these scenarios, each with a short summary printed at the end:

1. **Steady stream** — a realistic, consistent flow: ~1 new client every N seconds for 30 minutes, each one doing the full client path: `GET /api/packages` → `GET /api/availability` → `POST /api/bookings` (with a fresh Idempotency-Key) → dev-pay → `POST /api/bookings/:token/prep`. Mix packages and Stripe vs. Zelle.
2. **Ramp to break** — double the arrival rate every 2 minutes (1, 2, 4, 8 … concurrent clients) until p95 latency passes 1 s or errors exceed 1%. Report the rate where it bent and *what* bent (CPU, SQLite busy/locked, event loop lag, memory).
3. **Slot stampede** — 50 clients hit `POST /api/bookings` for the **same slot** in the same instant. Exactly one must win; everyone else gets a clean 409 with a usable message. Check the unique index held and nothing half-wrote.
4. **Double-tap / retry storm** — same Idempotency-Key sent 20× concurrently and again after success. Must produce one booking and identical responses.
5. **Hold churn** — create many holds and let them expire; mix in late payments after expiry to hit the `needs_refund` path. Confirm expired holds free the slot immediately for `/api/availability`.
6. **Zelle backlog** — many Zelle holds open at once (hold hours long). How does that affect availability and the Bookings tab?
7. **A year of history** — seed ~2,000 bookings across every status, ~300 clients with repeat visits, galleries with photos. Then time: `GET /api/admin/bookings`, `GET /api/admin/clients`, the admin page's first paint, and `/api/availability` over the full 62-day window. Note anything that loads the whole table with no limit or pagination.
8. **Gallery delivery** — upload a realistic gallery (100–300 JPGs, mixed sizes) to several bookings at once, then have many clients load proofs and `/g/:token/all.zip` concurrently. Watch memory (uploads must stream, never buffer), watermark job time, and confirm **no clean image is ever served before the balance is paid**.
9. **Email outbox** — during the load, confirm every email is queued through `mail.queue`, exactly one per kind per booking, nothing sent inline, and Undo inside `UNDO_MS` really cancels.

For each scenario record: requests, p50/p95/p99 latency, error count by status code, DB file + WAL size, peak RSS, and any rule from `CLAUDE.md` that was broken. Put raw numbers in `stress/results/*.json`.

## Part 2 — Workflow, tabs and routing

Walk the admin as the photographer would on a phone (≈390 px wide) with the seeded year of data. The tabs are: **Bookings, Clients, Site, Availability, Packages, Payments & email**.

For each common job, count taps, screens, tab switches and waits from opening `/admin` to done:
- See today's/this week's shoots
- Confirm a Zelle payment
- Move a booking hold → booked → prepped → shot → editing → delivered
- Upload and deliver a gallery
- Mark a balance paid
- Cancel a booking (and undo it)
- Block off a day / change availability
- Find a returning client and their history
- Change a package price or order

Then answer:
- Which tabs are opened daily, weekly, rarely? Should any merge, split, reorder, or move behind a menu?
- Is any job split across two tabs that should live in one place? Any dead ends or places you have to go back to start?
- Does the Bookings pipeline stay usable at 2,000 bookings, or does it need filters/grouping (today, needs action, awaiting payment, editing)?
- Client side: count the steps from home → booked → prep → gallery → paid download. Where would a real client hesitate or drop off?
- Check every route in `src/routes.js`: anything unused by the front end, duplicated, or missing auth/limits? Any public endpoint that could be hammered (no rate limit on `/api/bookings`, `/api/admin/login`, `/api/confirm/:code`)?

## Part 3 — Behaviour, habits and patterns

From the seeded data and the walkthroughs, document what a photographer's and a client's habits would look like, and what the data can already reveal. Write SQL queries (saved in `stress/patterns.sql`) and report on:
- **Demand**: which days, times, months and packages fill first; lead time between booking and shoot; how fast golden-hour slots sell out.
- **Drop-off**: holds that expire vs. convert, by payment method; prep forms never filled; delivered galleries never opened; balances that sit unpaid and for how long.
- **Repeat clients**: how often they come back, which package they move to.
- **Photographer workload**: time from shot → delivered; how many bookings sit in each status at once; which admin actions happen in bursts (e.g., Sunday-night edits).
- **Payment mix**: in-person vs. Zelle vs. Stripe, and how the $5 per-use fee vs. $15/month unlimited would have played out on this volume.
- What the app *doesn't* record today that would be worth recording (only if it would change a decision).

Clearly label which patterns are from **seeded/simulated data** and which are **built into the design**, so nothing simulated is mistaken for a real finding.

## Deliverable

Write `stress/REPORT.md` with:
1. **One-paragraph verdict** — can this handle the photographer's busiest realistic season, and where is the ceiling?
2. **What's effective** — keep as-is.
3. **What's inefficient** — ranked by how much time or money it costs, each with a specific fix.
4. **What breaks** — bugs, rule violations, race conditions, with the exact steps to reproduce.
5. **Workflow redesign** — proposed tab order/grouping and the tap counts before vs. after.
6. **Patterns** — the behaviour findings and what feature each one points toward (or rules out).
7. **Top 5 next changes**, each passing the "next step or real time saved" test.

Keep it plain and short. No fixes merged without my sign-off.
