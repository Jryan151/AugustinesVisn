# AugustinesVisn stress test — report

October 30, 2026. Everything ran on a throwaway local copy (temp database, Stripe off, email printed and never sent). Production was never touched. No app code was changed, and `npm test` still passes (36/36). Raw numbers are in `stress/results/`; every scenario can be re-run with the scripts in `stress/`.

The test machine had 2 CPUs and ran the load generator on the same box, so the throughput numbers are conservative.

## 1. Verdict

Traffic is not your risk. One photographer at 4 shoots a week will never come close to what the site can take:

- It held about 1,250 requests a second and about 240 new holds a second.
- Responses stayed under 1 second (p95) until 1,000 people were booking at the same moment, with zero errors.
- Across about 32,000 holds, nothing was ever double-booked.

The real ceilings are elsewhere:

- **Anyone can lock your whole calendar for free.** One person, with no payment and junk details, can take every bookable time for 24 to 48 hours. It takes 71 requests and 0.3 seconds.
- **The admin gets heavier every month.** The Bookings and Clients pages load your entire history every time you open them or switch back to the app. With a realistic year of history, the Bookings board is already 17 phone screens long.
- **Two things the terms or the board promise have no button.** You can't reschedule a session, and you can't clear a refunded booking.

## 2. What's effective — keep as-is

- **No double bookings, ever.** 50 people hitting the same time at the same instant: exactly 1 wins, and 49 get a clean "That time was just taken. Pick another one." This held over 6 rounds, for both card and Zelle (`stampede.json`).
- **Double taps are harmless.** The same request sent 20 times at once makes 1 booking, and every response is identical. A deposit link opened 10 times sends 1 confirmation email (`retry.json`).
- **Late payments are handled.** An expired hold frees its time immediately (3 ms). If someone pays after their time went to another client, it is never double-booked: the booking goes to "needs refund" and you get an email (`churn.json`).
- **Watermarking is airtight.** 30 clients opened 3 unpaid galleries (3,060 photo requests). Not one clean byte was served. Originals and the zip download both returned "pay first" (`gallery.json`).
- **Email and Undo work as designed.** Every email goes through the outbox, at most one of each kind per booking. Undo works until the email actually leaves, then refuses (`outbox.json`).
- **The client booking flow is tight.** Book now → package → day → time → details → pay. The package and time screens move on by themselves. That's about 5 taps plus the form.
- **Every API route is used by the site.** There's nothing dead to remove.

## 3. What's inefficient — ranked by cost

1. **Unpaid Zelle holds eat your scarcest resource (costs money).**
   - Evidence: on the real calendar (4 a week, 60 days ahead), a steady stream of clients sold out every bookable time in 74 seconds. 10 of the 35 times were Zelle holds that hadn't paid.
   - Why it happens: a Zelle hold lasts 24 hours and counts toward the weekly cap. Tapping "I've sent it" extends it to 48 hours, and nothing checks that the money was actually sent.
   - Fix: hold for about 2 hours until "I've sent it" is tapped, and allow one open hold per email address.
2. **The board loads everything, every time.**
   - Evidence: with a realistic year (244 sessions), opening Bookings downloads 254 KB covering 239 bookings, and 197 of them are delivered galleries. The board then shows only the 17 delivered in the last 30 days, so most of the download is thrown away. The page also reloads in full every time you switch back to the app.
   - At 10× history: 2.5 MB, 430 ms, and the server's memory peaks at 490 MB. While that list loads, clients checking times wait 420 ms instead of 4 ms.
   - Fix: have the server send only what the board shows (live sessions, delivered in the last 30 days, unpaid balances). Reload on app switch only if it's been more than a minute.
3. **Bookkeeping taps that carry no information.**
   - "Mark shot" and "Start editing" are 2 taps on every session, about 400 taps a year at the cap. The app already knows when each session ends, and you can send a gallery straight from "Shot".
   - Fix: move a session to Shot automatically once it ends, and drop the separate "Start editing" step.
4. **This week's shoots are buried.**
   - On a phone, upcoming sessions are split across two columns (Booked and Prepped) that run from screen 2 to screen 11.
   - Your work queue (Shot and Editing) doesn't start until screen 11.7.
   - Fix: a "This week" strip at the top, then a "To edit" strip, then everything else.
5. **Uploading locks the Photos window.**
   - Evidence: each photo takes about 3 seconds (median, with 3 galleries uploading at once) because the server makes the web copies before it answers. The window can't be closed until every photo is done.
   - Fix: answer as soon as the original is saved, and make the copies in a background queue that runs at most 2 copy jobs at a time.
6. **Taking a day off means typing a date.** You type `2026-12-25` into a text box at the bottom of Availability. Nothing warns you if a booking is already on that day.
7. **The job loop re-checks every gallery you've ever sent, every 15 seconds** (to queue review emails). That's 10 ms with a year of history and about 100 ms at 10×, and it blocks the site while it runs. Fix: only look at galleries delivered 7 to 8 days ago.

## 4. What breaks

