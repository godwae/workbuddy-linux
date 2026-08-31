#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

# Route to the native package builder. The distro family is determined from
# /etc/os-release first — a pure tool-availability check is wrong here:
# Fedora/RHEL boxes often have dpkg pulled in as a dependency of other
# tooling, and a dpkg-first order would then build a .deb on an RPM system
# (reported on Fedora 44). PACKAGE_FORMAT= still overrides everything.
PACKAGE_FORMAT="${PACKAGE_FORMAT:-$(detect_package_family)}"

case "$PACKAGE_FORMAT" in
    deb) bash "$REPO_DIR/scripts/build-deb.sh" ;;
    rpm) bash "$REPO_DIR/scripts/build-rpm.sh" ;;
    pacman|pkg.tar.zst) bash "$REPO_DIR/scripts/build-pacman.sh" ;;
    *)
        error "Unsupported PACKAGE_FORMAT: ${PACKAGE_FORMAT}. Install dpkg-deb, rpmbuild, or makepkg."
        ;;
esac
