#!/usr/bin/env bash
# Privileged final step after install-local-tools.sh has downloaded/verified the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $EUID -ne 0 ]]; then
  echo 'Run: sudo bash scripts/install-gvisor-system.sh' >&2
  exit 1
fi
root="$PWD/.tools"
(cd "$root/downloads" && sha512sum --check gvisor.tar.bz2.sha512)
# Re-extract the verified archive as root instead of trusting editable extracted files.
install -d -m 0755 /usr/local/lib/redai-gvisor-20260921.0
tar -xjf "$root/downloads/gvisor.tar.bz2" -C /usr/local/lib/redai-gvisor-20260921.0
/usr/local/lib/redai-gvisor-20260921.0/runsc install --runtime=redai-runsc
systemctl reload docker
/usr/local/lib/redai-gvisor-20260921.0/runsc --version
printf 'Registered Docker runtime redai-runsc. Default runtime was not changed.\n'
