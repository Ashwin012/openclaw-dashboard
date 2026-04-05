#!/bin/bash
# Phase 3 — Final cleanup: remove task-worker artifacts
# Prerequisites: Phase 2 validated (7+ days stable), no rollback needed
# Run as root or with sudo
set -e

REPO=/home/openclaw/projects/dev-dashboard

echo "[phase3] WARNING: This is irreversible. task-worker files will be removed."
read -p "[phase3] Type YES to confirm: " CONFIRM
[ "$CONFIRM" = "YES" ] || { echo "Aborted."; exit 1; }

# Remove systemd service file
rm -f /etc/systemd/system/task-worker.service
systemctl daemon-reload

# Archive task-worker source (keep in git history, remove from working tree)
echo "[phase3] Removing task-worker.js and backups..."
cd "$REPO"
git rm -f task-worker.js task-worker.legacy.js task-worker.js.bak-* 2>/dev/null || \
  rm -f task-worker.js task-worker.legacy.js task-worker.js.bak-*

echo "[phase3] Cleanup complete."
echo "[phase3] Next: git commit -m 'chore: remove task-worker (replaced by orchestrator)'"
echo "[phase3] Update AGENT.md — remove task-worker from stack"
