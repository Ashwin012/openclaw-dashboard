#!/bin/bash
# Rollback Phase 1 — Stop and remove orchestrator shadow service
set -e

echo "[rollback-phase1] Stopping orchestrator..."
systemctl stop orchestrator 2>/dev/null || true
systemctl disable orchestrator 2>/dev/null || true
rm -f /etc/systemd/system/orchestrator.service
systemctl daemon-reload

echo "[rollback-phase1] Done. Orchestrator removed. task-worker state unchanged."
