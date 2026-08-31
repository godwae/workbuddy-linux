#!/bin/bash
set -Eeuo pipefail

MIN_NODE_MAJOR=20
NODEJS_MAJOR="${NODEJS_MAJOR:-22}"

info() {
    echo "[INFO] $*"
}

warn() {
    echo "[WARN] $*" >&2
}

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

detect_distro() {
    # Prefer the distro's native package manager from /etc/os-release, not
    # raw tool availability: Fedora/RHEL boxes often have apt-get installed
    # as a dependency of other tooling, and an apt-first order would then
    # try to install Debian package names (libx11-dev, libxkbfile-dev, …)
    # that do not exist on RPM systems. Fall back to tool availability only
    # when the os-release family is unrecognised.
    local distro_id distro_like manager
    manager=""

    if [ -r /etc/os-release ]; then
        distro_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
        distro_like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
        case "$distro_like $distro_id" in
            *debian*|*ubuntu*|*mint*) manager="apt" ;;
            *fedora*|*rhel*|*centos*)
                if command -v dnf5 >/dev/null 2>&1; then
                    manager="dnf5"
                elif command -v dnf >/dev/null 2>&1; then
                    manager="dnf"
                fi
                ;;
            *suse*|*opensuse*) manager="zypper" ;;
            *arch*|*manjaro*|*cachyos*) manager="pacman" ;;
        esac
    fi

    if [ -z "$manager" ]; then
        if command -v dnf5 >/dev/null 2>&1; then
            manager="dnf5"
        elif command -v dnf >/dev/null 2>&1; then
            manager="dnf"
        elif command -v pacman >/dev/null 2>&1; then
            manager="pacman"
        elif command -v zypper >/dev/null 2>&1; then
            manager="zypper"
        elif command -v apt-get >/dev/null 2>&1; then
            manager="apt"
        fi
    fi

    [ -n "$manager" ] && echo "$manager" || echo "unknown"
}

node_major() {
    local version major

    command -v node >/dev/null 2>&1 || return 1
    version="$(node -v 2>/dev/null || true)"
    major="${version#v}"
    major="${major%%.*}"

    case "$major" in
        ""|*[!0-9]*) return 1 ;;
        *) echo "$major" ;;
    esac
}

has_compatible_nodejs() {
    local major

    major="$(node_major 2>/dev/null || true)"
    [ -n "$major" ] \
        && [ "$major" -ge "$MIN_NODE_MAJOR" ] \
        && command -v npm >/dev/null 2>&1 \
        && command -v npx >/dev/null 2>&1
}

validate_nodejs_major() {
    case "$NODEJS_MAJOR" in
        ""|*[!0-9]*)
            error "NODEJS_MAJOR must be numeric, for example: NODEJS_MAJOR=22 bash scripts/install-deps.sh"
            ;;
    esac

    [ "$NODEJS_MAJOR" -ge "$MIN_NODE_MAJOR" ] || error "NODEJS_MAJOR must be >= $MIN_NODE_MAJOR"
}

apt_nodejs_candidate_major() {
    local candidate major=""

    candidate="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }' || true)"
    [ -n "$candidate" ] && [ "$candidate" != "(none)" ] || return 1

    if [[ "$candidate" =~ ^[0-9]+:([0-9]+)\. ]]; then
        major="${BASH_REMATCH[1]}"
    elif [[ "$candidate" =~ ^([0-9]+)\. ]]; then
        major="${BASH_REMATCH[1]}"
    else
        return 1
    fi

    echo "$major"
}

install_nodesource_nodejs() {
    validate_nodejs_major

    local apt_arch keyring source_list tmp_key

    apt_arch="$(dpkg --print-architecture)"
    case "$apt_arch" in
        amd64|arm64|armhf) ;;
        *) error "NodeSource does not support apt architecture: $apt_arch" ;;
    esac

    keyring="/etc/apt/keyrings/nodesource.gpg"
    source_list="/etc/apt/sources.list.d/nodesource.list"
    tmp_key="$(mktemp)"

    info "Installing Node.js ${NODEJS_MAJOR}.x from NodeSource"
    sudo apt-get install -y ca-certificates gnupg
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp_key"
    gpg --dearmor < "$tmp_key" | sudo tee "$keyring" >/dev/null
    rm -f "$tmp_key"
    sudo chmod 0644 "$keyring"

    printf 'deb [arch=%s signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
        "$apt_arch" "$keyring" "$NODEJS_MAJOR" \
        | sudo tee "$source_list" >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y nodejs
}

