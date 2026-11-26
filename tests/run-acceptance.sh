#!/usr/bin/env bash
# ZX-090 独立验收套件入口。不修改产品代码；只使用 app 已安装的 Vitest。
set -euo pipefail
cd "$(dirname "$0")"
exec ../app/node_modules/.bin/vitest run --config vitest.config.ts "$@"
