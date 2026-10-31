#!/usr/bin/env bash
# 构建并推送 OverMem Runtime 多架构镜像（amd64 + arm64）。
#
#   ./plugin_runtime/scripts/push-image.sh                    # 推到默认 GHCR 仓库
#   IMAGE=docker.io/serveryyswys/overmem-plugin-runtime ./plugin_runtime/scripts/push-image.sh
#   VERSION=0.1.1 ./plugin_runtime/scripts/push-image.sh
#
# 需要先 docker login 到目标仓库，并启用 buildx（docker buildx create --use）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE="${IMAGE:-ghcr.io/serveryyswys/overmem-plugin-runtime}"
VERSION="${VERSION:-0.1.0}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
EXTRA_TAGS="${EXTRA_TAGS:-latest}"
BUILDER="${BUILDER:-}"
# 可选：国内构建时指定 pip 镜像源，例如 https://pypi.tuna.tsinghua.edu.cn/simple
PIP_INDEX_URL="${PIP_INDEX_URL:-}"

ARGS=(buildx build
  --platform "$PLATFORMS"
  --build-arg "OVERMEM_VERSION=$VERSION"
  --build-arg "VCS_REF=$(git -C "$CONTEXT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --tag "$IMAGE:$VERSION"
  --push
  "$CONTEXT_DIR")

for tag in $EXTRA_TAGS; do
  [ -n "$tag" ] && ARGS+=(--tag "$IMAGE:$tag")
done

[ -n "$BUILDER" ] && ARGS+=(--builder "$BUILDER")
[ -n "$PIP_INDEX_URL" ] && ARGS+=(--build-arg "PIP_INDEX_URL=$PIP_INDEX_URL")

echo "==> $IMAGE:$VERSION  ($PLATFORMS)"
docker "${ARGS[@]}"

echo "==> 完成。服务器上 docker compose pull && docker compose up -d"
