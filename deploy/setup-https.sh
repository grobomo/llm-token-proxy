#!/bin/bash
set -euo pipefail

# Run ON the Lightsail instance after domain DNS is pointing to this IP.
# Usage: sudo bash /opt/dashboard/deploy/setup-https.sh

DOMAIN="${1:-tokentracker.click}"
EMAIL="${2:-joel@joeltest.org}"

echo "=== HTTPS Setup for $DOMAIN ==="

# Stop the dashboard temporarily so certbot can use port 80
echo "[1/4] Stopping dashboard for cert issuance..."
systemctl stop dashboard

# Get certificate
echo "[2/4] Requesting certificate from Let's Encrypt..."
certbot certonly --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  -d "$DOMAIN" \
  --preferred-challenges http

# Update systemd service to set DOMAIN env
echo "[3/4] Updating service config..."
sed -i "s|^Environment=NODE_ENV=production|Environment=NODE_ENV=production\nEnvironment=DOMAIN=$DOMAIN|" /etc/systemd/system/dashboard.service
systemctl daemon-reload

# Restart dashboard (will now serve HTTPS)
echo "[4/4] Restarting dashboard..."
systemctl start dashboard

echo ""
echo "=== Done ==="
echo "HTTPS: https://$DOMAIN/dashboard"
echo "HTTP:  http://$DOMAIN/dashboard (still works)"
echo ""
echo "Auto-renewal: certbot.timer is already active"
echo "Note: After cert renewal, restart dashboard: systemctl restart dashboard"
