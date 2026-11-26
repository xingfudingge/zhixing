#!/usr/bin/env bash
# 知行 macOS 发布包：build → 从 DMG 取 app → ad-hoc 重签 → 重建 DMG → outputs/Downloads。
# 约定：每次优化完成后运行本脚本；不修改产品代码，不做 GitHub Release。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"

VERSION="$(node -p "require('./app/src-tauri/tauri.conf.json').version")"
IDENTIFIER="$(node -p "require('./app/src-tauri/tauri.conf.json').identifier")"
SRC_DMG="app/src-tauri/target/release/bundle/dmg/知行_${VERSION}_aarch64.dmg"
OUT_DMG="outputs/知行_${VERSION}_aarch64.dmg"
DOWNLOADS_DIR="$HOME/Downloads/知行-安装包"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/zx-package.XXXXXX")"
MNT="$TMP/mount"
APP=""
cleanup() {
  if [ -n "$APP" ] && mount | grep -q "on $MNT "; then
    hdiutil detach "$MNT" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== 知行发布包 =="
echo "version=$VERSION identifier=$IDENTIFIER"
echo "root=$ROOT"

# 1) Tauri 构建（会先执行 app 的 vite build）
pnpm --filter app tauri build --bundles dmg

# 2) 从 DMG 取出 Tauri 生成的 app，重新做 ad-hoc 签名。
# Tauri 在无签名身份时生成的 app 可能只有二进制签名，codesign --verify 会报
# “code has no resources”；先 ditto 到临时目录，再对 .app 整体签名。
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$SRC_DMG" >/dev/null
APP="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "找不到 .app：$SRC_DMG" >&2
  exit 1
fi
mkdir -p "$TMP/pkg"
ditto "$APP" "$TMP/pkg/$(basename "$APP")"
hdiutil detach "$MNT" >/dev/null
APP=""
APP_PATH="$TMP/pkg/$(basename "$(find "$TMP/pkg" -maxdepth 1 -name '*.app' -print -quit)")"
codesign --force --deep --sign - --identifier "$IDENTIFIER" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

# 3) 生成可拖入 Applications 的 DMG
ln -s /Applications "$TMP/pkg/Applications"
rm -f "$OUT_DMG"
hdiutil create -volname "知行" -srcfolder "$TMP/pkg" -ov -format UDZO "$OUT_DMG" >/dev/null

# 4) 交付：项目 outputs + Downloads；不写 Release。
mkdir -p "$DOWNLOADS_DIR"
cp "$OUT_DMG" "$DOWNLOADS_DIR/知行_${VERSION}_aarch64.dmg"
SHA="$(shasum -a 256 "$OUT_DMG" | awk '{print $1}')"
SIZE="$(stat -f%z "$OUT_DMG")"
COMMIT="$(git rev-parse HEAD)"
python3 - "$OUT_DMG" "$SHA" "$SIZE" "$COMMIT" "$VERSION" <<'PY'
import json, sys, datetime
path, sha, size, commit, version = sys.argv[1:]
data = {
    "product": "知行",
    "version": version,
    "platform": "macOS arm64",
    "path": path,
    "sha256": sha,
    "sizeBytes": int(size),
    "commit": commit,
    "builtAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "signature": "ad-hoc (not notarized)",
}
with open("outputs/安装包信息.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

echo "PACKAGE=$OUT_DMG"
echo "SHA256=$SHA"
echo "SIZE=$SIZE"
echo "COMMIT=$COMMIT"
