#!/bin/bash
# Git pull tous les projets - toutes les heures
REPOS=(
  "/home/openclaw/projects/champion-spirit/api"
  "/home/openclaw/projects/champion-spirit/app"
  "/home/openclaw/projects/champion-spirit/docker"
  "/home/openclaw/projects/afdex"
  "/home/openclaw/projects/trading-bot"
  "/home/openclaw/projects/stho/api"
  "/home/openclaw/projects/stho/web"
  "/home/openclaw/projects/stho/infra"
)

ERRORS=""

for repo in "${REPOS[@]}"; do
  name=$(basename $(dirname "$repo"))/$(basename "$repo")
  if [ -d "$repo/.git" ]; then
    output=$(cd "$repo" && git pull 2>&1)
    exit_code=$?
    if [ $exit_code -ne 0 ]; then
      ERRORS="$ERRORS\n❌ $name: $output"
    fi
  elif [ -d "$repo/../.git" ]; then
    parent=$(dirname "$repo")
    name=$(basename "$parent")
    output=$(cd "$parent" && git pull 2>&1)
    exit_code=$?
    if [ $exit_code -ne 0 ]; then
      ERRORS="$ERRORS\n❌ $name: $output"
    fi
  else
    ERRORS="$ERRORS\n⚠️  $name: pas de repo git"
  fi
done

if [ -n "$ERRORS" ]; then
  echo "ALERT:$ERRORS"
  exit 1
else
  echo "OK"
  exit 0
fi
