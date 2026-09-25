#!/usr/bin/env bash
# Install pinned, checksummed per-repository tools without changing system defaults.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD/.tools"
mkdir -p "$root/downloads" "$root/node" "$root/gvisor" "$root/bin"
cd "$root/downloads"
node_version=22.23.3
node_archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/$node_archive" -o "$node_archive"
curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o node-SHASUMS256.txt
awk -v f="$node_archive" '$2 == f' node-SHASUMS256.txt | sha256sum --check --strict
tar -xf "$node_archive" --strip-components=1 -C "$root/node"
export PATH="$root/node/bin:$PATH"
npm install --prefix "$root/pnpm" --no-audit --no-fund --ignore-scripts pnpm@10.33.0
ln -sfn ../node/bin/node "$root/bin/node"
ln -sfn ../pnpm/node_modules/pnpm/bin/pnpm.cjs "$root/bin/pnpm"
gvisor_url=https://storage.googleapis.com/gvisor/releases/release/20260921.0/x86_64
curl --fail --silent --show-error --location "$gvisor_url/gvisor.tar.bz2" -o gvisor.tar.bz2
curl --fail --silent --show-error --location "$gvisor_url/gvisor.tar.bz2.sha512" -o gvisor.tar.bz2.sha512
sha512sum --check gvisor.tar.bz2.sha512
tar -xjf gvisor.tar.bz2 -C "$root/gvisor"
ln -sfn ../gvisor/runsc "$root/bin/runsc"
"$root/bin/node" --version
"$root/bin/pnpm" --version
"$root/bin/runsc" --version
