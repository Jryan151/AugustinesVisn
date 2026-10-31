# Putting the booking site live

It runs next to the content generator on the same server, **without touching it**: its own user (`booking`), its own
folder (`/srv/booking`), its own port (3200; the generator uses 3100), its own pm2 list, its own nginx file and its own
domain. Nothing in the generator's folder, pm2 or nginx file is edited. nginx is only reloaded after `nginx -t` passes.

## 1. Pick the address
A subdomain of a domain you already have in Cloudflare, e.g. `book.yourdomain.com` (or the photographer's own domain
later; only step 3 and BASE_URL change).

## 2. Install (on the server, about 2 minutes)
```
ssh root@<the generator server>
curl -fsSLo /tmp/install.sh https://raw.githubusercontent.com/Jryan151/AugustinesVisn/main/deploy/install.sh
sudo bash /tmp/install.sh book.yourdomain.com --dry-run     # read what it will do; changes nothing
sudo bash /tmp/install.sh book.yourdomain.com
```
It checks first (Node 22.13+, pm2, nginx, port free) and stops with a plain message if anything's missing. It prints
the **admin password once**: save it in your password manager.

If it says Node is too old: upgrading Node restarts the generator too, so do it at a quiet time, then run it again.

## 3. DNS (Cloudflare)
Add an **A record**: name `book`, value = the server's IP (the same IP the generator's record uses), **DNS only (grey
cloud)** for now.

## 4. HTTPS
```
sudo apt install -y certbot python3-certbot-nginx     # skip if certbot is already there
sudo certbot --nginx -d book.yourdomain.com
```
certbot edits only the booking file. Then in Cloudflare, switch the record to **Proxied (orange cloud)**. Your
domain's SSL mode should be **Full (strict)** (it likely already is, for the generator).

Open `https://book.yourdomain.com`: the site. `https://book.yourdomain.com/admin`: log in with the saved password.

## 5a. Email through Resend (confirmations, reminders, galleries, Zelle notices)
1. Make a free account at resend.com → **Domains → Add domain** → enter `send.jasonryean.pro` (a subdomain keeps
   these emails' reputation separate from anything else on the domain).
2. Resend shows 3–4 DNS records (an MX and TXT for SPF, a TXT for DKIM). In **Porkbun → jasonryean.pro → DNS**, add
   each one exactly as shown: copy and paste the value. In Porkbun's **Host** box, enter only the part before
   `.jasonryean.pro` (for example `send.send` or `resend._domainkey.send`, as Resend lists it). The `*` wildcard
   record doesn't get in the way: it only answers for A lookups.
3. Back in Resend, press **Verify**. Usually done within 15 minutes.
4. **API Keys → Create** (Sending access). Then on the server:
   ```
   sudo nano /srv/booking/.env
   RESEND_API_KEY=re_...
   MAIL_FROM=Augustines.Visn <bookings@send.jasonryean.pro>
   ADMIN_EMAIL=you@yourmail.com        # Zelle "check your bank" notices and new bookings go here
   sudo runuser -u booking -- pm2 restart booking --update-env
   ```
5. **Admin → Setup → Payments & email → Send me a test email.** It says where it went, or exactly why it didn't.

Emails made before the key was set were only written to the log (`pm2 logs booking`); they aren't re-sent.

## 5b. Zelle (no fees)
**Admin → Setup → Payments & email → Zelle**: tick it on, enter the email or phone your Zelle is registered to and the name
clients will see, and optionally upload your Zelle QR code (a screenshot from your bank app's Zelle screen). Without a
Stripe key, Zelle is the only way to pay, and booking is open.

How it runs: the client books, sees where to send the deposit and a memo reference (like `AV-HJJY`), and their time
is held (24 hours by default; 48 hours from when they tap "I've sent it"). You get an email with a **Confirm** link:
check your bank app for the memo, tap Confirm, and they're booked (their email waits 10 seconds, so Undo works). The
same for the balance from the gallery: Confirm unlocks their photos. Everything is also on the **Bookings** board.

## 5c. Card payments (optional, later) (when you're ready to take real bookings)
In `/srv/booking/.env` (`sudo nano /srv/booking/.env`):
- `STRIPE_SECRET_KEY` (start with the `sk_test_` key), and in Stripe → Developers → Webhooks add
  `https://book.yourdomain.com/api/stripe/webhook` for `checkout.session.completed`; put its signing secret in
  `STRIPE_WEBHOOK_SECRET`.
- `RESEND_API_KEY`, `MAIL_FROM` (an address on a domain verified in Resend), `ADMIN_EMAIL` (where new-booking notices go).
- `BUSINESS_NAME`, and `LATITUDE` / `LONGITUDE` if the shoots aren't around Phoenix.

Then: `sudo runuser -u booking -- pm2 restart booking --update-env`

Until a Stripe key is set, booking is closed on the live site with a polite message (it never pretends to take money).

## Updating to a new version
```
sudo bash /srv/booking/deploy/update.sh
```
Pulls the newest version, runs every check, restarts, and confirms the site answers. If anything fails it goes back to
the version that was running. Bookings, photos and `.env` are never touched. It also lets nginx accept photo uploads
on installs from before photos existed.

Recommended once: `sudo apt install -y ffmpeg` (likely already there for the generator). With it, uploaded photos get
small web copies so pages load fast; without it, the full-size photo is shown everywhere.

## Photos and disk space
Client photos live in `/srv/booking/data/galleries/`, site photos in `/srv/booking/data/media/`. Full-size photos add
up (a 40-photo session is around 1 GB), and this server's disk is shared with the generator. Check now and then with
`df -h /` and `sudo du -sh /srv/booking/data/galleries`. Old galleries can be removed per booking folder once clients
have downloaded them.

## Everyday commands
```
sudo runuser -u booking -- pm2 status            # is it running
sudo runuser -u booking -- pm2 logs booking      # what it's saying (emails print here until Resend is set)
cd /srv/booking && sudo runuser -u booking -- git pull && sudo runuser -u booking -- npm test && sudo runuser -u booking -- pm2 restart booking
```
The generator's commands (`pm2 status` as root, `bash update.sh`) are unaffected and don't list the booking site.

## Backups
A copy of the database is made every day in `/srv/booking/data/backups/` (14 kept). Hetzner's server backups (if on,
as SETUP.md suggests for the generator) include it. Now and then, download the newest one.

## Remove it
`sudo bash /tmp/install.sh --remove` takes out the pm2 entry and the nginx file. The folder and its data are kept
until you delete them yourself.

## Demo site (optional)

A second copy of the site full of sample data, to show every feature. It has its own database and photo folders
(`data/demo/`), never sends email, never takes real money, and its admin password is `demo`. It can run next to the
real site on the same server without touching it.

On your own computer: `npm run demo`, then open http://localhost:3300 (admin password: demo).

On the server, as its own pm2 app on its own port and subdomain (point `demo.<your domain>` at the server first):

```
sudo runuser -u booking -- env DEMO_PORT=3300 DEMO_BASE_URL=https://demo.<your domain> pm2 start /srv/booking/server.js --name booking-demo -- --demo
sudo runuser -u booking -- pm2 save
```

Then an nginx site for `demo.<your domain>` exactly like `deploy/nginx-booking.conf`, with `proxy_pass http://127.0.0.1:3300;`,
and a certificate (`sudo certbot --nginx -d demo.<your domain>`). After `update.sh`, restart it too:
`sudo runuser -u booking -- pm2 restart booking-demo`. **Reset sample data** (on the demo's own banner, once logged in)
puts everything back as it started.
