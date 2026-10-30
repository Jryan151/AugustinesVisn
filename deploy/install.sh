#!/usr/bin/env bash
# install.sh — put the booking site on a server that already runs other apps, without touching them.
#
#   sudo bash install.sh book.yourdomain.com            does it
#   sudo bash install.sh book.yourdomain.com --dry-run  shows every step, changes nothing
#
# Everything it makes is the booking site's own:
#   user     booking            (it can't read or change any other app's files)
#   folder   /srv/booking       (code, .env, data/booking.sqlite, data/backups/)
#   port     3200 on 127.0.0.1  (only nginx on this machine can reach it)
#   pm2      "booking", under the booking user (a separate pm2 from root's: other apps' pm2 lists don't change)
#   nginx    /etc/nginx/sites-available/booking (a new file; no other site's file is edited)
# nginx is only reloaded if `nginx -t` passes, so a mistake can't take the other sites down.
#
# Remove it all again: sudo bash install.sh --remove
set -euo pipefail

APP_USER=booking
APP_DIR=/srv/booking
PORT="${PORT:-3200}"
REPO=https://github.com/Jryan151/AugustinesVisn.git
NGINX_FILE=/etc/nginx/sites-available/booking

DOMAIN=""; DRY=0; REMOVE=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --remove) REMOVE=1;; -*) echo "Unknown option $a"; exit 1;; *) DOMAIN="$a";; esac; done
run() { echo "  \$ $*"; [ "$DRY" = 1 ] || "$@"; }
step() { echo; echo "== $*"; }
as_app() { run runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" PATH="$PATH" "$@"; }

[ "$(id -u)" = 0 ] || { echo "Run this with sudo (or as root)."; exit 1; }
# Work from a folder every user can read. Started from /root, pm2 (running as the booking user) can't start Node
# there and fails with "spawn /usr/bin/node EACCES".
cd /
PM2="$(command -v pm2 || true)"

if [ "$REMOVE" = 1 ]; then
  step "Removing the booking site (other apps are left alone)"
  [ -n "$PM2" ] && id "$APP_USER" >/dev/null 2>&1 && { as_app "$PM2" delete booking || true; as_app "$PM2" save --force || true; run "$PM2" unstartup systemd -u "$APP_USER" --hp "/home/$APP_USER" || true; }
  run rm -f /etc/nginx/sites-enabled/booking "$NGINX_FILE"
  nginx -t && run systemctl reload nginx
  echo; echo "The app's folder is kept, with its data: $APP_DIR. Delete it yourself when you're sure."
  exit 0
fi

[ -n "$DOMAIN" ] || { echo "Usage: sudo bash install.sh book.yourdomain.com [--dry-run]"; exit 1; }

step "Checking what's here"
command -v node >/dev/null || { echo "Node isn't installed."; exit 1; }
NODE_V="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || { echo "Node $NODE_V is too old: the booking site needs 22.13 or newer (for its built-in SQLite)."; echo "Upgrading Node also restarts the other apps; do it at a quiet time."; exit 1; }
echo "  Node $NODE_V: ok"
[ -n "$PM2" ] || { echo "pm2 isn't installed."; exit 1; }
command -v nginx >/dev/null || { echo "nginx isn't installed."; exit 1; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "Port $PORT is already in use. Run again with PORT=<another> sudo -E bash install.sh $DOMAIN"; exit 1; fi
echo "  Port $PORT: free"
[ ! -e "$NGINX_FILE" ] || { echo "$NGINX_FILE already exists. To start over: sudo bash install.sh --remove"; exit 1; }

step "Its own user and folder"
id "$APP_USER" >/dev/null 2>&1 || run useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ ! -d "$APP_DIR/.git" ]; then
  run mkdir -p "$APP_DIR"
  run chown "$APP_USER:$APP_USER" "$APP_DIR"
  as_app git clone --depth 1 "$REPO" "$APP_DIR"
fi

step "Settings (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=')"
  if [ "$DRY" = 0 ]; then
    umask 077
    sed -e "s|^PORT=.*|PORT=$PORT|" \
        -e "s|^BASE_URL=.*|BASE_URL=https://$DOMAIN|" \
        -e "s|^NODE_ENV=.*|NODE_ENV=production|" \
        -e "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" \
        -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PW|" \
        -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
        "$APP_DIR/.env.example" > "$APP_DIR/.env"
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
  fi
  echo "  Made $APP_DIR/.env"
  echo "  ADMIN PASSWORD (save it now, it isn't shown again): $ADMIN_PW"
else
  echo "  $APP_DIR/.env already exists: kept as it is."
fi

step "Checks"
as_app bash -c "cd $APP_DIR && npm test --silent"

step "Starting it under pm2 (as $APP_USER)"
as_app "$PM2" start "$APP_DIR/server.js" --name booking --cwd "$APP_DIR" --node-args="--disable-warning=ExperimentalWarning"
as_app "$PM2" save
run "$PM2" startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
if [ "$DRY" = 0 ]; then
  for i in $(seq 1 15); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "The app didn't answer. See: sudo runuser -u $APP_USER -- pm2 logs booking"; exit 1; }
  echo "  It answers on 127.0.0.1:$PORT"
fi

step "nginx (a new file; nothing else edited)"
if [ "$DRY" = 0 ]; then
  sed -e "s|book.example.com|$DOMAIN|g" -e "s|127.0.0.1:3200|127.0.0.1:$PORT|g" "$APP_DIR/deploy/nginx-booking.conf" > "$NGINX_FILE"
fi
run ln -sf "$NGINX_FILE" /etc/nginx/sites-enabled/booking
if [ "$DRY" = 0 ] && ! nginx -t; then
  echo "nginx's check failed, so nothing was reloaded and the other sites are untouched."
  run rm -f /etc/nginx/sites-enabled/booking
  exit 1
fi
run systemctl reload nginx

cat <<EOF

Done. What's left (DEPLOY.md has the details):
  1. DNS: point $DOMAIN at this server (in Cloudflare: an A record to this server's IP, proxied).
  2. HTTPS: see DEPLOY.md step 4 (Cloudflare origin certificate or certbot).
  3. Stripe and email keys in $APP_DIR/.env, then: sudo runuser -u $APP_USER -- pm2 restart booking --update-env
EOF
