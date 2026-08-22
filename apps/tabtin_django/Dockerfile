# Standard BuildKit syntax; no external frontend image is required.
# TabTin Django 应用镜像（整机 compose 用，单库 single_pg）
# 见 docs/agent/pg-single-db-mainline-plan.md「整机 Compose（单库部署形态）设计」。
#
# ⚠️ 根上下文构建（context: .）：后端运行时按 parents[5]/parents[6] 读 monorepo
#    同级 packages/（capability_contract → packages/tabtin-shared/src/contract.json，
#    app_registry → packages/apps/*/app.json，Agent 模板 → packages/agents/*/agent.json，
#    platform skill → packages/skills/bundled/）。故镜像里必须保留 monorepo 布局：
#    /app/apps/tabtin_django 与 /app/packages 同级。
#
# 同一镜像三种角色（docker-entrypoint.sh 首参切换）：web(daphne) / worker / beat。
# 密钥不烘焙：.env 已被 .dockerignore 排除，运行时由 compose 注入（INFRA-1）。
#
# 速度/体积：pip wheel 缓存挂载 → 即便层缓存失效也复用已下载 wheel，不重下。
#
# 开源构建默认使用官方镜像；内部流水线仍可通过 BASE_IMAGE 覆盖为 ACR 镜像。
#   docker build --build-arg BASE_IMAGE=<registry>/python:3.11-slim ...
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE} AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DJANGO_SETTINGS_MODULE=tabtin.settings \
    TABTIN_REPO_ROOT=/app \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 显式锚点（INFRA-2 自包含）：后端经 apps.services.repo_root.get_repo_root() 解析
# monorepo 根，优先读 TABTIN_REPO_ROOT，不再依赖写死的目录层级 parents[N]。
# 镜像里 monorepo 布局根 = /app（/app/apps/tabtin_django 与 /app/packages 同级）。

# 系统依赖：
#   build-essential / pkg-config —— 兜底无 wheel 的源码包；
#   curl —— healthcheck；
#   libmagic1 —— python-magic（apps/services/oss 文件类型探测）的运行时 C 库；
#   libpq5 —— PostgreSQL 客户端库（psycopg2-binary 自带，留作兜底）。
#
# APT_MIRROR：可选 build-arg，受限网络（如 CN ECS）构建时换 Debian 源加速。
#   默认空 → 保持 deb.debian.org（dev Mac / 海外 CI 不受影响）。
#   传值示例：--build-arg APT_MIRROR=mirrors.cloud.aliyuncs.com（阿里云 ECS 内网，24MB/s）。
#   deb822 源（trixie 的 /etc/apt/sources.list.d/debian.sources）main+security 同 host，一次 sed 全替。
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        curl \
        gosu \
        libmagic1 \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/tabtin_django

# 先装依赖（利用层缓存：requirements 不变则整层命中）
COPY apps/tabtin_django/requirements.txt ./
# PIP_INDEX_URL：可选 build-arg，同 APT_MIRROR 思路——受限网络换 PyPI 源加速。
#   默认空 → pip 用官方 PyPI（dev/海外不受影响）。空值不注入任何 flag，避免 pip 误用空 index。
#   传值示例：--build-arg PIP_INDEX_URL=http://mirrors.cloud.aliyuncs.com/pypi/simple/
#   （阿里云内网走 http，需配 --build-arg PIP_TRUSTED_HOST=mirrors.cloud.aliyuncs.com）。
ARG PIP_INDEX_URL=""
ARG PIP_TRUSTED_HOST=""
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} && \
    pip install ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} -r requirements.txt

# PDF 导出复用 Playwright 渲染 HTML，部署镜像必须内置浏览器本体。
# 固定 PLAYWRIGHT_BROWSERS_PATH，避免安装到 root home 后运行态 tabtin 用户不可读。
#
# PLAYWRIGHT_DOWNLOAD_HOST：Chromium 本体默认从 cdn.playwright.dev 下（国内/云效公网极慢，
#   实测 177MB 可拖 20+ 分钟）。默认走 npmmirror；海外/官方源可覆盖为空或官方 host。
#   传值示例：--build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.playwright.dev
ARG PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright"
ARG INSTALL_PLAYWRIGHT=true
ENV PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
        python -m playwright install --with-deps chromium \
        && chmod -R a+rX /ms-playwright; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# 后端代码 + 运行时所需的 monorepo packages（保持同级布局供 parents[5/6] 解析）
# #7532：agents = 精品模板列表；skills = platform seed / 模板 skills 存在性检查
COPY apps/tabtin_django /app/apps/tabtin_django
COPY packages/tabtin-shared /app/packages/tabtin-shared
COPY packages/apps /app/packages/apps
COPY packages/agents /app/packages/agents
COPY packages/skills /app/packages/skills
COPY community-assets/postgres /app/community-assets/postgres
COPY community-assets/centrifugo.template.json /app/community-assets/centrifugo.template.json

# #7532：构建期硬失败——缺模板目录时生产会静默返回空列表（只剩「从空白创建」）
RUN set -euo pipefail \
    && test -d /app/packages/agents \
    && agent_manifest_count="$(find /app/packages/agents -mindepth 2 -maxdepth 2 -name agent.json | wc -l | tr -d ' ')" \
    && test "${agent_manifest_count}" -ge 1 \
    && test -d /app/packages/skills/bundled \
    && echo "[django-image] agent templates=${agent_manifest_count} packages/skills/bundled=ok"

RUN chmod +x /app/apps/tabtin_django/docker-entrypoint.sh \
    && groupadd --system tabtin \
    && useradd --system --gid tabtin --home-dir /app --shell /usr/sbin/nologin tabtin \
    && groupadd --gid 10001 tabtin-community \
    && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin tabtin-community \
    && mkdir -p /app/apps/tabtin_django/logs /app/apps/tabtin_django/media /app/apps/tabtin_django/staticfiles \
        /var/lib/tabtin/objects \
    && chown -R tabtin:tabtin /app /var/lib/tabtin/objects

# 构建身份放在依赖与源码层之后，更新版号不会击穿 apt/pip/Playwright 缓存。
ARG TABTIN_SERVER_VERSION=""
ARG TABTIN_SOURCE_SHA=""
ENV TABTIN_SERVER_VERSION=${TABTIN_SERVER_VERSION} \
    TABTIN_SOURCE_SHA=${TABTIN_SOURCE_SHA}

USER tabtin

EXPOSE 6060

ENTRYPOINT ["/app/apps/tabtin_django/docker-entrypoint.sh"]
CMD ["web"]
