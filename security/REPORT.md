# Security report — AugustinesVisn

Run on 31 Oct 2026 against throwaway local copies only (127.0.0.1, temp folders, fake passwords, no Stripe key, no email key). The live site, its database and its server were never touched. Every test file was a harmless stand-in made on the spot. App code was not changed; `npm test` passes (53/53). Raw numbers: `security/results/probe.json`. Re-run: `node security/probe.js`.

## 1. Verdict

The parts that protect money and photos are solid: nobody but the photographer can upload anything, nobody can reach Admin without the password, client links can't be guessed, and unpaid clients only ever get watermarked proofs. A stranger with a weekend **can't steal photos, take money, or put a file on your server.** What they *can* do is be a nuisance with no payment: make the site send booking-code emails to any address list, flood the photographer's inbox with fake time requests, and (only if Zelle is switched on) hold every open time for 24 hours so real clients see a full calendar. All three come from one gap: **there's no per-visitor limit on the public forms**, and the login's own limit can be dodged with a fake header. All are fixable without touching the photographer's workflow.

## 2. Secrets

| Secret | Where it lives | Exposure | The one thing to do |
|---|---|---|---|
| Admin password | server `.env` (install.sh makes an 18-char random one) | never committed, never sent to the browser | keep it; it's strong enough that guessing isn't realistic |
| Session secret | server `.env` (random, from install.sh) | never committed | nothing |
| Stripe secret key | server `.env` (not set yet) | server-only; browser code has no key | when you add it, use a **restricted key** (see 5) |
| Resend email key | server `.env` | server-only | keep it "Sending access" only, as DEPLOY.md says |
| Client booking/gallery links | database | 144-bit random tokens | nothing — guesses all returned 404 |
| Zelle Confirm links | photographer's email | signed, expire | nothing |

Full git history (25 commits) checked: no keys, `.env`, database or photo files ever committed. The only key-shaped text is the `re_...` placeholder in DEPLOY.md.

## 3. Already safe — don't touch

- **Zero dependencies.** No supply-chain risk at all.
- **Admin locked.** All 9 admin reads and 9 admin writes refused without login (401). Forged and expired login cookies refused. Uploading without login is refused immediately (20 MB rejected in under 0.3 s, never stored).
- **Uploads.** `.js`, `.html`, `.svg`, and a text file named `.jpg` all rejected by their bytes (415). Files get random names, so a name like `../../etc/passwd` is ignored. Over 60 MB refused (413). Served back as `image/jpeg` with `nosniff`, so even a file that starts like a JPG and hides HTML can't run as a page.
- **Files off-limits.** `.env`, `server.js` and the database can't be read through any of 7 path tricks.
- **Photo gate.** Unpaid client: original 402, zip 402, preview is watermarked (different from the clean file). Client A's link can't open client B's photo (404).
- **Errors.** No stack traces, paths or SQL in any error. Deeply nested JSON handled cleanly.
- **Code guessing.** In-person 6-digit code locks after 5 wrong tries; one address can get 3 codes per 30 min.
- **Dev "pretend paid" links** are closed in production (404).
- **Text from strangers** (names, notes) is escaped everywhere Admin shows it, with the Content-Security-Policy as a second wall.
- Passwords compared in constant time; cookies are HttpOnly, SameSite=Strict, Secure in production.

## 4. Real holes (ranked by damage × ease)

### Fix this week

**H1 — The site can be made to email any address list.** *(Fear 3: cost/flood.)*
Repro (local): POST `/api/bookings` with `method: in_person`, a new email each time. 40 of 40 accepted, 40 "your booking code" emails queued. The only limit is per email address, not per visitor.
Worst case: someone sends thousands of emails from your domain through your Resend account → you hit Resend's limits, your domain's sending reputation drops (real booking emails start landing in spam), or Resend suspends the account.
Fix: a per-visitor limit on code requests (e.g. 5 per hour per IP) plus the nginx limit in H4.

**H2 — If Zelle is on, one script can fill the whole calendar for free.** *(Fear 3.)*
Repro (local, Zelle switched on): one hold request per open time with fake emails. 35 of 35 accepted, **0 times left** for real clients, each hold lasts 24 h, and tapping "I sent it" stretches one to ~48 h. It also emailed 35 strangers. Card holds have the same gap (30-min holds) once Stripe is on.
Worst case: the photographer's booking page shows nothing available during his busy season until he cancels each junk hold by hand.
Fix: cap open holds per visitor (e.g. 2) and per email; optionally require the email code (as in-person does) before a Zelle hold. *I don't know whether Zelle is switched on live — check Admin › Payments & email.*

