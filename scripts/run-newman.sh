#!/usr/bin/env bash
# Newman CI 运行脚本
# 用法：
#   bash scripts/run-newman.sh smoke      # P0 冒烟（健康检查 + 场景A + 场景C）
#   bash scripts/run-newman.sh device     # 设备面单接口完整性
#   bash scripts/run-newman.sh guardian    # 家长面单接口完整性
#   bash scripts/run-newman.sh ops        # 运营面单接口完整性
#   bash scripts/run-newman.sh s5-full    # S5 全量 59 请求
#   bash scripts/run-newman.sh all        # 三集合全量
#   bash scripts/run-newman.sh            # 默认 = smoke

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$ROOT_DIR/reports"
mkdir -p "$REPORT_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

COLLECTION_DIR="$ROOT_DIR/postman"
ENV_FILE="$COLLECTION_DIR/lumi-device-platform.postman_environment.json"

# 敏感凭证从环境变量读取（CI 注入或本地 .env）
# 非敏感的约定值（device_sn / product_id / s5_cms_page_key 等）已在 env 文件中默认
: "${DEVICE_SECRET_B64URL:?需设置 DEVICE_SECRET_B64URL}"
: "${USER_ACCOUNT:?需设置 USER_ACCOUNT}"
: "${USER_PASSWORD:?需设置 USER_PASSWORD}"
: "${OPERATOR_ACCOUNT:?需设置 OPERATOR_ACCOUNT}"
: "${OPERATOR_PASSWORD:?需设置 OPERATOR_PASSWORD}"
: "${S5_TEST_AUDIO_PATH:?需设置 S5_TEST_AUDIO_PATH}"

# 公共参数
COMMON_ARGS=(
  -e "$ENV_FILE"
  --reporters cli,htmlextra
  --env-var "device_secret_b64url=$DEVICE_SECRET_B64URL"
  --env-var "user_account=$USER_ACCOUNT"
  --env-var "user_password=$USER_PASSWORD"
  --env-var "operator_account=$OPERATOR_ACCOUNT"
  --env-var "operator_password=$OPERATOR_PASSWORD"
  --env-var "s5_test_audio_path=$S5_TEST_AUDIO_PATH"
)

# 场景B 可选变量（不设置时跳过场景B）
S5_FAMILY_ID="${S5_TEST_FAMILY_ID:-}"
S5_CHILD_ID="${S5_TEST_CHILD_ID:-}"
if [[ -n "$S5_FAMILY_ID" && -n "$S5_CHILD_ID" ]]; then
  COMMON_ARGS+=(--env-var "s5_test_family_id=$S5_FAMILY_ID" --env-var "s5_test_child_id=$S5_CHILD_ID")
fi

run_device_platform() {
  echo "==> [device-platform] 运行设备平台集合..."
  newman run "$COLLECTION_DIR/lumi-device-platform.postman_collection.json" \
    "${COMMON_ARGS[@]}" \
    --reporter-htmlextra-export "$REPORT_DIR/device-platform-$TIMESTAMP.html"
}

run_s4() {
  echo "==> [s4-interaction] 运行 S4 交互集合..."
  newman run "$COLLECTION_DIR/lumi-s4-interaction.postman_collection.json" \
    "${COMMON_ARGS[@]}" \
    --reporter-htmlextra-export "$REPORT_DIR/s4-$TIMESTAMP.html"
}

run_s5() {
  local mode="${1:-full}"
  local extra_args=()
  case "$mode" in
    smoke)
      extra_args+=(
        --folder "00 · 健康检查"
        --folder "10 · 场景A · 端到端最小验收"
        --folder "12 · 场景C · 鉴权与参数负向"
      )
      ;;
    device)
      extra_args+=(--folder "01 · 设备 API · CMS Catalog PlayResource Categories Library Recommendations")
      ;;
    guardian)
      extra_args+=(--folder "03 · 家长 API · CMS Catalog Categories Library Recommendations PublicationCommand Uploads")
      ;;
    ops)
      extra_args+=(
        --folder "02 · 运营 API · Categories Uploads Publications"
        --folder "04 · 运营 API · CMS Pages"
      )
      ;;
    full|s5-full)
      :  # 不加 --folder，跑全集
      ;;
  esac

  echo "==> [s5-content-media] mode=$mode 运行 S5 集合..."
  newman run "$COLLECTION_DIR/lumi-s5-content-media.postman_collection.json" \
    "${COMMON_ARGS[@]}" \
    "${extra_args[@]}" \
    --reporter-htmlextra-export "$REPORT_DIR/s5-$mode-$TIMESTAMP.html"
}

MODE="${1:-smoke}"

case "$MODE" in
  smoke|device|guardian|ops|s5-full|full)
    ;;
  all)
    run_device_platform
    run_s4
    run_s5 full
    ;;
  *)
    echo "用法: bash scripts/run-newman.sh [smoke|device|guardian|ops|s5-full|all]"
    echo "默认: smoke"
    exit 1
    ;;
esac

if [[ "$MODE" == "s5-full" ]]; then
  run_s5 full
else
  run_s5 "$MODE"
fi

echo ""
echo "==> 完成。报告位于: $REPORT_DIR/"
ls -lt "$REPORT_DIR"/*.html 2>/dev/null | head -5
