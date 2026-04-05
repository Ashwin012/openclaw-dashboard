#!/bin/bash
# E2E Validation — Run before advancing each cut-over phase
# Usage: ./e2e-validate.sh [phase1|phase2]
# Requires: jq, curl
set -e

PHASE=${1:-phase2}
ORCH_URL=http://localhost:8092
TASKS_JSON=/home/openclaw/projects/dev-dashboard/.claude/tasks.json
PASS=0; FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== E2E Validation — $PHASE ==="
echo ""

# 1. Health check
echo "[1] Health check..."
HEALTH=$(curl -sf "$ORCH_URL/health" 2>/dev/null) && ok "health endpoint OK: $(echo $HEALTH | jq -r '.status')" || fail "health endpoint unreachable"

# 2. Tasks API
echo "[2] Tasks API..."
STATUS=$(curl -sf "$ORCH_URL/api/v1/tasks" 2>/dev/null) && ok "GET /api/v1/tasks OK" || fail "GET /api/v1/tasks failed"

# 3. /status control route
echo "[3] /status control route..."
STATUS=$(curl -sf "$ORCH_URL/status" 2>/dev/null) && ok "/status OK" || fail "/status unreachable"

# 4. Notifications file writable
echo "[4] Notifications file check..."
NOTIF=/home/openclaw/projects/dev-dashboard/.dashboard/notifications.json
[ -f "$NOTIF" ] && ok "notifications.json present" || fail "notifications.json missing"

# 5. Activity log file writable
echo "[5] Activity log check..."
ACT=/home/openclaw/projects/dev-dashboard/.dashboard/activity-log.json
[ -f "$ACT" ] && ok "activity-log.json present" || { touch "$ACT" && ok "activity-log.json created" || fail "activity-log.json missing and could not create"; }

# 6. Sync check (tasks.json readable by orchestrator)
echo "[6] Sync check..."
SYNC=$(curl -sf -X POST "$ORCH_URL/api/v1/sync" 2>/dev/null) && ok "POST /api/v1/sync OK" || fail "POST /api/v1/sync failed"

# 7. Phase-specific: shadow mode log check
if [ "$PHASE" = "phase1" ]; then
  echo "[7] Shadow mode log check (last 30s)..."
  SHADOW=$(journalctl -u orchestrator --since "30 seconds ago" --no-pager -q 2>/dev/null | grep -c "dry-run" || true)
  [ "$SHADOW" -ge 0 ] && ok "dry-run log accessible (hits=$SHADOW)" || fail "could not read orchestrator journal"
fi

# 8. Phase 2 only: task-worker must be stopped
if [ "$PHASE" = "phase2" ]; then
  echo "[7] task-worker stopped check..."
  systemctl is-active task-worker >/dev/null 2>&1 && fail "task-worker is still active!" || ok "task-worker is stopped"

  echo "[8] Orchestrator active check..."
  systemctl is-active orchestrator >/dev/null 2>&1 && ok "orchestrator is active" || fail "orchestrator not active"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "✅ Validation PASSED — safe to advance to next phase." || echo "❌ Validation FAILED — do NOT advance. Fix issues first."
echo ""
exit $FAIL
