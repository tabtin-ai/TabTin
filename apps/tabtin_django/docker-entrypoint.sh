#!/usr/bin/env bash
# TabTin Django 容器入口：按角色分发（web / worker / beat）。
# 仅 web 角色跑迁移（避免多容器并发 migrate），worker/beat 经 depends_on 等 web healthy。
set -euo pipefail

role="${1:-web}"

case "${role}" in
  community-web)
    if [ "$(id -u)" -ne 0 ]; then
      echo "[entrypoint] community-web requires its one-shot installer to start as root" >&2
      exit 1
    fi
    echo "[entrypoint] initializing persistent Community installation secrets"
    python -m tabtin.community_secrets init

    echo "[entrypoint] synchronizing Community PostgreSQL roles"
    python -m tabtin.community_database sync

    echo "[entrypoint] applying PostgreSQL migrations with the migrator role"
    PG_DB_USER=tabtin_migrator \
      PG_DB_PASSWORD_FILE="${PG_MIGRATOR_PASSWORD_FILE:?PG_MIGRATOR_PASSWORD_FILE is required}" \
      python manage.py safe_migrate --noinput

    echo "[entrypoint] finalizing narrow Community database capabilities"
    python -m tabtin.community_database finalize

    mkdir -p /var/lib/tabtin/objects
    chown -R 10001:10001 /var/lib/tabtin/objects
    echo "[entrypoint] applying idempotent Community bootstrap"
    gosu tabtin-community python manage.py tabtin_bootstrap --edition community

    # The long-running web process receives only the runtime role and cannot
    # read the root/postgres-owned one-shot password files.
    unset PG_INIT_PASSWORD_FILE PG_MIGRATOR_PASSWORD_FILE TABTIN_COMMUNITY_DATABASE_SQL_ROOT
    echo "[entrypoint] starting Community daphne on 0.0.0.0:6060"
    exec gosu tabtin-community python -m daphne \
      --ping-interval 45 \
      --ping-timeout 60 \
      --websocket_timeout 3600 \
      --application-close-timeout 120 \
      -b 0.0.0.0 -p 6060 \
      tabtin.asgi:application
    ;;
  web)
    if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
      echo "[entrypoint] running safe_migrate (single_pg)…"
      python manage.py safe_migrate --noinput
    fi
    # 基线数据初始化：默认关闭（数据 init 与 migrate 同档，应显式可控）。
    # dev 想 `docker compose up` 一把梭可设 RUN_BOOTSTRAP=true 选择性 opt-in；
    # 生产默认不自动跑，由编排者显式 `manage.py bootstrap_fresh_db` 一次。
    if [ "${RUN_BOOTSTRAP:-false}" = "true" ]; then
      echo "[entrypoint] RUN_BOOTSTRAP=true → bootstrap_fresh_db（基线 seed，幂等）…"
      python manage.py bootstrap_fresh_db || echo "[entrypoint] bootstrap_fresh_db 有失败项，见上（不阻断起服务）"
    fi
    echo "[entrypoint] starting daphne on 0.0.0.0:6060"
    exec python -m daphne \
      --ping-interval 45 \
      --ping-timeout 60 \
      --websocket_timeout 3600 \
      --application-close-timeout 120 \
      -b 0.0.0.0 -p 6060 \
      tabtin.asgi:application
    ;;
  worker)
    echo "[entrypoint] starting celery worker"
    worker_args=(
      -A tabtin worker -l info
      -Q "${CELERY_QUEUES:-default}"
      -c "${CELERY_CONCURRENCY:-4}"
      --prefetch-multiplier="${CELERY_PREFETCH_MULTIPLIER:-4}"
    )
    if [ -n "${CELERY_MAX_MEMORY:-}" ]; then
      worker_args+=(--max-memory-per-child="${CELERY_MAX_MEMORY}")
    fi
    if [ -n "${CELERY_MAX_TASKS_PER_CHILD:-}" ]; then
      worker_args+=(--max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD}")
    fi
    if [ -n "${CELERY_SOFT_TIME_LIMIT:-}" ]; then
      worker_args+=(--soft-time-limit="${CELERY_SOFT_TIME_LIMIT}")
    fi
    if [ -n "${CELERY_TIME_LIMIT:-}" ]; then
      worker_args+=(--time-limit="${CELERY_TIME_LIMIT}")
    fi
    exec celery "${worker_args[@]}"
    ;;
  beat)
    echo "[entrypoint] starting celery beat"
    exec celery -A tabtin beat -l info \
      --pidfile=/tmp/celerybeat.pid \
      --scheduler django_celery_beat.schedulers:DatabaseScheduler
    ;;
  *)
    # 透传任意命令（调试用：bash / manage.py shell 等）
    exec "$@"
    ;;
esac
