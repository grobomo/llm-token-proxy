#!/bin/bash
set -euo pipefail

# Run this ON the Lightsail instance after rsync'ing deploy/ to it.
# Usage: sudo bash /opt/dashboard/deploy/setup.sh

APP_DIR="/opt/dashboard"
NODE_VERSION="22"

echo "=== Dashboard Server Setup ==="

# Install Node.js
if ! command -v node &>/dev/null; then
  echo "[1/4] Installing Node.js $NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
else
  echo "[1/4] Node.js already installed: $(node --version)"
fi

# Install dependencies
echo "[2/4] Installing npm packages..."
cd "$APP_DIR/deploy"
npm install --omit=dev

# Generate password if not set
PASS_FILE="$APP_DIR/.dash-password"
if [ ! -f "$PASS_FILE" ]; then
  GENERATED_PASS=$(openssl rand -base64 12 | tr -d '/+=')
  echo "$GENERATED_PASS" > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  echo "  Generated password: $GENERATED_PASS"
  echo "  Saved to: $PASS_FILE"
else
  echo "  Password file exists: $PASS_FILE"
fi

# Create systemd service
echo "[3/4] Creating systemd service..."
cat > /etc/systemd/system/dashboard.service << EOF
[Unit]
Description=Token Proxy Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/deploy
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=80
Environment=USAGE_DB=$APP_DIR/usage.db
Environment=DASH_USER=admin
Environment=DASH_PASS=$(cat $PASS_FILE)
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dashboard
systemctl restart dashboard

echo "[4/4] Service started"
echo ""
echo "=== Setup complete ==="
echo "Dashboard: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)/dashboard"
echo "Login: admin / $(cat $PASS_FILE)"
echo "Audit: http://IP/admin/access-log?format=html"
