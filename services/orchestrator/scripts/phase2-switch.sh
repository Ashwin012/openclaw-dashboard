#!/bin/bash
# Phase 2 — Active switch: stop task-worker, start orchestrator in live mode
# Prerequisites: Phase 1 validated (24-48h shadow), orchestrator.service installed
# Run as root or with sudo
set -e

REPO=/home/openclaw/projects/dev-dashboard
SERVICE_DST=/etc/systemd/system/orchestrator.service

echo "[phase2] Switching task-worker → orchestrator..."

# Remove DRY_RUN flag if still present (phase1 may have injected it)
sed -i '/^Environment=DRY_RUN/d' "$SERVICE_DST"

systemctl daemon-reload

# Stop task-worker first
echo "[phase2] Stopping task-worker..."
systemctl stop task-worker
systemctl disable task-worker

# Start orchestrator in live mode
echo "[phase2] Starting orchestrator (live)..."
systemctl restart orchestrator

echo "[phase2] Switch complete."
echo "[phase2] Monitor: journalctl -u orchestrator -f"
echo "[phase2] Rollback if needed: $REPO/services/orchestrator/scripts/rollback-phase2.sh"
echo "[phase2] Run validation: $REPO/services/orchestrator/scripts/e2e-validate.sh phase2"
