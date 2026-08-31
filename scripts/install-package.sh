#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

latest_artifact() {
    local pattern="$1"
    [ -d "$REPO_DIR/dist" ] || return 0
    find "$REPO_DIR/dist" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' 2>/dev/null \
        | sort -nr \
        | awk 'NR == 1 { sub(/^[^ ]+ /, ""); print }'
}

install_deb() {
    local artifact
    artifact="$(latest_artifact 'workbuddy_*.deb')"
    [ -n "$artifact" ] || return 1
    info "Installing $artifact"
    sudo dpkg -i "$artifact"
}

install_rpm() {
    local artifact
    artifact="$(latest_artifact 'workbuddy-*.rpm')"
    [ -n "$artifact" ] || return 1
    info "Installing $artifact"
    if command -v dnf5 >/dev/null 2>&1; then
        sudo dnf5 install -y "$artifact"
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y "$artifact"
    elif command -v zypper >/dev/null 2>&1; then
        sudo zypper --non-interactive --no-gpg-checks install "$artifact"
    else
        return 1
    fi
}

install_pacman() {
    local artifact
    artifact="$(latest_artifact 'workbuddy-*.pkg.tar.zst')"
    [ -n "$artifact" ] || return 1
    command -v pacman >/dev/null 2>&1 || return 1
    info "Installing $artifact"
    sudo pacman -U --noconfirm "$artifact"
}

main() {
    local family

    # Prefer the distro's native family (from /etc/os-release) so a Fedora
    # box that happens to have dpkg installed doesn't get a stale .deb from
    # dist/ installed over the real .rpm.
    family="$(detect_package_family)"

    case "$family" in
        deb)
            install_deb && return 0
            ;;
        rpm)
            install_rpm && return 0
            ;;
        pacman)
            install_pacman && return 0
            ;;
    esac

    # Neither the distro family nor a matching tool was recognised. Fall
    # back to whatever artifact actually exists in dist/.
    install_deb && return 0
    install_rpm && return 0
    install_pacman && return 0

    error "No installable package artifact found in dist/. Run make package first."
}

main "$@"
