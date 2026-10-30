# Augustine's Visn — booking

A booking site for photography sessions. A client picks a package and a golden-hour time, pays a deposit, and tells
the photographer about the shoot. The photographer runs everything from one Admin page.

No dependencies: Node 22.13+ only (built-in web server, built-in SQLite, Stripe and Resend called with `fetch`).

```
cp .env.example .env     # fill in what you have; everything works locally without keys
npm start                # http://localhost:3000   ·   admin: /admin (password "admin" locally)
npm test
```

## What it does

**Client**
1. **Packages**: length, edited photos, turnaround, price.
2. **Time**: only golden hour. Morning sessions start just before sunrise; evening sessions end just after sunset.
   Times are worked out from the sun at your location, so they move with the seasons on their own.
3. **Details & deposit**: terms checkbox, then **Zelle** (no fees: the client gets the details and a memo reference,
   taps "I've sent it", and the photographer confirms with one tap from an email) or **card** (Stripe Checkout,
   when a key is set). The time is held while they pay: 30 minutes for card, 24+ hours for Zelle.
4. **Emails** (automatic): confirmation with the prep link, 3-day and 1-day reminders, the gallery link, and a
   review request a week after delivery.

**Photographer (Admin)**
- **Bookings**: Booked → Prepped → Shot → Editing → Delivered. Moves happen at once with an Undo toast. Deliver and
  Cancel email the client, so that email waits 10 seconds and Undo takes it back.
- **Photos** (per booking): upload the finished photos (drag in a whole folder's worth), remove with Undo, then
  "Send" emails the client their private gallery at `/gallery/<their link>`.
- **Watermarked proofs until the balance is paid**: the gallery shows the photos with the brand mark across them and
  no downloads. The client pays the balance right there (Stripe), or the photographer taps **Mark paid** (cash, in
  person; Undo works until the email leaves). Either way the clean, full-quality photos unlock, with Download and
  Download all, and the client gets an email. Packages with no balance are never locked.
- **Clients**: everyone who has booked, grouped by email: sessions, packages, total, stage (upcoming, editing,
  delivered), repeat clients, and a private note per client.
- **Site**: up to 6 background photos behind every page, fading slowly from one to the next.
- **Availability**: sunrise/sunset days of the week, shoots per week (the cap that protects your turnaround),
  notice, how far ahead, days off, booking terms.
- **Packages**: prices, deposits, lengths, order (↑ ↓), the photo behind each card, and a **portfolio** of example
  shots (visitors reach it from "See portfolio" on the card's photo: `/portfolio/<package>`).
- **Payments & email**: Zelle details (and QR code), whether card is on, email status and "Send me a test email".

## Things that can't go wrong
- **No double bookings.** The time check and the hold happen together, and the database allows one live booking per time.
- **No double charges.** "Pay deposit" sends an Idempotency-Key; a retry or double tap gets the same booking back.
- **Only Stripe marks a booking paid**, through its signed webhook. A late payment for a time someone else took
  becomes "Needs attention" (refund it), never a second booking.
- **Each email goes once.** Every email is queued in an outbox that allows one of each kind per booking.

## Going live
1. `NODE_ENV=production`, `BASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET` (any long random string).
2. Stripe: `STRIPE_SECRET_KEY`, then add a webhook to `https://<your site>/api/stripe/webhook` for
   `checkout.session.completed` and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Email: `RESEND_API_KEY` and `MAIL_FROM` (a verified domain). Without them emails print to the console.
4. Background and package photos: upload them in Admin › Site and Admin › Packages.
5. Back up `data/backups/` (a copy is made every day).

On the content generator server: see DEPLOY.md (one script, separate from the generator).

Refunds are done in the Stripe dashboard.

## Layout
```
server.js            starts everything; serves pages; injects the home background
src/config.js        settings from .env
src/db.js            schema, statuses, default packages and rules
src/http.js          routes, JSON, static files, security headers
src/sun.js           sunrise / sunset
src/availability.js  which times can be booked
src/bookings.js      hold → booked → … → delivered, undo, idempotency
src/payments.js      Stripe Checkout and webhook signatures
src/mail.js          every email, and the outbox
src/media.js         receiving uploads: real-image check, size, web copies (ffmpeg)
src/galleries.js     client photos: add, remove/undo, the private gallery, download-all zip
src/sitemedia.js     background photos and package card photos
src/clients.js       the client list, worked out from bookings
src/jobs.js          every 15 s: expire holds, queue reminders, send email
src/auth.js          the admin login
src/routes.js        the API
public/              pages (home, book, booked, prep, admin), styles.css, one script per page + common.js
test/                node --test
```