ensure_apt_nodejs() {
    local major

    if has_compatible_nodejs; then
        info "Node.js toolchain ready: node $(node -v), npm $(npm -v), npx $(npx -v)"
        return 0
    fi

    major="$(apt_nodejs_candidate_major 2>/dev/null || true)"
    if [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
        info "Installing distro Node.js/npm candidate"
        sudo apt-get install -y nodejs npm
    else
        install_nodesource_nodejs
    fi

    has_compatible_nodejs || error "Node.js $MIN_NODE_MAJOR+ with npm/npx is still unavailable"
    info "Node.js toolchain ready: node $(node -v), npm $(npm -v), npx $(npx -v)"
}

ensure_generic_nodejs() {
    if has_compatible_nodejs; then
        info "Node.js toolchain ready: node $(node -v), npm $(npm -v), npx $(npx -v)"
        return 0
    fi

    error "Node.js $MIN_NODE_MAJOR+ with npm and npx is required. Install a supported Node.js package for this distro and re-run this script."
}

install_apt() {
    info "Detected Debian/Ubuntu (apt)"
    sudo apt-get update -qq
    sudo apt-get install -y \
        bash ca-certificates curl unzip 7zip python3 make g++ pkg-config \
        libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev \
        dpkg-dev fakeroot desktop-file-utils icnsutils imagemagick
    ensure_apt_nodejs
}

install_dnf5() {
    info "Detected Fedora 41+ (dnf5)"
    sudo dnf install -y \
        bash curl unzip 7zip python3 nodejs npm make gcc-c++ pkgconf-pkg-config \
        libX11-devel libxkbfile-devel libsecret-devel krb5-devel \
        rpm-build desktop-file-utils ImageMagick
    ensure_generic_nodejs
}

install_dnf() {
    info "Detected Fedora/RHEL (dnf)"
    sudo dnf install -y \
        bash curl unzip 7zip python3 nodejs npm make gcc-c++ pkgconf-pkg-config \
        libX11-devel libxkbfile-devel libsecret-devel krb5-devel \
        rpm-build desktop-file-utils ImageMagick
    ensure_generic_nodejs
}

install_pacman() {
    info "Detected Arch Linux (pacman)"
    sudo pacman -S --needed --noconfirm \
        bash curl unzip 7zip python nodejs npm base-devel zstd fakeroot \
        libx11 libxkbfile libsecret krb5 desktop-file-utils imagemagick
    ensure_generic_nodejs
}

install_zypper() {
    info "Detected openSUSE (zypper)"
    sudo zypper --non-interactive install \
        bash curl unzip 7zip python3 nodejs-default npm-default make gcc-c++ pkg-config \
        libX11-devel libxkbfile-devel libsecret-devel krb5-devel \
        rpm-build desktop-file-utils ImageMagick
    ensure_generic_nodejs
}

main() {
    local distro

    distro="$(detect_distro)"
    case "$distro" in
        apt) install_apt ;;
        dnf5) install_dnf5 ;;
        dnf) install_dnf ;;
        pacman) install_pacman ;;
        zypper) install_zypper ;;
        *)
            error "Unsupported package manager. Install bash, curl, unzip, 7z/7zz, python3, Node.js $MIN_NODE_MAJOR+, npm, npx, make, g++, X11/libxkbfile/libsecret/krb5 development headers, then re-run make build-app."
            ;;
    esac

    info "Dependencies are ready. Next steps:"
    info "  put one official Intel/x64 WorkBuddy DMG in downloads/"
    info "  make build-app"
    info "  make package"
    info "  make install"
}

main "$@"
