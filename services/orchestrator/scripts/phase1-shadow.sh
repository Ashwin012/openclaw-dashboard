#!/bin/bash
# Phase 1 — Shadow mode (DRY_RUN=true, log-only, task-worker still active if needed)
# Run as root or with sudo
set -e

REPO=/home/openclaw/projects/dev-dashboard
SERVICE_SRC=$REPO/services/orchestrator/orchestrator.service
SERVICE_DST=/etc/systemd/system/orchestrator.service

echo "[phase1] Installing orchestrator.service in shadow mode..."

# Patch service file for DRY_RUN before installing
cp "$SERVICE_SRC" "$SERVICE_DST"
# Inject DRY_RUN=true into the service environment
sed -i '/^Environment=NODE_ENV/a Environment=DRY_RUN=true' "$SERVICE_DST"

systemctl daemon-reload
systemctl enable orchestrator
systemctl start orchestrator

echo "[phase1] Orchestrator shadow mode started."
echo "[phase1] Monitor: journalctl -u orchestrator -f"
echo "[phase1] Look for lines: [orchestrator/dry-run] would execute task ..."
echo "[phase1] Run validation: $REPO/services/orchestrator/scripts/e2e-validate.sh phase1"
