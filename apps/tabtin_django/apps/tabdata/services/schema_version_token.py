"""C3 / Wave 1.3：Table schema_version_token 服务（trash 副作用闭环）。

业务背景
--------

PRD §C3 P0：管理员废弃旧表后，Celery 持续报 "table not found"，因为还有未执行
完的 computed / connector / link_integrity 等任务。

设计要点
--------

1. **token 模型**：
   - ``Table.schema_version_token`` UUID 字段，``trash`` / ``delete`` /
     ``restore`` 时 bump（重新生成 UUID）。
   - 任务发布时 freeze 当前 token 进 task kwargs。
   - Worker 执行前 ``validate_table_schema_token(table_id, expected_token)``
     校验，不一致 no-op + info 日志（不抛异常，不重试）。

2. **A+B 组合策略**（任务说明推荐）：
   - **A**（本模块）：token 防御，所有未消费的旧任务执行时自动跳过
   - **B**（task-level fix）：``celery_app.control.revoke(task_id)`` 主动
     取消已发布但未执行的任务（扩展点，本期暂不强制每个 task 接入）

3. **ChangeLog**：每次 bump 写一条 ``ChangeLog(change_type='schema_version_token_bumped')``，
   带 ``agent_run_id / session_id``（C5 链路）+ ``previous_token / new_token``
   元数据。Wave 3 D1 灰度时可据此对账。

4. **fail-safe**：DB 异常向上传播，让 caller 决定是否回滚事务；非 DB 异常
   按"防御性 no-op"处理，避免影响主链路。
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional, Tuple
from uuid import UUID

from django.db import transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)


# ── 任务发布时 freeze token 的统一 kwargs key ──
#
# 所有接入 token 防御的 Celery task 都应通过 ``kwargs[FROZEN_TOKEN_KEY]``
# 携带任务发布时的 token 值。worker 入口处 :func:`assert_table_token_or_skip`
# 校验，过期返回 None。
FROZEN_TOKEN_KEY = "_table_schema_version_token"


# ── 异常类型 ──
#
# 不用 Exception 让上层 Celery 重试机制误以为是瞬时故障；返回判定结果给 caller
# 自行处理（task 通常返回 ``{"status": "skipped", "reason": "table_token_mismatch"}`` ）。


def get_table_schema_version_token(table_id: UUID | str) -> Optional[str]:
    """获取 Table 当前的 ``schema_version_token``。

    :param table_id: Table UUID
    :returns: token 字符串；表不存在或读取失败返回 None
    """
    from apps.tabdata.models import Table

    try:
        token_value = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table_id)
            .values_list("schema_version_token", flat=True)
            .first()
        )
    except Exception:
        logger.warning(
            "[SchemaToken] 读取失败 table=%s",
            table_id, exc_info=True,
        )
        return None

    return str(token_value) if token_value else None


def bump_table_schema_version_token(
    table_id: UUID | str,
    *,
    reason: str,
    user=None,
    write_changelog: bool = True,
) -> Tuple[Optional[str], Optional[str]]:
    """bump Table.schema_version_token（生成新 UUID）+ 写 ChangeLog（C5 链路）。

    :param table_id: Table UUID
    :param reason: bump 原因（``trash`` / ``delete`` / ``restore`` /
        ``permanent_delete``），写进 ChangeLog summary
    :param user: 操作用户（写 ChangeLog editor_id）
    :param write_changelog: 是否写 ChangeLog（单元测试可关闭）
    :returns: (previous_token, new_token)。表不存在返回 (None, None)。
    :raises Exception: DB 异常向上传播，让 caller 决定是否回滚事务
    """
    from apps.tabdata.models import Table

    new_token = uuid.uuid4()

    # 单事务：先 SELECT FOR UPDATE 拿当前 token，再 UPDATE
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(id=table_id)
            .only("id", "schema_version_token", "name")
            .first()
        )
        if table is None:
            return None, None

        previous_token = str(table.schema_version_token)
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            schema_version_token=new_token,
        )

    new_token_str = str(new_token)
    logger.info(
        "[SchemaToken] bumped: table=%s reason=%s previous=%s new=%s",
        table_id, reason, previous_token, new_token_str,
    )

    if write_changelog:
        _write_token_bump_changelog(
            table_id=table_id,
            previous_token=previous_token,
            new_token=new_token_str,
            reason=reason,
            user=user,
            table_name=table.name,
        )

    return previous_token, new_token_str


def assert_table_token_or_skip(
    table_id: UUID | str,
    expected_token: Optional[str],
    *,
    task_name: str = "",
) -> bool:
    """C3 worker 入口校验：当前 token 与 task 发布时 freeze 的 token 一致才继续。

    使用方式（在每个接入 token 防御的 Celery task 函数体起始处调用）::

        @shared_task(bind=True, ...)
        def my_table_task(self, table_id: str, **kwargs):
            from apps.tabdata.services.schema_version_token import (
                FROZEN_TOKEN_KEY, assert_table_token_or_skip,
            )
            expected_token = kwargs.get(FROZEN_TOKEN_KEY)
            if not assert_table_token_or_skip(table_id, expected_token, task_name="my_table_task"):
                return {"status": "skipped", "reason": "table_token_mismatch"}
            # ... 正常业务逻辑

    :param table_id: Table UUID
    :param expected_token: task 发布时 freeze 的 token；None 表示该 task 未启用
        token 防御（向后兼容旧调用方）—— 此时**不**做校验直接返回 True。
    :param task_name: task 名（仅日志用，方便定位）
    :returns: True 表示可继续执行；False 表示 token 漂移，task 应 no-op
    """
    if not expected_token:
        # 旧调用方未启用 token 防御 → 透传
        return True

    current_token = get_table_schema_version_token(table_id)
    if current_token is None:
        # 表已不存在（permanent_delete）→ no-op
        logger.info(
            "[SchemaToken] task skipped: table=%s task=%s reason=table_not_found "
            "(token freeze=%s)",
            table_id, task_name, expected_token,
        )
        return False

    if str(current_token) != str(expected_token):
        # token 漂移 → no-op
        logger.info(
            "[SchemaToken] task skipped: table=%s task=%s reason=token_mismatch "
            "(freeze=%s current=%s)",
            table_id, task_name, expected_token, current_token,
        )
        return False

    return True


def _write_token_bump_changelog(
    *,
    table_id: UUID | str,
    previous_token: str,
    new_token: str,
    reason: str,
    user=None,
    table_name: str = "",
) -> None:
    """C5 / Wave 1.1：把 token bump 写进 ChangeLog 让 contributors 反查能定位。

    与 ``api_undo_redo.restore_table`` / ``undo_redo_field_restore`` 中 ChangeLog
    写入路径对齐。
    """
    try:
        from apps.collab.models import ChangeLog

        agent_run_id = ""
        session_id = ""
        try:
            from apps.services.common.platform_context import (
                get_current_run_id, get_current_session_id,
            )
            agent_run_id = get_current_run_id() or ""
            session_id = get_current_session_id() or ""
        except Exception:
            pass

        editor_id = ""
        editor_name = ""
        editor_type = "user"
        if user is not None:
            editor_id = str(getattr(user, "id", "") or "")
            editor_name = str(
                getattr(user, "nickname", "")
                or getattr(user, "username", "")
                or ""
            )
            if agent_run_id:
                editor_type = "agent"

        ChangeLog.objects.using("postgresql").create(
            resource_type="table",
            resource_id=table_id,
            change_type="schema_version_token_bumped",
            summary=f"表「{table_name}」schema_version_token 已 bump（{reason}）",
            changes={
                "reason": reason,
                "previous_token": previous_token,
                "new_token": new_token,
                "wave": "1.3",
            },
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            session_id=session_id,
        )
    except Exception:
        # ChangeLog 写入失败不阻塞主流程，与 api_undo_redo.restore_table 一致
        logger.warning(
            "[SchemaToken] ChangeLog 写入失败 table=%s reason=%s",
            table_id, reason, exc_info=True,
        )
