#!/usr/bin/env bash
# update.sh — bring the booking site on this server up to the newest version, safely.
#
#   sudo bash /srv/booking/deploy/update.sh
#
# Pulls the newest code, runs every check, restarts, and makes sure the site answers. If the checks fail or the site
# doesn't come back, it goes back to the version that was running. Your data (data/: bookings, photos, backups) and
# .env are never touched. Other apps on this server aren't touched either.
set -euo pipefail
APP_USER=booking
APP_DIR=/srv/booking
NGINX_FILE=/etc/nginx/sites-available/booking
[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }
cd /
PM2="$(command -v pm2)"
as_app() { runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" PATH="$PATH" "$@"; }
PORT="$(grep -oP '^PORT=\K\d+' "$APP_DIR/.env" || echo 3200)"

before="$(as_app git -C "$APP_DIR" rev-parse HEAD)"
echo "== Getting the newest version"
as_app git -C "$APP_DIR" fetch --depth 1 origin main
as_app git -C "$APP_DIR" reset --hard origin/main
after="$(as_app git -C "$APP_DIR" rev-parse HEAD)"
[ "$before" != "$after" ] || echo "  Already up to date; checking and restarting anyway."

back() {
  echo "!! $1 Going back to the version that was running."
  as_app git -C "$APP_DIR" reset --hard "$before"
  as_app "$PM2" restart booking --update-env >/dev/null
  exit 1
}

echo "== Checks"
as_app bash -c "cd $APP_DIR && npm test --silent" >/tmp/booking-test.log 2>&1 || { tail -30 /tmp/booking-test.log; back "A check failed."; }
echo "  All checks passed"

echo "== Restarting"
as_app "$PM2" restart booking --update-env >/dev/null
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || back "The site didn't answer after the restart."
echo "  The site answers"

# Photo uploads need nginx to accept large requests (older installs allowed only 1 MB).
if grep -q 'client_max_body_size 1m;' "$NGINX_FILE" 2>/dev/null; then
  echo "== Letting nginx accept photo uploads (up to 64 MB)"
  cp "$NGINX_FILE" /tmp/booking-nginx.bak
  sed -i 's/client_max_body_size 1m;/client_max_body_size 64m;\n    proxy_request_buffering off;/' "$NGINX_FILE"
  if nginx -t 2>/dev/null; then systemctl reload nginx; echo "  Done"; else cp /tmp/booking-nginx.bak "$NGINX_FILE"; echo "  nginx didn't accept the change, so it was put back. Uploads stay limited to 1 MB."; fi
fi

command -v ffmpeg >/dev/null || echo "Tip: 'sudo apt install -y ffmpeg' makes small web copies of uploaded photos, so pages load faster."
echo; echo "Updated to $(as_app git -C "$APP_DIR" log -1 --format='%h %s')"
