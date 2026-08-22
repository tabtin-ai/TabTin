"""TabData 异步导入/导出任务的发起人登记与状态归一。

背景（ W3）：导出 / 大文件导入靠 Celery + WS `export_completed` 通知，
CLI / headless 客户端收不到 WS，只能轮询。轮询需要两件事：

1. **鉴权依据**：Celery 的 ``AsyncResult`` 只有 state + result，拿不到 task kwargs
   （``result_extended`` 未开启，且开启后会把导入的 base64 文件内容一起落库），
   因此无法判断"这个 task_id 归谁"。这里在 dispatch 点显式登记
   ``{kind, user_id, table_id}``，status 接口据此做发起人 / 表权限判定。
2. **状态归一**：Celery state（PENDING/STARTED/SUCCESS/FAILURE）与任务体内自定义的
   ``result["status"]``（success/error/skipped）是两层语义——任务捕获异常后仍然是
   Celery SUCCESS。轮询方只关心 ``pending | success | failure`` 三态终判，
   归一逻辑收在这里，避免每个调用方各判一遍。

登记走 Django cache（生产为 Redis）而非新建业务表：这是一份**轮询期**的短命元数据，
TTL 24h 足够覆盖 25 分钟软超时的任务 + 客户端离线重连。缓存缺失时 status 接口
按"任务不存在"处理（fail-closed，不回退到无鉴权查询）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from celery.result import AsyncResult
from django.core.cache import cache

logger = logging.getLogger(__name__)

KIND_EXPORT = "export"
KIND_IMPORT = "import"

_CACHE_PREFIX = "tabdata:async_task:"
_DEFAULT_TTL = 24 * 3600

STATUS_PENDING = "pending"
STATUS_SUCCESS = "success"
STATUS_FAILURE = "failure"

# 任务体内约定的失败标记（见 apps/tabdata/tasks/import_export_tasks.py）
_TASK_RESULT_ERROR = "error"


def _cache_key(task_id: str) -> str:
    return f"{_CACHE_PREFIX}{task_id}"


def register_task(
    task_id: str,
    *,
    kind: str,
    user_id: str,
    table_id: str,
    ttl: int = _DEFAULT_TTL,
) -> None:
    """在 dispatch 点登记任务归属，供后续 status 轮询鉴权。

    登记失败（cache 后端不可用）不阻断任务派发——导出/导入本身仍会执行并走 WS 通知，
    只是轮询接口会把该任务判为不存在。
    """
    try:
        cache.set(
            _cache_key(task_id),
            {"kind": kind, "user_id": str(user_id), "table_id": str(table_id)},
            timeout=ttl,
        )
    except Exception as exc:
        logger.warning("异步任务登记失败 task_id=%s kind=%s: %s", task_id, kind, exc)


def get_task_meta(task_id: str) -> Optional[Dict[str, str]]:
    """取 dispatch 时登记的 ``{kind, user_id, table_id}``；未登记返回 None。"""
    try:
        meta = cache.get(_cache_key(task_id))
    except Exception as exc:
        logger.warning("异步任务元数据读取失败 task_id=%s: %s", task_id, exc)
        return None
    return meta if isinstance(meta, dict) else None


def describe_task(task_id: str, meta: Dict[str, str]) -> Dict[str, Any]:
    """把 Celery state + 任务返回体归一成 ``pending | success | failure`` 三态。

    Celery SUCCESS 只代表"任务函数正常返回"——任务体捕获异常后会返回
    ``{"status": "error", ...}``，那仍然是业务失败，这里映射为 ``failure``。
    """
    result = AsyncResult(task_id)
    celery_state = result.state

    payload: Dict[str, Any] = {
        "task_id": task_id,
        "kind": meta.get("kind", ""),
        "table_id": meta.get("table_id", ""),
        "celery_state": celery_state,
        "status": STATUS_PENDING,
        "ready": False,
    }

    if celery_state == "FAILURE":
        # SEC：Celery 原始异常可能带内部路径 / SQL 片段，不直出给客户端；详情落日志。
        logger.warning("异步任务失败 task_id=%s kind=%s", task_id, payload["kind"])
        payload["status"] = STATUS_FAILURE
        payload["ready"] = True
        payload["error"] = "任务执行失败，请查看服务端日志或重试"
        return payload

    if celery_state != "SUCCESS":
        return payload

    payload["ready"] = True
    raw = result.result
    task_result = raw if isinstance(raw, dict) else {}
    payload["result"] = task_result

    if task_result.get("status") == _TASK_RESULT_ERROR:
        payload["status"] = STATUS_FAILURE
        payload["error"] = task_result.get("message") or "任务执行失败"
        return payload

    payload["status"] = STATUS_SUCCESS
    # 导出成功时把 file_id / file_name 提到顶层，轮询方不用再钻 result 拿下载参数。
    if task_result.get("file_id"):
        payload["file_id"] = task_result["file_id"]
    if task_result.get("file_name"):
        payload["file_name"] = task_result["file_name"]
    return payload
