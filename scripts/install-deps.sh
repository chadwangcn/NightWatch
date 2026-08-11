#!/usr/bin/env bash
# NightWatch 一键安装脚本
# 用法: bash scripts/install-deps.sh
# 功能:
#   1. 检查 Node.js >= 20
#   2. 安装项目 npm 依赖
#   3. 全局安装 Newman + newman-reporter-htmlextra
#   4. 检测/提示 Trae CLI 安装(macOS keychain 凭证)

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}NightWatch 依赖安装${NC}"
echo -e "${BLUE}──────────────────────────────────${NC}"
echo -e "项目根: $PROJECT_ROOT"
echo ""

# ============ 1. Node.js 检查 ============
echo -e "${BLUE}[1/4] 检查 Node.js${NC}"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗ Node.js 未安装${NC}"
  echo -e "  macOS:  brew install node"
  echo -e "  或:     https://nodejs.org/ 下载 LTS 版本"
  exit 1
fi

NODE_VER=$(node --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo -e "${RED}✗ Node.js 版本过低 ($NODE_VER, 需要 >= 20)${NC}"
  echo -e "  升级: brew upgrade node"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $NODE_VER${NC}"
echo ""

# ============ 2. 项目 npm 依赖 ============
echo -e "${BLUE}[2/4] 安装项目依赖 (npm install)${NC}"
cd "$PROJECT_ROOT"
if [[ -f package.json ]]; then
  npm install
  echo -e "${GREEN}✓ node_modules 安装完成${NC}"
else
  echo -e "${RED}✗ package.json 不存在${NC}"
  exit 1
fi
echo ""

# ============ 3. Newman + reporter ============
echo -e "${BLUE}[3/4] 全局安装 Newman + newman-reporter-htmlextra${NC}"
if command -v newman >/dev/null 2>&1; then
  NEWMAN_VER=$(newman --version 2>&1 | head -1)
  echo -e "${YELLOW}⚠ Newman 已安装 ($NEWMAN_VER),跳过${NC}"
  echo -e "  如需升级: npm install -g newman newman-reporter-htmlextra"
else
  npm install -g newman newman-reporter-htmlextra
  echo -e "${GREEN}✓ Newman $(newman --version 2>&1 | head -1) 已安装${NC}"
fi
echo ""

# ============ 4. Trae CLI (可选,Agent 功能用) ============
echo -e "${BLUE}[4/4] 检查 Trae CLI (可选,Agent 集成功能用)${NC}"
if command -v traecli >/dev/null 2>&1; then
  echo -e "${GREEN}✓ Trae CLI 已安装 ($(traecli --version 2>&1 | head -1))${NC}"
else
  echo -e "${YELLOW}⚠ Trae CLI 未安装${NC}"
  echo -e ""
  echo -e "  Trae CLI 是 Agent 集成功能(POST /api/ai/trae)的依赖,不影响核心测试运行。"
  echo -e "  官方文档: https://docs.trae.cn/cli/get-started-with-trae-cli"
  echo -e ""
  echo -e "  安装命令:"
  echo -e "    # macOS & Linux"
  echo -e "    sh -c \"\$(curl -L https://trae.cn/trae-cli/install.sh)\" && export PATH=~/.local/bin:\$PATH"
  echo -e ""
  echo -e "    # Windows (PowerShell)"
  echo -e "    irm https://trae.cn/trae-cli/install.ps1 | iex"
  echo -e ""
  echo -e "  安装后,设置 macOS keychain 凭证(供 server.js 读取):"
  echo -e "    security add-generic-password -s trae-cli-token -a traecli-personal-access-token -w <YOUR_TRAE_CLI_TOKEN>"
  echo -e ""
  echo -e "  路径可通过环境变量覆盖:"
  echo -e "    TRAE_CLI_BIN=/path/to/traecli node server.js"
fi
echo ""

# ============ 环境变量文件 ============
echo -e "${BLUE}环境变量${NC}"
LOCAL_ENV="postman/lumi-device-platform.postman_environment.local.json"
if [[ -f "$LOCAL_ENV" ]]; then
  echo -e "${GREEN}✓ $LOCAL_ENV 已存在${NC}"
else
  echo -e "${YELLOW}⚠ $LOCAL_ENV 不存在,从模板创建${NC}"
  cp postman/lumi-device-platform.postman_environment.json "$LOCAL_ENV"
  echo -e "${GREEN}✓ 已从模板创建,请编辑填入真实凭证${NC}"
  echo -e "  需填入的字段:"
  echo -e "    - device_sn / device_secret_b64url (设备 HMAC 密钥)"
  echo -e "    - user_account / user_password"
  echo -e "    - operator_account / operator_password"
  echo -e "    - s5_test_audio_path / s5_test_family_id / s5_test_child_id (S5 场景测试)"
fi
echo ""

# ============ 完成 ============
echo -e "${BLUE}──────────────────────────────────${NC}"
echo -e "${GREEN}安装完成${NC}"
echo -e ""
echo -e "下一步:"
echo -e "  1. 编辑 $LOCAL_ENV 填入真实凭证"
echo -e "  2. 启动: npm run console"
echo -e "  3. 访问: http://localhost:8088"
echo -e "  4. 验证: bash scripts/check-deps.sh"
