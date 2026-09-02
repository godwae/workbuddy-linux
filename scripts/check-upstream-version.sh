#!/bin/bash
set -euo pipefail

# 查询 WorkBuddy 官方最新版本，与本地已移植版本对比。
#
# 背景：workbuddy-linux 禁用了应用内"检查更新"（上游更新器依赖 macOS ShipIt /
# Windows Squirrel 安装器，在 Linux 上不可用）。但 WorkBuddy 的升级查询接口是公开的：
#   GET https://copilot.tencent.com/v2/update?platform=<platform>&version=<ver>
# 该接口无需登录，直接返回可升级目标包的 version / productVersion 等字段。
# 本脚本只输出官方版本号，不输出 DMG 下载直链，请前往官网获取。
#
# ⚠️ 关于 version 参数（2026-09 实测修正）：
#   该接口是"增量升级查询"，语义为「从 version 升级到哪个版本」，不是「返回最新发布版」。
#     version=<真实版本>  → 返回该版本可升级到的目标包
#     version=<已是最新>  → 返回空响应（表示无可用更新）
#     version=0.0.0       → 服务端匹配不到有效基准，回落到一个久未更新的兜底包
#                           （实测返回 5.3.14，而当时实际最新为 5.4.7）
#   早期版本的应用内升级模块曾以 version=0.0.0 拉取最新包，本脚本沿用了该写法，
#   导致官方更新通道变动后一直误报旧版本。现改为传入真实的本地版本作为基准。
#
# 由于官方并未发布 Linux 构建（workbuddy-linux / workbuddy-linux-x64 均返回
# "invalid platform"），本脚本跟踪官方 macOS（Intel x64）DMG 发布通道——
# 这正是 workbuddy-linux 移植所基于的上游来源；ARM 机型可改用
# WORKBUDDY_UPDATE_PLATFORM=workbuddy-darwin-arm64。
#
# 用法：
#   bash scripts/check-upstream-version.sh            # 自动读取本地版本
#   bash scripts/check-upstream-version.sh 5.4.5      # 手动指定本地版本
#   make check-update                                 # 等价于第一种
#   WORKBUDDY_UPDATE_PLATFORM=workbuddy-darwin-arm64 make check-update
#   WORKBUDDY_UPDATE_BASE_VERSION=5.3.14 make check-update  # 指定查询基准版本
#
# 退出码：
#   0 = 已是最新版本
#   1 = 官方发布了新版本（见 stdout 升级路径）
#   2 = 查询失败（网络/解析/平台错误）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UPGRADE_ENDPOINT="${WORKBUDDY_UPGRADE_ENDPOINT:-https://copilot.tencent.com/v2/update}"
UPDATE_PLATFORM="${WORKBUDDY_UPDATE_PLATFORM:-workbuddy-darwin-x64}"

info() { echo "[check-update] $*"; }
error() { echo "[check-update] 错误: $*" >&2; }

read_local_version() {
    local f="${1:-}"
    [ -z "$f" ] || [ ! -f "$f" ] && return 1
    python3 - "$f" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(json.load(fh).get("upstreamVersion", ""))
except Exception:
    pass
PY
}

resolve_local_version() {
    local v="${1:-}"
    if [ -n "$v" ]; then
        echo "$v"
        return 0
    fi
    # 依次尝试本地构建、/opt 安装版、各发行版打包根目录下的 build-info.json
    v="$(read_local_version "$REPO_DIR/workbuddy-app/.workbuddy-linux/build-info.json")"
    [ -n "$v" ] || v="$(read_local_version "/opt/workbuddy/.workbuddy-linux/build-info.json")"
    [ -n "$v" ] || v="$(read_local_version "$REPO_DIR/dist/rpm-root/opt/workbuddy/.workbuddy-linux/build-info.json")"
    [ -n "$v" ] || v="$(read_local_version "$REPO_DIR/dist/deb-root/opt/workbuddy/.workbuddy-linux/build-info.json")"
    if [ -z "$v" ]; then
        error "无法确定本地版本。请先执行 make build-app，或手动指定：bash $0 <版本号>"
        exit 2
    fi
    echo "$v"
}

