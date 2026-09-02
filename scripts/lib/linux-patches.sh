#!/bin/bash
# Linux-specific post-copy patches applied to the packed app.asar.
#
# Fix 1 — "no window appears on launch" (E2BIG):
#   The main process stores a ~260KB product configuration JSON into the
#   environment variable ACC_PRODUCT_CONFIG_V3. Linux's MAX_ARG_STRLEN cap
#   (128KB per env string) then causes every execve() to fail with E2BIG,
#   including Chromium's internal /proc/self/exe spawn for the network
#   service and utility processes. Without those child processes the
#   renderer cannot start and the main window never shows.
#
#   We install a tiny shim at the top of main/index.js that intercepts
#   writes to ACC_PRODUCT_CONFIG_V3 / ACC_PRODUCT_CONFIG_V2 via
#   Object.defineProperty on process.env. The value is kept in a JS slot
#   only — libc setenv is never called, so execve() stays well under the
#   per-string limit while JS code still observes the same values.
#
# Fix 2 — "tray icon menu is empty":
#   On Linux, Electron's Tray is backed by libayatana-appindicator. The
#   indicator never emits the `click` / `right-click` events the upstream
#   code relies on, and only renders a menu that has been attached via
#   tray.setContextMenu(...). We inject that call right after the Tray is
#   constructed so the "显示窗口 / 退出" menu actually appears.
#
# Fix 3 — "tray icon is a missing-image placeholder" (exclamation mark):
#   Upstream hands the Tray a resized in-memory NativeImage. The
#   AppIndicator backend can't re-read those bytes through GTK so the
#   indicator shows its "broken image" fallback. We patch the Tray
#   construction on Linux to use the on-disk PNG at
#   <install-dir>/.workbuddy-linux/workbuddy.png (written by install.sh
#   and shipped inside the generated .deb/.rpm/.pkg.tar.zst under
#   /opt/<app>/.workbuddy-linux/).
#
# Fix 4 — "Check for Updates..." entry and updater RPCs:
#   The upstream updater drives the macOS ShipIt / Windows Squirrel
#   installers, neither of which applies on a Linux port. The update menu
#   entry is greyed out (only when upstream still ships one — WorkBuddy
#   5.3.x removed it entirely), the update* RPCs are stubbed, and
#   UpdateServiceLinux.checkForUpdates is short-circuited so the periodic
#   background check never hits the update feed.
#
# Fix 5 — window control buttons (兜底):
#   上游非 macOS 平台自带 <WindowControls/>，无条件注入会重复。
#   WORKBUDDY_WINCTRL: auto（默认，上游容器存在即跳过/自愈移除误注入）/
#   force / off。渲染端走 workbuddyDesktop.window.getCurrentWindow()，
#   不是 buddyAPI（后者只有 telemetry/auth）。
#
# Fix 8 — drag 区守卫:
#   drag 区按命中测试判定，落入区内的按下会被判为拖窗并吞掉 click——
#   控件"能 hover 但点不动"。上游规避只覆盖 .workbuddy-topbar，Linux 上
#   还有两处未覆盖：36px ::before 拖拽条（:not([data-platform]) 兜底，
#   Linux 属性缺失而永久命中，拖拽区达 y=0..66）和菜单栏本身。修复：
#   给 Linux 设专属 data-platform="linux"（Linux 样式走 :not(mac):not(windows)
#   仍命中，无应用 JS 读该属性）；菜单栏仅在指针位于其空白区域时可拖拽。
#
# Anchoring:
#   Every patch is anchored on upstream source text, so a bundler upgrade
#   can silently disable one — exactly what happened when WorkBuddy 5.3.x
#   moved the main bundle to esbuild. Each patch now reports
#   applied / skipped / n-a / failed, and the run ends with a summary.
#   Set WB_PATCH_STRICT=1 to make any failure abort the build.
#
# Idempotence:
#   Each patch carries its own marker, so re-running the patcher (or
#   upgrading an older build) applies only what is still missing, instead
#   of skipping everything because the env shim is already present.

LINUX_PATCHES_SHIM_MARKER="__WB_LINUX_PATCHES_V5__"

apply_linux_runtime_patches() {
    local app_dir="$1"
    local asar_path="$app_dir/resources/app.asar"

    [ -f "$asar_path" ] || {
        warn "Linux patches: app.asar not found at $asar_path"
        return 0
    }

    info "=== Applying Linux runtime patches to app.asar ==="

    # The Node helper needs @electron/asar available. Install it into the
    # per-build WORK_DIR so we don't pollute the project with a persistent
    # node_modules tree.
    local asar_tool_dir="$WORK_DIR/asar-tool"
    if [ ! -x "$asar_tool_dir/node_modules/.bin/asar" ]; then
        info "  Installing @electron/asar for patcher"
        mkdir -p "$asar_tool_dir"
        (
            cd "$asar_tool_dir"
            npm init -y >/dev/null 2>&1
            npm install @electron/asar --no-audit --no-fund --silent 2>&1
        ) || {
            warn "  Failed to install @electron/asar; skipping Linux patches"
            return 0
        }
    fi

    NODE_PATH="$asar_tool_dir/node_modules" \
        node "$SCRIPT_DIR/scripts/lib/apply-linux-patches.js" \
             "$asar_path" \
             "$LINUX_PATCHES_SHIM_MARKER" \
        || {
        warn "  Failed to apply Linux patches; leaving app.asar untouched"
        return 0
    }
    info "  Linux runtime patches applied successfully"
}
