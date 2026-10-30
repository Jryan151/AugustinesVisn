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

## 5. Payments and email (when you're ready to take real bookings)
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
