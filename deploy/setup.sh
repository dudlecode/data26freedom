#!/usr/bin/env bash
# Установка CQA на Debian 12 (Google Compute Engine): Python через uv, служба systemd, Caddy с HTTPS.
# Запуск на машине из каталога с распакованным проектом:  sudo bash deploy/setup.sh cqa.dogslabs.org
set -euo pipefail
DOMAIN="${1:?укажите домен, например cqa.dogslabs.org}"
APP_DIR=/opt/cqa
APP_USER=cqa

apt-get update -qq
apt-get install -y -qq curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg sqlite3 >/dev/null

# Caddy (официальный репозиторий)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
cp -a ./. "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# Python 3.12 и зависимости через uv
sudo -u "$APP_USER" bash -c "cd $APP_DIR && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$APP_DIR/.uv sh >/dev/null \
  && $APP_DIR/.uv/uv venv -q --python 3.12 .venv && $APP_DIR/.uv/uv pip install -q --python .venv/bin/python -r requirements.txt"

cat > /etc/systemd/system/cqa.service <<UNIT
[Unit]
Description=CQA: Conversation Quality Analytics
After=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR/backend
Environment=CQA_HOST=127.0.0.1
Environment=CQA_PORT=8000
ExecStart=$APP_DIR/.venv/bin/python -m cqa
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8000
}
CADDY

systemctl daemon-reload
systemctl enable --now cqa
systemctl restart caddy
sleep 3
systemctl --no-pager --lines=3 status cqa | head -5
curl -s http://127.0.0.1:8000/api/health && echo
