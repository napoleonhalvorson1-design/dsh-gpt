#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root with sudo; private environment files are retained.
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo from the repository root.' >&2; exit 1; fi
for file in server/*.mjs shared/*.mjs; do /opt/openhands-control/node --check "$file"; done
install -d -m 755 /opt/openhands-control/server /opt/openhands-control/shared
install -m 644 server/*.mjs /opt/openhands-control/server/
install -m 644 server/handoff.py server/dsh-trace.py server/delivery-check.py server/stream-plan.py server/text_merge.py /opt/openhands-control/server/
install -m 644 shared/*.mjs shared/*.json /opt/openhands-control/shared/
install -m 755 bin/canvas.mjs /opt/openhands-control/bin/canvas.mjs
install -d -m 755 /opt/openhands-control/ops
install -m 755 ops/configure-qicai-s3.py /opt/openhands-control/ops/configure-qicai-s3.py
install -m 755 ops/handoff-fast.py ops/install-fast-handoff.mjs ops/acp-policy.py ops/install-execution-policy.mjs /opt/openhands-control/ops/
install -m 755 ops/probe-codex-context.py /opt/openhands-control/ops/
systemctl restart openhands-control
systemctl is-active openhands-control