query_latest() {
    # $1 = 查询基准版本。接口是增量升级查询：传入当前版本，服务端返回可升级到的
    # 目标包；已是最新时返回空响应。切勿传 0.0.0 —— 那会落到一个陈旧的兜底包。
    local base_version="$1"
    curl -sS --max-time 20 -G "$UPGRADE_ENDPOINT" \
        --data-urlencode "platform=$UPDATE_PLATFORM" \
        --data-urlencode "version=$base_version" \
        -H "User-Agent: Mozilla/5.0"
}

main() {
    local local_version base_version resp
    local_version="$(resolve_local_version "${1:-}")"
    # 查询基准默认取本地版本；可用 WORKBUDDY_UPDATE_BASE_VERSION 覆盖以模拟其他版本。
    base_version="${WORKBUDDY_UPDATE_BASE_VERSION:-$local_version}"
    info "本地版本: $local_version"
    info "查询通道: $UPDATE_PLATFORM"
    info "查询基准: $base_version"

    if ! resp="$(query_latest "$base_version")"; then
        error "查询失败（网络不可达或端点拒绝）"
        exit 2
    fi

    # 通过 argv 安全传递 local_version 与原始响应，避免 JSON 中的特殊字符破坏 shell
    python3 - "$local_version" "$resp" <<'PY'
import json, sys

local_version = sys.argv[1]
raw = sys.argv[2]

def parse_ver(v):
    parts = []
    for p in str(v).split('.'):
        try:
            parts.append(int(p))
        except ValueError:
            break
    return parts

def cmp_tuple(a, b):
    n = max(len(a), len(b))
    a = (a + [0] * n)[:n]
    b = (b + [0] * n)[:n]
    return (a > b) - (a < b)

try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}

if not data:
    # 增量升级接口在「基准版本已是最新」时返回空响应。
    print("[check-update] 已是最新版本（官方未返回比 %s 更新的更新包）" % local_version)
    sys.exit(0)

if 'code' in data and 'version' not in data:
    print("[check-update] 错误: 接口返回 %s - %s" % (data.get('code'), data.get('msg', '')),
          file=sys.stderr)
    sys.exit(2)

latest = data.get('version', '')
product = data.get('productVersion', latest)

local_rel = parse_ver(local_version)[:3]
latest_rel = parse_ver(latest)[:3]

# 防御：若基准版本传的是 0.0.0 之类的无效值，服务端会回落到陈旧兜底包，
# 表现为「返回的 version 反而比本地版本旧」。这种情况不能判为已是最新。
if cmp_tuple(latest_rel, local_rel) < 0:
    print("[check-update] 警告: 接口返回版本 %s 比本地版本 %s 更旧，"
          % (latest, local_version), file=sys.stderr)
    print("[check-update]       查询基准版本可能无效（例如 0.0.0 会命中服务端兜底包）。",
          file=sys.stderr)
    print("[check-update]       请用 WORKBUDDY_UPDATE_BASE_VERSION 指定有效基准版本后重试。",
          file=sys.stderr)
    sys.exit(2)

if cmp_tuple(latest_rel, local_rel) > 0:
    print("[check-update] 官方已发布新版本: %s" % latest)
    if product and product != latest:
        print("[check-update] 产品版本: %s" % product)
    print("[check-update] 请前往官网下载新版 macOS DMG 放入 downloads/ 后执行:")
    print("[check-update]   make build-app && make package && make install")
    sys.exit(1)

print("[check-update] 已是最新版本（官方最新: %d.%d.%d）" % tuple(latest_rel[:3]))
sys.exit(0)
PY
}

main "$@"
