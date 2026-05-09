#!/bin/bash
set -euo pipefail
# Deploy HTTPS cert to the Lightsail dashboard instance
HOST="${1:-token-proxy-dashboard}"
DOMAIN="${2:-tokentracker.click}"
EMAIL="${3:-joel@joeltest.org}"

echo "[deploy-https] Running certbot on $HOST for $DOMAIN..."
ssh "$HOST" "sudo bash /opt/dashboard/deploy/setup-https.sh $DOMAIN $EMAIL"
echo "[deploy-https] Done. Verify: https://$DOMAIN/dashboard"
