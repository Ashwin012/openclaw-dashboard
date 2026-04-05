#!/bin/bash
# Rollback Phase 2 — Stop orchestrator, restart task-worker
set -e

echo "[rollback-phase2] Stopping orchestrator..."
systemctl stop orchestrator 2>/dev/null || true

echo "[rollback-phase2] Restarting task-worker..."
systemctl enable task-worker
systemctl start task-worker

echo "[rollback-phase2] Done. task-worker active, orchestrator stopped."
echo "[rollback-phase2] Verify: systemctl status task-worker"
