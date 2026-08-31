#!/bin/bash
# Shared shell helpers. Sourced by scripts; do not run directly.

info() {
    echo "[INFO] $*" >&2
}

warn() {
    echo "[WARN] $*" >&2
}

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || error "Missing required command: $1"
}

# ---------------------------------------------------------------------------
# detect_package_family
#
# Decide which native package format this distro should build/install.
# The distro's *native* family is determined from /etc/os-release first:
# Fedora/RHEL boxes often have dpkg pulled in as a dependency of other
# tooling, and a pure tool-availability check would then build/install a
# .deb on an RPM system. Fall back to tool availability only when the
# os-release family is unrecognised.
#
# Prints: deb | rpm | pacman, or nothing if undetermined.
# ---------------------------------------------------------------------------
os_release_family() {
    local distro_id distro_like
    if [ -r /etc/os-release ]; then
        distro_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
        distro_like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
    fi
    case "$distro_like $distro_id" in
        *debian*|*ubuntu*|*mint*) echo "deb" ;;
        *fedora*|*rhel*|*centos*|*suse*|*opensuse*) echo "rpm" ;;
        *arch*|*manjaro*|*cachyos*) echo "pacman" ;;
    esac
}

available_tool_family() {
    if command -v dpkg-deb >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
        echo "deb"
    elif command -v rpmbuild >/dev/null 2>&1; then
        echo "rpm"
    elif command -v makepkg >/dev/null 2>&1; then
        echo "pacman"
    fi
}

detect_package_family() {
    local by_id
    by_id="$(os_release_family)"
    [ -n "$by_id" ] && { echo "$by_id"; return 0; }
    available_tool_family
}

find_7z() {
    if command -v 7zz >/dev/null 2>&1; then
        command -v 7zz
        return 0
    fi
    if command -v 7z >/dev/null 2>&1; then
        local version_output major_version
        version_output="$(7z -version 2>&1 || true)"
        if [[ "$version_output" =~ 7-Zip\ (\[[0-9]+\]\ )?([0-9]+)\. ]]; then
            major_version="${BASH_REMATCH[2]}"
            if [ "$major_version" -lt 21 ]; then
                error "Found legacy p7zip (version $major_version), which cannot extract modern DMG files properly.
Please install the official 7zip package (version >= 21) instead:
  Debian/Ubuntu: sudo apt install 7zip (remove p7zip-full first)
  Fedora/RHEL:   sudo dnf install 7zip
  Arch Linux:    sudo pacman -S 7zip
  openSUSE:      sudo zypper install 7zip"
            fi
        fi
        command -v 7z
        return 0
    fi
    error "Missing 7z/7zz. Install 7zip."
}
