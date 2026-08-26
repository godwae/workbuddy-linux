#!/bin/bash
set -euo pipefail

# 查询 WorkBuddy 官方最新版本，与本地已移植版本对比。
#
# 背景：workbuddy-linux 禁用了应用内"检查更新"（上游更新器依赖 macOS ShipIt /
# Windows Squirrel 安装器，在 Linux 上不可用）。但 WorkBuddy 的升级查询接口是公开的：
#   GET https://copilot.tencent.com/v2/update?platform=<platform>&version=<ver>
# 该接口无需登录，直接返回最新发布包的 version / productVersion / url /
# sha256hash 等字段（应用内部升级模块同样调用此接口，其内置示例即使用
# version=0.0.0 拉取最新包）。
#
# 由于官方并未发布 Linux 构建（workbuddy-linux / workbuddy-linux-x64 均返回
# "invalid platform"），本脚本跟踪官方 macOS（Intel x64）DMG 发布通道——
# 这正是 workbuddy-linux 移植所基于的上游来源；ARM 机型可改用
# WORKBUDDY_UPDATE_PLATFORM=workbuddy-darwin-arm64。
#
# 用法：
#   bash scripts/check-upstream-version.sh            # 自动读取本地版本
#   bash scripts/check-upstream-version.sh 5.3.14     # 手动指定本地版本
#   make check-update                                 # 等价于第一种
#   WORKBUDDY_UPDATE_PLATFORM=workbuddy-darwin-arm64 make check-update
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
    # version=0.0.0 触发接口返回当前最新发布包（接口官方示例即采用此值）
    curl -sS --max-time 20 -G "$UPGRADE_ENDPOINT" \
        --data-urlencode "platform=$UPDATE_PLATFORM" \
        --data-urlencode "version=0.0.0" \
        -H "User-Agent: Mozilla/5.0"
}

main() {
    local local_version resp
    local_version="$(resolve_local_version "${1:-}")"
    info "本地版本: $local_version"
    info "查询通道: $UPDATE_PLATFORM"

    if ! resp="$(query_latest)"; then
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
    print("[check-update] 已是最新版本（接口未返回更新包）")
    sys.exit(0)

if 'code' in data and 'version' not in data:
    print("[check-update] 错误: 接口返回 %s - %s" % (data.get('code'), data.get('msg', '')),
          file=sys.stderr)
    sys.exit(2)

latest = data.get('version', '')
product = data.get('productVersion', latest)
url = data.get('url', '')
sha = data.get('sha256hash', '')

local_rel = parse_ver(local_version)[:3]
latest_rel = parse_ver(latest)[:3]

if cmp_tuple(latest_rel, local_rel) > 0:
    print("[check-update] 官方已发布新版本: %s" % latest)
    if product and product != latest:
        print("[check-update] 产品版本: %s" % product)
    if url:
        print("[check-update] 下载地址: %s" % url)
    if sha:
        print("[check-update] SHA256: %s" % sha)
    print("[check-update] 升级路径: 下载新版 macOS DMG 放入 downloads/ 后执行:")
    print("[check-update]   make build-app && make package && make install")
    sys.exit(1)

print("[check-update] 已是最新版本（官方最新: %d.%d.%d）" % tuple(latest_rel[:3]))
sys.exit(0)
PY
}

main "$@"
