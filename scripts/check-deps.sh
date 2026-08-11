#!/usr/bin/env bash
# NightWatch 依赖检查脚本
# 用法: bash scripts/check-deps.sh
# 退出码: 0=全部就绪, 1=有缺失/版本不符

set -euo pipefail

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok=0
warn=0
err=0

check() {
  local name="$1"
  local cmd="$2"
  local min_ver="$3"
  local install_hint="$4"

  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}✗${NC} $name — 未安装"
    echo -e "  安装: $install_hint"
    err=$((err + 1))
    return 1
  fi

  local ver
  ver="$("$cmd" --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'unknown')"

  if [[ "$min_ver" != "" && "$ver" != "unknown" ]]; then
    if ! printf '%s\n%s\n' "$min_ver" "$ver" | sort -V -C; then
      echo -e "${YELLOW}⚠${NC} $name — 版本过低 (当前 $ver, 需要 >= $min_ver)"
      echo -e "  升级: $install_hint"
      warn=$((warn + 1))
      return 1
    fi
  fi

  echo -e "${GREEN}✓${NC} $name ($ver)"
  ok=$((ok + 1))
  return 0
}

echo -e "${BLUE}NightWatch 依赖检查${NC}"
echo -e "${BLUE}──────────────────────────────────${NC}"

# Node.js >= 20
check "Node.js" "node" "20.0.0" "https://nodejs.org/ 或 brew install node"

# npm
check "npm" "npm" "" "随 Node.js 安装"

# Newman >= 6
check "Newman" "newman" "6.0.0" "npm install -g newman newman-reporter-htmlextra"

# Trae CLI (可选,Agent 功能用)
if command -v traecli >/dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Trae CLI ($(traecli --version 2>&1 | head -1))"
  ok=$((ok + 1))
else
  echo -e "${YELLOW}⚠${NC} Trae CLI — 未安装 (Agent 集成功能不可用)"
  echo -e "  官方文档: https://docs.trae.cn/cli/get-started-with-trae-cli"
  echo -e "  macOS & Linux: sh -c \"\$(curl -L https://trae.cn/trae-cli/install.sh)\" && export PATH=~/.local/bin:\$PATH"
  echo -e "  Windows: irm https://trae.cn/trae-cli/install.ps1 | iex"
  warn=$((warn + 1))
fi

# keychain 凭证检查(仅 macOS)
if [[ "$(uname)" == "Darwin" ]] && command -v traecli >/dev/null 2>&1; then
  if security find-generic-password -s trae-cli-token -a traecli-personal-access-token >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} macOS keychain Trae CLI token"
    ok=$((ok + 1))
  else
    echo -e "${YELLOW}⚠${NC} macOS keychain 未找到 Trae CLI token"
    echo -e "  设置: security add-generic-password -s trae-cli-token -a traecli-personal-access-token -w <YOUR_TOKEN>"
    warn=$((warn + 1))
  fi
fi

# 项目本地依赖
echo ""
echo -e "${BLUE}项目依赖${NC}"
if [[ -d node_modules ]]; then
  echo -e "${GREEN}✓${NC} node_modules (已安装)"
  ok=$((ok + 1))
else
  echo -e "${RED}✗${NC} node_modules — 未安装"
  echo -e "  安装: npm install"
  err=$((err + 1))
fi

if [[ -f postman/lumi-device-platform.postman_environment.local.json ]]; then
  echo -e "${GREEN}✓${NC} postman/lumi-device-platform.postman_environment.local.json"
  ok=$((ok + 1))
else
  echo -e "${YELLOW}⚠${NC} postman/*.local.json — 不存在(需手动创建并填入凭证)"
  echo -e "  模板: postman/lumi-device-platform.postman_environment.json"
  warn=$((warn + 1))
fi

# 总结
echo ""
echo -e "${BLUE}──────────────────────────────────${NC}"
echo -e "${GREEN}就绪: ${ok}${NC}  ${YELLOW}警告: ${warn}${NC}  ${RED}错误: ${err}${NC}"

if [[ $err -gt 0 ]]; then
  echo -e "${RED}依赖检查未通过,请按提示安装/升级${NC}"
  exit 1
elif [[ $warn -gt 0 ]]; then
  echo -e "${YELLOW}核心依赖就绪,部分可选功能未配置${NC}"
  exit 0
else
  echo -e "${GREEN}全部就绪,可启动: npm run console${NC}"
  exit 0
fi
