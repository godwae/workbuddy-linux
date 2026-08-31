#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

detect_package_format() {
    # Determine the distro's *native* package family from /etc/os-release
    # first. A pure tool-availability check is wrong here: Fedora/RHEL boxes
    # often have dpkg pulled in as a dependency of other tooling, and the
    # old dpkg-first order would then build a .deb on an RPM system
    # (reported on Fedora 44). PACKAGE_FORMAT= still overrides everything.
    local os_release="/etc/os-release"
    if [ -r "$os_release" ]; then
        local distro_id distro_like
        distro_id="$(. "$os_release" && printf '%s' "${ID:-}")"
        distro_like="$(. "$os_release" && printf '%s' "${ID_LIKE:-}")"
        case "$distro_like $distro_id" in
            *debian*|*ubuntu*|*mint*)
                if command -v dpkg-deb >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
                    echo "deb"
                    return 0
                fi
                ;;
            *fedora*|*rhel*|*centos*|*suse*|*opensuse*)
                if command -v rpmbuild >/dev/null 2>&1; then
                    echo "rpm"
                    return 0
                fi
                ;;
            *arch*|*manjaro*|*cachyos*)
                if command -v makepkg >/dev/null 2>&1; then
                    echo "pacman"
                    return 0
                fi
                ;;
        esac
    fi

    # Fallback: tool-availability heuristic (original order).
    if command -v dpkg-deb >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
        echo "deb"
    elif command -v rpmbuild >/dev/null 2>&1; then
        echo "rpm"
    elif command -v makepkg >/dev/null 2>&1; then
        echo "pacman"
    else
        error "Could not detect a supported package builder. Install dpkg-deb, rpmbuild, or makepkg."
    fi
}

case "${PACKAGE_FORMAT:-$(detect_package_format)}" in
    deb) bash "$REPO_DIR/scripts/build-deb.sh" ;;
    rpm) bash "$REPO_DIR/scripts/build-rpm.sh" ;;
    pacman|pkg.tar.zst) bash "$REPO_DIR/scripts/build-pacman.sh" ;;
    *) error "Unsupported PACKAGE_FORMAT: ${PACKAGE_FORMAT}" ;;
esac