| # | What | Steps to reproduce | Evidence |
|---|---|---|---|
| 1 | **Calendar squatting.** One visitor locks every time for 24 h, or 48 h after tapping "I've sent it". It also makes the site email 35 addresses of their choosing, and sends you 35 "they say it's sent" emails. | Turn Zelle on. Call `POST /api/bookings` with `method: "zelle"` for the first free time, and repeat until none are left. | 35 holds, 71 requests, 0.3 s. Bookable times afterwards: 0 for all 3 packages (`zelle.json`) |
| 2 | **The admin password limit can be bypassed behind nginx.** `install.sh` turns on `TRUST_PROXY=1`. The app then trusts the first address in `X-Forwarded-For` (or `CF-Connecting-IP`), and the visitor writes those headers themselves. | Send wrong passwords with a different made-up `X-Forwarded-For` value each time. | Honest header: blocked after 5 tries. Made-up header: 200 tries, never blocked (`login.json`) |
| 3 | **"Needs refund" is a dead end.** Once a booking is there, no action works (cancel, every status move, deliver, mark paid), so the card stays on top of the board for good. Its note always says "refund in Stripe", even when the client paid by Zelle. | Let a hold expire, let someone else book that time, then pay the first hold. | Every action returns 400 (`refund.json`) |
| 4 | **The terms promise a free reschedule, but there's no way to do one.** Today it means cancelling (which emails the client) and having them book again with a new deposit. | Look for a reschedule action in Admin. | Code read: no reschedule route or button |
| 5 | **Small:** the toast says the email "goes out in 10 seconds", but the outbox sends 20 emails every 15 seconds. During a burst, the last emails left about 60 seconds later. Undo stays safe throughout. `jobs.js` says the loop runs "once a minute", but it runs every 15 seconds. | Deliver 5 galleries while 80 emails are queued. | `outbox.json` |

## 5. Workflow redesign

**Tabs.** All six tabs need 633 px of width, but a phone has 358 px. "Packages" and "Payments & email" sit off-screen. Proposed layout, ordered by how often you'd use each:

**Bookings · Calendar · Clients · Setup**

- **Bookings**: a "This week" strip, a "To edit" strip, then the full pipeline.
- **Calendar**: tap a day to block it (with a warning if it's booked), move a session to another time, and add a booking you made by DM or in person.
- **Clients**: unchanged.
- **Setup**: Packages, Site photos, Payments & email, and the booking terms. These are set-once screens.

| Job | Taps now | Taps after |
|---|---|---|
| See this week's shoots | Scroll screens 2–11, across 2 columns | 0 (top of board) |
| Session → delivered | 5 (Mark shot, Start editing, Photos, Add, Send), and the window stays locked while uploading | 3 (Photos, Add, Send), and you can close the window |
| Block a day off | Open the Availability tab, scroll past 8 fields, type the date, scroll, Save (3 taps plus typing) | 2 (tap the day, confirm) |
| Reschedule a client | Not possible (cancel, then the client rebooks and pays a new deposit) | 3 (Move, pick a time, confirm) |
| Clear a refunded booking | Not possible | 1 (Refunded) |
| Confirm a Zelle payment | 1 on the board, 2 from the email | Same — keep |
| Mark a balance paid | 1 | Same — keep |
| Cancel and undo | 1 + 1 | Same — keep |
| Find a returning client | 3 taps plus typing (Clients, search, open) | 1 (a "Returning · 3rd session" badge on the booking card, linking to their history) |
| Change a package price | Scroll the tab bar to Packages, then 3 | Setup, then 3 |

**Client side.** The booking flow has no wasted steps. The one overlap: "Anything I should know?" on the payment step asks for the same thing the prep form does. Dropping it puts one less field in front of the money moment.

## 6. Patterns

**From the design (true regardless of data):**

- **Pricing: per-use is only cheaper below 3 uses a month.** The $5 per-use fee beats the $15/month unlimited plan only at 2 or fewer uses a month. At your cap (about 17 sessions a month), per-use costs about $85 a month, 5–6× the subscription. Since he's starting on per-use, cap it: "never pay more than $15 in a month." That earns reliance instead of punishing a good month.
- **Zelle holds are the main way times get lost.** They hold for 24–48 hours with no proof of payment, compared with 30 minutes for card.
- **The weekly cap counts unpaid holds**, so a full week can be full of people who never pay.

**From simulated data (my assumptions, NOT findings about real clients).** The queries in `patterns.sql` work and show what real data would reveal:

- Demand by day and session, and the package mix
- Lead time (how far ahead people book)
- How fast full weeks fill
- Hold → paid conversion by payment method, and how long Zelle confirmation takes
- Prep fill rate
- Locked galleries, with dollars waiting and days waiting
- How balances get paid
- Repeat clients and which package they book next
- Turnaround against the promised days
- Work in progress and overdue edits
- When galleries go out
- The fee model, month by month

Run them on a copy of the live database:

```
node stress/patterns.js copy.sqlite
```

**Not recorded today, and worth recording (each would change a decision):**

- **Whether a client opened or downloaded their gallery.** It tells you whether an unpaid balance needs a nudge, or whether they haven't even looked yet.
- **How the client found him.** It tells you where to spend effort.

## 7. Top 5 next changes

1. **Stop calendar squatting.** A short Zelle hold until "I've sent it" is tapped, one open hold per email, and a simple per-visitor limit on new holds. *Next step: real clients can actually book.*
2. **Add "Refunded" for needs-refund bookings,** with the right wording for Zelle. *Time saved: the board stops showing dead cards.*
3. **Board: This week + To edit at the top.** Auto-move sessions to Shot, drop "Start editing", and have the server send only what the board shows. *Time saved: about 400 taps a year, and no scrolling to find tonight's shoot.*
4. **Calendar tab:** tap to block a day, Move (reschedule), and add a DM or in-person booking. *Next step and time saved: the terms' reschedule promise becomes real, and offline bookings can't collide with online ones.*
5. **Uploads don't lock the window.** Save the original, answer, and make the copies in a small background queue. *Time saved: about 5 minutes a gallery of waiting on a dialog.*

**Separately, as a safety fix (not a feature):** read the visitor's address from nginx's own `$remote_addr` (set it as `X-Real-IP` in the nginx config), or from the last entry of `X-Forwarded-For`. Ignore `CF-Connecting-IP`, since the site isn't behind Cloudflare. That makes the 5-tries password limit real again.

No fixes have been made. Each needs your sign-off.