**H3 — The login limit can be dodged with a fake header.** *(Fear 1.)*
Repro (local, set up like production with `TRUST_PROXY=1`): 200 wrong passwords, each with a different made-up `X-Forwarded-For` → 0 blocked. Same with `CF-Connecting-IP`. One machine managed ~28,000 guesses a minute.
Why: nginx *adds* the real address to whatever the visitor sent, and the app reads the first one (the fake). `CF-Connecting-IP` is only trustworthy if the server only accepts traffic from Cloudflare.
Worst case today is small, because install.sh's password is long and random — guessing it is not realistic. But the limit isn't doing its job, and the list of "failed addresses" grows without end (slow memory leak under attack).
Fix: in nginx, `proxy_set_header X-Forwarded-For $remote_addr;` (overwrite, don't append), and in the app read the *last* address, or only trust `CF-Connecting-IP` if the site is behind Cloudflare. Clear old entries from the failed-login list.

**H4 — No limit on how often anyone can hit the public forms.** *(Fear 3, the root of H1–H2.)*
The nginx file has no `limit_req`. Time requests: 30 of 30 from different addresses accepted, 30 emails to the photographer.
Fix (no app code, no effect on the photographer): add an nginx rate limit on `/api/bookings`, `/api/requests` and `/api/admin/login` — e.g. 10 requests/minute per IP with a small burst.

### Nice to have

**H5 — Oversized form body cuts the connection** instead of a clean "too large" (200 KB note → connection reset). Harmless (the app stays up); behind nginx a visitor would see a 502. Fix: drain the body before answering 413.

**H6 — `NODE_ENV=production` is load-bearing.** Without it, the admin password falls back to `admin` and a client can unlock their own photos with the dev pay link (proved on the dev copy: 200). install.sh sets it correctly — just confirm by hand on the server: `sudo grep NODE_ENV /srv/booking/.env` should say `production`. Optional fix: refuse to start on a public `BASE_URL` (https) unless it's set.

## 5. The three fears, answered

**Can my keys leak, and what happens if one does?** Not from this code: no key is in the repo, its history, or anything the browser downloads, and errors don't leak them. The realistic leak paths are outside the code — the server itself or a screenshot of `.env`. To shrink the damage if one ever does: use a Stripe **restricted key** that can only create Checkout Sessions (it can't refund or pay out), turn on Stripe's email alerts for refunds and disputes, and keep Resend's key "Sending access" only. If you ever suspect a leak: roll the key in that dashboard first, then update `.env` and restart. Stripe test keys can never move real money.

**Can someone make me host something I'd be liable for?** No. Strangers have no way to upload a file — every upload route needs the photographer's login, and even his uploads must really be JPG/PNG/WebP. The only thing strangers can store is short text (names, notes, prep answers), which only the photographer sees, and it's shown as plain text, never run.

**Can someone flood me?** Yes, as a nuisance (H1, H2, H4): spam emails from your domain, a junk-filled calendar if Zelle is on, a full inbox. Not as a takeover. The two changes that cut most of it: an nginx rate limit (H4) and a per-visitor cap on holds and code emails (H1/H2).

## 6. Fixes for sign-off

| # | Fix | Effort | Touches the photographer's workflow? |
|---|---|---|---|
| 1 | nginx `limit_req` on bookings, requests, login (H4) | minutes | No |
| 2 | nginx overwrites `X-Forwarded-For`; app reads the right address; prune failed-login list (H3) | minutes–an hour | No |
| 3 | Per-visitor cap on code emails and open holds (H1, H2) | an hour | No (real clients book one time) |
| 4 | Email code before a Zelle hold (H2, stronger) | an hour | Adds one step for Zelle clients — your call |
| 5 | Stripe restricted key + alerts when Stripe goes live | minutes, in Stripe's dashboard | No |
| 6 | Clean 413 on oversized bodies (H5); refuse to start insecurely (H6) | minutes each | No |

Nothing here has been applied. Every fix needs your go-ahead.

---

## After the fixes (branch `security-hardening`, same probes re-run)

The probes now act like the server's nginx (it adds the visitor's real address at the end of `X-Forwarded-For`).

| Probe | Before | After |
|---|---|---|
| Code emails to 40 addresses from one connection | 40 sent | 5 sent, 35 refused |
| Zelle holds from one connection | 35 of 35 (calendar empty) | 5, then refused; 65 of 74 times still open |
| One email holding many times | unlimited | 2 at once |
| Time requests from 30 addresses, one connection | 30 emails to the owner | 5 |
| 200 wrong passwords with a fake address header | 0 blocked | 200 blocked |
| Fake `CF-Connecting-IP` | 0 blocked | 20 of 20 blocked |
| Many connections guessing at once | no site-wide limit | login pauses 15 min after 30 wrong; owner emailed once; logged-in phone keeps working |
| 300 KB form body | connection cut | clean 413 |
| Changing `ADMIN_PASSWORD` | old logins kept working | every device logged out |
| https site without `NODE_ENV=production` | `admin` password + pretend-paid links | both off |

Everything in section 3 still holds. `npm test`: 62 pass (9 new tests in `test/security.test.js`).

What these caps don't do: a determined person with many internet connections could still hold several times each.
If junk Zelle holds ever show up, the next step is the email code before a Zelle hold (fix 4) — one extra step for
Zelle clients, so it's your call.
