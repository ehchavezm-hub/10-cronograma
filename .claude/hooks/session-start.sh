#!/bin/bash
set -euo pipefail

# Only run in Claude Code cloud sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "=== Session start hook: 10-cronograma ==="

# Verify Python 3 is available (used as local dev server)
if ! command -v python3 &>/dev/null; then
  echo "WARNING: python3 not found — 'python3 -m http.server' won't work"
else
  echo "✓ python3 $(python3 --version 2>&1)"
fi

# Verify Node.js is available (used for JS syntax validation)
if ! command -v node &>/dev/null; then
  echo "WARNING: node not found — JS syntax check skipped"
else
  echo "✓ node $(node --version)"
fi

echo "=== Setup complete ==="
