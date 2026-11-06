#!/usr/bin/env bash
# Installs what `npm run docs` needs on a GitHub Actions Ubuntu runner: Graphviz (for the graphs)
# from apt, and Doxygen from its official release, since Ubuntu's package (1.9.8) is too old to
# draw the design docs' Mermaid diagrams. The release is checked against its published SHA-256
# before it is unpacked. Used by .github/workflows/ci.yml (docs) and pages.yml.
set -euo pipefail

DOXYGEN_VERSION=1.18.0
DOXYGEN_SHA256=14fa81bdc34171edb5f1f02b1d60e74802f0439b77fa44e592565d517d72df90

sudo apt-get update
sudo apt-get install -y --no-install-recommends graphviz

dest="${RUNNER_TEMP:-/tmp}/doxygen"
mkdir -p "$dest"
archive="$dest/doxygen.tar.gz"
curl -fsSL --retry 3 -o "$archive" \
  "https://github.com/doxygen/doxygen/releases/download/Release_${DOXYGEN_VERSION//./_}/doxygen-${DOXYGEN_VERSION}.linux.bin.tar.gz"
echo "${DOXYGEN_SHA256}  ${archive}" | sha256sum -c -
tar -xzf "$archive" -C "$dest"
bin="$dest/doxygen-${DOXYGEN_VERSION}/bin"
"$bin/doxygen" --version
dot -V
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
