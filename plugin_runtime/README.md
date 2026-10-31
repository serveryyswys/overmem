# OverMem Plugin Runtime

OverMem 插件的独立运行时进程（FastAPI + Python 3.10+）。宿主（Operit 内的 OverMem 插件）通过 HTTP 调用它执行 ingestion / transform / inject / consolidation 能力。

## 安装

```bash
# 源码发行包
unzip overmem_runtime-0.1.0.zip && cd overmem_runtime-0.1.0
pip3 install .

# 或直接从 zip 安装
pip3 install overmem_runtime-0.1.0.zip
```

Android 环境（Operit）：

```bash
cd /sdcard/Download/Operit/overmem/plugin_runtime
pip3 install --target .lib .
PYTHONPATH=$PWD/.lib python3 -m overmem_runtime --port 8765
```

## 运行

```bash
overmem-runtime --host 127.0.0.1 --port 8765          # ubuntu 模式（默认，仅本机、不鉴权）
overmem-runtime --host 0.0.0.0 --port 8765 --mode docker  # docker 模式（强制 JWT）
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OVERMEM_RUNTIME_MODE` | `ubuntu` | `ubuntu` / `docker` |
| `OVERMEM_BASE_DIR` | `/sdcard/Download/Operit/overmem/plugin_runtime` | 运行根目录 |
| `OVERMEM_PLUGIN_DIR` | `<base>/plugins` | 插件安装目录 |
| `OVERMEM_DATA_DIR` | `<base>/data` | 数据库与状态文件 |
| `OVERMEM_JWT_SECRET` | 自动生成 `data/.jwt_secret` | JWT HS256 密钥 |
| `OVERMEM_JWT_TTL` | `3600` | Token 有效期（秒） |
| `OVERMEM_ADMIN_USERNAME` / `OVERMEM_ADMIN_PASSWORD` | 空 | 设置后 `/admin` 需要 HTTP Basic |
| `OVERMEM_BOOTSTRAP_KEY` | 空 | 首次启动预置的 API Key（明文） |
| `OVERMEM_LOGS_CAPACITY` | `500` | 环形日志缓冲条数 |

## 接口

- `GET /health`（免鉴权）→ `{"ok":true,"version":"0.1.0","plugins_count":N}`
- `GET /v1/capabilities` → `[{"plugin","capability","description"}]`
- `POST /v1/invoke` `{"plugin","capability","args"}` → `{"ok":true,"result"}` / `{"ok":false,"error":{"code","message"}}`
- `GET /v1/plugins`、`POST /v1/plugins/install`（multipart zip）、`POST /v1/plugins/install-base64`（JSON base64）
- `POST /v1/plugins/{id}/enable` `{"enabled":bool}`、`POST /v1/plugins/{id}/reload`、`DELETE /v1/plugins/{id}`、`PUT /v1/plugins/{id}/config` `{"values":{...}}`
- `GET /v1/market/index`、`POST /v1/market/install`（501 占位）
- `POST /v1/auth/token`（docker 模式，API Key 换 JWT）、`GET|POST /v1/keys`、`DELETE /v1/keys/{id}`
- `GET /v1/logs?limit=100&plugin=<id>`（docker 模式需 admin）
- `GET /admin` 静态管理后台

## 插件格式

```
plugins/<plugin-dir>/
├── manifest.yaml
└── main.py
```

`manifest.yaml`：

```yaml
id: com.example.my_plugin
name: 我的插件
version: 0.1.0
description: 说明
author: 作者
runtime_api: ">=0.1.0"
spec:
  config:
    - name: threshold
      type: int
      default: 5
      min: 0
      max: 100
      label: 阈值
    - name: mode
      type: enum
      default: soft
      enum: [soft, hard]
      label: 模式
capabilities:
  - name: transform.enhance
    description: 增强记忆块
```

`main.py` 继承 `overmem_runtime.plugins.base.BasePlugin`，用 `@capability("transform.enhance")` 装饰处理方法。能力名必须落在 `ingest.` / `transform.` / `inject.` / `consolidate.` 命名空间。

## Docker

镜像：`ghcr.io/serveryyswys/overmem-plugin-runtime`，同时提供 `linux/amd64` 与 `linux/arm64`。

### 构建与上传

```bash
cd plugin_runtime

# 本机构建单架构镜像
docker build -t ghcr.io/serveryyswys/overmem-plugin-runtime:0.1.0 .

# 多架构构建并推送（先 docker login 到目标仓库）
IMAGE=ghcr.io/serveryyswys/overmem-plugin-runtime VERSION=0.1.0 ./scripts/push-image.sh

# 推送到 Docker Hub
IMAGE=docker.io/<用户名>/overmem-plugin-runtime VERSION=0.1.0 ./scripts/push-image.sh
```

国内网络拉 PyPI 依赖慢时，可指定镜像源（默认走官方 PyPI）：

```bash
# 单架构
docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  -t ghcr.io/serveryyswys/overmem-plugin-runtime:0.1.0 .

# 多架构
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  IMAGE=ghcr.io/serveryyswys/overmem-plugin-runtime VERSION=0.1.0 ./scripts/push-image.sh
```

仓库自带 `docker-image` workflow：推送 `v*` tag 或 `main` 分支时自动构建 amd64 + arm64 并推送到 GHCR，标签为 `X.Y.Z`、`X.Y`、`sha-<短 sha>`、`latest`（默认分支）。

### 编排运行

```bash
cd plugin_runtime
cp .env.example .env      # 可选：改端口 / JWT 密钥 / 管理员账号
docker compose pull       # 拉已发布镜像
docker compose up -d
docker compose ps
curl http://127.0.0.1:8765/health

# 或从源码构建
docker compose build && docker compose up -d
```

- 数据卷 `overmem-runtime_overmem-data` 挂到容器 `/data`：插件在 `/data/plugins`，数据库与状态在 `/data/data`（`runtime.db`、`plugin_states.json`、`.jwt_secret`）。
- 默认只监听 `127.0.0.1:8765`；对外提供服务时设 `OVERMEM_BIND=0.0.0.0`，并放在 HTTPS 反向代理后面。
- 管理后台 `http://<host>:8765/admin`；设置了 `OVERMEM_ADMIN_USERNAME` / `OVERMEM_ADMIN_PASSWORD` 后走 HTTP Basic。
- 容器以非 root 用户 `overmem`（uid 10001）运行。改用 bind mount（如 `./data:/data`）时，宿主机目录属主需要是 `10001:10001`。
- 备份数据卷：`docker run --rm -v overmem-runtime_overmem-data:/data -v "$PWD":/backup alpine tar czf /backup/overmem-data.tar.gz -C /data .`

### 鉴权（docker 模式）

docker 模式强制 JWT：只有 `/health` 与 `/v1/auth/token` 免鉴权，其余 `/v1/*` 需要 `Authorization: Bearer <token>`；`/docs`、`/openapi.json` 关闭。

```bash
# 首次启动自动生成 bootstrap API Key（设置了 OVERMEM_BOOTSTRAP_KEY 则用它，不再写文件）
docker compose exec plugin-runtime cat /data/data/bootstrap_key.txt

# API Key 换 JWT
curl -s -X POST http://127.0.0.1:8765/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"api_key":"ok_..."}'

# 带 JWT 调用
curl -s http://127.0.0.1:8765/v1/capabilities -H "Authorization: Bearer <token>"
```

> Operit 插件端的「远程连接」目前只支持免鉴权的 ubuntu 模式运行时；连 docker 模式需要先换 JWT，客户端暂未内置换取流程。
