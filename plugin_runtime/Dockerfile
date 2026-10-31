# OverMem Plugin Runtime —— Docker 镜像
#
# 本地构建：
#   cd plugin_runtime && docker build -t ghcr.io/serveryyswys/overmem-plugin-runtime:0.1.0 .
# 多架构构建并推送：
#   ./plugin_runtime/scripts/push-image.sh
# 编排运行：docker compose up -d（见 docker-compose.yml）

ARG PYTHON_IMAGE=python:3.12-slim

# ---------- 构建阶段：运行时装进独立 venv ----------
FROM ${PYTHON_IMAGE} AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

# 可选：pip 索引源，国内构建建议
#   --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_INDEX_URL=

WORKDIR /build
COPY pyproject.toml ./
COPY overmem_runtime ./overmem_runtime
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --no-compile ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} .

# ---------- 运行阶段 ----------
FROM ${PYTHON_IMAGE}

ARG OVERMEM_VERSION=0.1.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="OverMem Plugin Runtime" \
      org.opencontainers.image.description="OverMem 插件的独立 Python 运行时（FastAPI），提供 ingestion / transform / inject / consolidation 能力" \
      org.opencontainers.image.version="${OVERMEM_VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.vendor="serveryyswys" \
      org.opencontainers.image.source="https://github.com/serveryyswys/overmem" \
      org.opencontainers.image.documentation="https://github.com/serveryyswys/overmem/blob/main/plugin_runtime/README.md" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    OVERMEM_RUNTIME_MODE=docker \
    OVERMEM_BASE_DIR=/data \
    OVERMEM_PLUGIN_DIR=/data/plugins \
    OVERMEM_DATA_DIR=/data/data

RUN groupadd --system --gid 10001 overmem \
 && useradd --system --uid 10001 --gid overmem --home-dir /data --no-create-home --shell /usr/sbin/nologin overmem \
 && mkdir -p /data/plugins /data/data /app \
 && chown -R overmem:overmem /data /app

COPY --from=build /opt/venv /opt/venv

WORKDIR /app
USER overmem
VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3).status == 200 else 1)"

STOPSIGNAL SIGTERM
ENTRYPOINT ["overmem-runtime"]
CMD ["--host", "0.0.0.0", "--port", "8765", "--mode", "docker"]
