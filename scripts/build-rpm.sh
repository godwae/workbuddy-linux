#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
PKG_ROOT="${PKG_ROOT:-$DIST_DIR/rpm-root}"
PACKAGE_NAME="${PACKAGE_NAME:-workbuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
RPM_VERSION="${PACKAGE_VERSION//+/_}"
RPM_VERSION="${RPM_VERSION//-/_}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"
SPEC_FILE="$DIST_DIR/$PACKAGE_NAME.spec"

map_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        *) error "Unsupported RPM architecture: $(uname -m)" ;;
    esac
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run make build-app first."
    require_cmd rpmbuild

    local arch output_dir output_file
    arch="$(map_arch)"
    output_dir="$DIST_DIR/rpmbuild"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${RPM_VERSION}-1.${arch}.rpm"

    rm -rf "$PKG_ROOT" "$output_dir"
    mkdir -p \
        "$PKG_ROOT/opt/$PACKAGE_NAME" \
        "$PKG_ROOT/usr/bin" \
        "$PKG_ROOT/usr/share/applications" \
        "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps" \
        "$output_dir/BUILD" "$output_dir/RPMS" "$output_dir/SOURCES" "$output_dir/SPECS" "$output_dir/SRPMS"

    cp -a "$APP_DIR/." "$PKG_ROOT/opt/$PACKAGE_NAME/"

    # Set SUID bit on chrome-sandbox so Chromium can spawn child processes
    if [ -f "$PKG_ROOT/opt/$PACKAGE_NAME/chrome-sandbox" ]; then
        chmod 4755 "$PKG_ROOT/opt/$PACKAGE_NAME/chrome-sandbox"
    fi
    cat > "$PKG_ROOT/usr/bin/$PACKAGE_NAME" <<EOF
#!/bin/bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
EOF
    chmod 0755 "$PKG_ROOT/usr/bin/$PACKAGE_NAME"

    sed -e "s|__EXEC__|/opt/$PACKAGE_NAME/start.sh %F|g" "$DESKTOP_TEMPLATE" \
        > "$PKG_ROOT/usr/share/applications/$PACKAGE_NAME.desktop"

    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    local icon_files_entry=""
    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        icon_files_entry="/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    cat > "$SPEC_FILE" <<EOF
# /opt/$PACKAGE_NAME is a self-contained upstream Electron bundle, so the
# usual Fedora QA passes do more harm than good here:
#
#   check-rpaths — any rpath baked in by the build machine's toolchain
#     (conda-forge gcc injects -Wl,-rpath,<prefix>/lib) is reported as
#     "ERROR 0002: invalid rpath" and aborts the build, even though the
#     value is meaningless once the package is installed.
#   brp-strip — upstream ships prebuilt .node payloads for arm64, armhf,
#     riscv64, musl and FreeBSD; strip(1) cannot parse them and floods
#     the log with "Unable to recognise the architecture".
#   debug_package — would try to build a debuginfo subpackage from an
#     800MB prebuilt bundle.
%global __brp_check_rpaths %{nil}
%global __brp_strip %{nil}
%global __brp_strip_comment_note %{nil}
%global __brp_strip_static_archive %{nil}
%global debug_package %{nil}

# Exclude bundled multi-platform binaries from automatic dependency scanning.
# The app ships Electron runtimes for armhf, loongarch, riscv64, FreeBSD, and
# musl — their library deps are not resolvable on a standard Linux system.
# System-level dependencies are listed explicitly in Requires: below.
%global __requires_exclude_from ^/opt/$PACKAGE_NAME/.*$

Name: $PACKAGE_NAME
Version: $RPM_VERSION
Release: 1%{?dist}
Summary: Unofficial local Linux conversion of WorkBuddy
License: MIT
BuildArch: $arch
Requires: gtk3, nss, libXScrnSaver, alsa-lib, libsecret, libxkbfile

%description
This package is generated locally from a user-owned official WorkBuddy
macOS copy. It does not redistribute upstream software through the source
repository.

%install
mkdir -p %{buildroot}
cp -a $PKG_ROOT/. %{buildroot}/

%files
/opt/$PACKAGE_NAME
/usr/bin/$PACKAGE_NAME
/usr/share/applications/$PACKAGE_NAME.desktop
$icon_files_entry
EOF

    rpmbuild --define "_topdir $output_dir" --define "_build_id_links none" -bb "$SPEC_FILE" >&2
    mkdir -p "$DIST_DIR"
    find "$output_dir/RPMS" -type f -name "*.rpm" -exec cp {} "$output_file" \;
    [ -f "$output_file" ] || error "RPM was not produced"
    info "Built package: $output_file"
}

main "$@"
