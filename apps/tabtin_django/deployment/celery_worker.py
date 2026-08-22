#!/usr/bin/env python
"""
Celery Worker 生产启动脚本

用法:
    python deployment/celery_worker.py                         # 默认主 Worker
    python deployment/celery_worker.py --queues critical -c 2  # critical Worker
    python deployment/celery_worker.py \
        --queues heavy,media,docparse,tabdata_conversion,pptx_import_oss -c 2

    # FTS 统一搜索索引同步（search_indexing 队列）— Wave 0 起启用
    python deployment/celery_worker.py \
        --queues=search_indexing --concurrency=4 \
        --max-tasks-per-child=1000 -n fts@%h

未传参数时等同于 scripts/backend/celery-start.sh 主 Worker（不含 critical，critical 见独立单元）:
    celery -A tabtin worker -l info -Q default,heavy,low_priority,tabdata_conversion,pptx_import_oss \
        -c 4 --prefetch-multiplier=2 --max-memory-per-child=512000 -n worker@%h

生产部署必须同时起以下独立 systemd 单元（或等价 K8s Deployment）：
    - tabtin-celery-worker     (默认主 Worker)
    - tabtin-celery-critical   (critical 队列)
    - tabtin-celery-heavy      (heavy/media/docparse/tabdata_conversion/pptx_import_oss)
    - tabtin-celery-scheduler  (tracker_agent 队列)
    - tabtin-celery-fts        (search_indexing 队列，ADR-03 / PRD 4.3.D)
    - tabtin-celery-beat       (beat 定时任务，单实例)

**特别强调**：search_indexing 队列的任务由 apps/fts 驱动，Wave 1 起
承载同步管道核心负载。若未启 fts worker，outbox 积压会线性增长，
最终打爆 MySQL 的 fts_outbox 表（每日 ~100w 级）。
"""

import os
import sys
from pathlib import Path

DJANGO_DIR = Path(__file__).resolve().parent.parent  # apps/tabtin_django/
sys.path.insert(0, str(DJANGO_DIR))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

import django  # noqa: E402
django.setup()

from tabtin.celery import app  # noqa: E402

# 主 Worker 默认参数 — 与 scripts/backend/celery-start.sh / systemd tabtin-celery-worker 对齐
#   default / heavy / low_priority / tabdata_conversion / pptx_import_oss:
#   本进程消费（critical 由独立 worker）
#   prefetch=2、max-memory-per-child=512000：与 nohup/systemd 一致，避免全局 worker_prefetch_multiplier
# 注意：critical / tracker_agent 由 tabtin-celery-critical、tabtin-celery-scheduler 或显式参数启动
_DEFAULT_ARGV = [
    'worker',
    '--loglevel=info',
    '--queues=default,heavy,low_priority,tabdata_conversion,pptx_import_oss',
    '--concurrency=4',
    '--prefetch-multiplier=2',
    '--max-memory-per-child=512000',
    '-n', 'worker@%h',
]

if __name__ == '__main__':
    argv = sys.argv[1:] or _DEFAULT_ARGV
    app.worker_main(['worker'] + argv if argv != _DEFAULT_ARGV else argv)
