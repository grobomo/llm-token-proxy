#!/bin/bash
set -euo pipefail

INSTANCE_NAME="token-proxy-dashboard"
REGION="us-east-1"
AZ="${REGION}a"
BLUEPRINT="debian_12"
BUNDLE="nano_3_0"
KEY_NAME="token-proxy-dash"

echo "=== Provisioning Lightsail instance: $INSTANCE_NAME ==="

# Create key pair if it doesn't exist
if ! aws lightsail get-key-pair --key-pair-name "$KEY_NAME" --region "$REGION" &>/dev/null; then
  echo "[1/5] Creating key pair..."
  aws lightsail create-key-pair \
    --key-pair-name "$KEY_NAME" \
    --region "$REGION" \
    --query 'privateKeyBase64' --output text | base64 -d > ~/.ssh/${KEY_NAME}.pem
  chmod 600 ~/.ssh/${KEY_NAME}.pem
  echo "  Key saved: ~/.ssh/${KEY_NAME}.pem"
else
  echo "[1/5] Key pair exists"
fi

# Create instance
if aws lightsail get-instance --instance-name "$INSTANCE_NAME" --region "$REGION" &>/dev/null; then
  echo "[2/5] Instance already exists"
else
  echo "[2/5] Creating instance ($BUNDLE, $BLUEPRINT)..."
  aws lightsail create-instances \
    --instance-names "$INSTANCE_NAME" \
    --availability-zone "$AZ" \
    --blueprint-id "$BLUEPRINT" \
    --bundle-id "$BUNDLE" \
    --key-pair-name "$KEY_NAME" \
    --region "$REGION"

  echo "  Waiting for instance to be running..."
  for i in $(seq 1 60); do
    STATE=$(aws lightsail get-instance --instance-name "$INSTANCE_NAME" --region "$REGION" --query 'instance.state.name' --output text 2>/dev/null || echo "pending")
    if [ "$STATE" = "running" ]; then break; fi
    sleep 5
  done
  echo "  Instance state: $STATE"
fi

# Open port 80
echo "[3/5] Opening port 80..."
aws lightsail open-instance-public-ports \
  --instance-name "$INSTANCE_NAME" \
  --port-info fromPort=80,toPort=80,protocol=tcp \
  --region "$REGION" 2>/dev/null || true

# Get public IP
PUBLIC_IP=$(aws lightsail get-instance \
  --instance-name "$INSTANCE_NAME" \
  --region "$REGION" \
  --query 'instance.publicIpAddress' --output text)
echo "[4/5] Public IP: $PUBLIC_IP"

# Add to SSH config
if ! grep -q "$INSTANCE_NAME" ~/.ssh/config 2>/dev/null; then
  cat >> ~/.ssh/config << EOF

Host $INSTANCE_NAME
  HostName $PUBLIC_IP
  User admin
  IdentityFile ~/.ssh/${KEY_NAME}.pem
  StrictHostKeyChecking no
EOF
  echo "  Added to ~/.ssh/config"
fi

echo "[5/5] Instance ready at http://$PUBLIC_IP"
echo ""
echo "Next steps:"
echo "  1. ssh $INSTANCE_NAME"
echo "  2. Run deploy/setup.sh on the instance"
echo "  3. Set up DB sync: scripts/sync-dashboard.sh"
echo ""
echo "Public URL: http://$PUBLIC_IP/dashboard"
