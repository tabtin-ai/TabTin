"""
统一审批 · 用户记忆层服务（W1.1）

封装对 ``UserAgentApprovalMemo`` 的最小 CRUD：
  - 这一波（W1.1）只做"自家用户域内的纯增删查改"；
  - 后续 W1.2 才会在 ``apps/services/common/`` 加"合并 agent_config 治理层 +
    UserAgentApprovalMemo 记忆层"的查询服务，那时跨 app 调用会更合理；
  - 所以这里位置贴近 verification_manager.py / session_manager.py 同 app 风格，
    不放 services/common/。

产品语义参考 ``apps/users/auth/models.py::UserAgentApprovalMemo`` docstring。
"""

from __future__ import annotations

import re
from typing import Optional
from uuid import UUID

from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from .models import UserAgentApprovalMemo


# pattern 字段持久化上限：与 TS 端 ``apps/tabtin-daemon/src/approval-store.ts``
# 的 ``MAX_COMMAND_LEN`` 对齐 + 留 12 字符余量给 model 字段 max_length=512。
# 写入前做 raw 长度校验，超长直接拒 ValueError——避免"两条不同的长命令前 500
# 完全相同 → normalize 后落到同一行 → 第二次写入悄悄覆盖第一条 rule_kind"
# 的静默漏失（W1.1 三视角 review 真问题）。
MAX_PATTERN_LEN = 500


def _normalize_command(command: str) -> str:
    """
    bash 类命令归一化。

    与 TS ``normalizeCommand`` 行为对齐：
      - trim 前后空白；
      - 多余空白（含 tab）折叠为单个空格；
      - **不做截断**——截断在外层 ``_normalize_pattern`` 里做"过长直接拒"
        （见 ``MAX_PATTERN_LEN``）。这避免了"两条只有最后一段不同的长命令
        被截到同一个 pattern"导致静默合并的真数据漏失。

    已知的两端语义差异（D-tech-7 后续会统一）：
      - ``\\s`` 在 TS / Python 的 BMP 外字符（U+0085 NEL / U+FEFF BOM 等）匹配
        范围略有不同，但典型 bash 命令场景踩不到。
      - TS ``trim()`` 与 Python ``strip()`` 的 Unicode whitespace 表 99% 重叠。

    本函数当前仅做最小对齐。
    """
    if not command:
        return ''
    return re.sub(r'\s+', ' ', command.strip())


def _is_bash_action(action_type: str) -> bool:
    """是否需要走命令归一化的 action_type。当前只有终端类。"""
    return action_type == 'execute_in_terminal'


def _normalize_pattern(action_type: str, raw_pattern: str) -> str:
    """
    根据 action_type 决定 pattern 写入前的归一化策略。

    超长 pattern（>MAX_PATTERN_LEN 字符）直接抛 ValueError——理由见
    ``MAX_PATTERN_LEN`` 注释。"过长就不收"对用户体验代价低（这条命令本来就
    不应该自动批准），对数据完整性收益高。
    """
    normalized = _normalize_command(raw_pattern) if _is_bash_action(action_type) else (raw_pattern or '')
    if len(normalized) > MAX_PATTERN_LEN:
        raise ValueError(
            f'pattern too long after normalize ({len(normalized)} chars); '
            f'must be <= {MAX_PATTERN_LEN}. action_type={action_type!r}'
        )
    return normalized


class ApprovalMemoService:
    """
    UserAgentApprovalMemo 的服务封装。

    所有方法都是 ``@staticmethod``——服务本身无状态，按 Django 项目内
    类似 ``ToolPermissionGuard`` 的风格组织。
    """

    @staticmethod
    def create_memo(
        user_id: str,
        agent_id: UUID,
        action_type: str,
        pattern: str,
        rule_kind: str,
        created_in_session_id: Optional[UUID] = None,
    ) -> UserAgentApprovalMemo:
        """
        创建（或更新）一条 always 记忆。

        unique key (user, agent_id, action_type, pattern) **不包含 rule_kind**。
        意味着同一个 (用户, Agent, action_type, 命令) 在任意时刻只能有一行
        — 允许 / 拒绝二选一。这符合业务直觉：用户对同一条命令同时存在
        "允许 + 拒绝"两条记录是矛盾态。

        语义：
          - pattern 在写入前按 action_type 归一化（终端类走 normalizeCommand）；
          - 命中重复 unique key 时**不抛异常**：
            - 如果新的 ``rule_kind`` 与已有相同 → 仅刷新 ``last_matched_at``；
            - 如果不同（比如用户原来点了 allow，现在改点 deny）→ 覆盖
              ``rule_kind``，同时刷新 ``last_matched_at``；
            - ``created_in_session_id`` 沿用最早那条的（保留首次创建的审计线索，
              不被后续更新覆盖）；
          - rule_kind 只能是 'allow' / 'deny'。
        """
        if rule_kind not in {
            UserAgentApprovalMemo.RULE_KIND_ALLOW,
            UserAgentApprovalMemo.RULE_KIND_DENY,
        }:
            raise ValueError(
                f"rule_kind must be 'allow' or 'deny', got {rule_kind!r}"
            )
        if not action_type:
            raise ValueError('action_type is required')

        normalized_pattern = _normalize_pattern(action_type, pattern)

        with transaction.atomic(using='default'):
            memo, created = UserAgentApprovalMemo.objects.get_or_create(
                user_id=user_id,
                agent_id=agent_id,
                action_type=action_type,
                pattern=normalized_pattern,
                defaults={
                    'rule_kind': rule_kind,
                    'created_in_session_id': created_in_session_id,
                },
            )
            if not created:
                update_fields = ['last_matched_at']
                memo.last_matched_at = timezone.now()
                if memo.rule_kind != rule_kind:
                    memo.rule_kind = rule_kind
                    update_fields.append('rule_kind')
                memo.save(update_fields=update_fields)
        return memo

    @staticmethod
    def list_memos_for_agent(
        user_id: str,
        agent_id: UUID,
        action_type: Optional[str] = None,
    ) -> QuerySet[UserAgentApprovalMemo]:
        """列出该用户对该 Agent 的所有记忆。可按 action_type 过滤。"""
        qs = UserAgentApprovalMemo.objects.filter(
            user_id=user_id,
            agent_id=agent_id,
        )
        if action_type:
            qs = qs.filter(action_type=action_type)
        return qs.order_by('-created_at')

    @staticmethod
    def delete_memo(user_id: str, memo_id: UUID) -> bool:
        """
        按主键删除一条记忆。

        必须校验 user 归属——只能删自己的。
        返回值：True = 真的删掉了一行；False = 没找到 / 不属于该用户。
        """
        deleted, _ = UserAgentApprovalMemo.objects.filter(
            id=memo_id,
            user_id=user_id,
        ).delete()
        return deleted > 0

    @staticmethod
    def bulk_delete(
        user_id: str,
        agent_id: UUID,
        action_type: Optional[str] = None,
        rule_kind: Optional[str] = None,
    ) -> int:
        """
        批量清空该用户对该 Agent 的记忆。

        过滤条件可叠加：
        - ``action_type=None`` → 不限定类型；
        - ``rule_kind=None`` → 同时清 allow + deny；
        - 全 None 时 = 该 (用户, Agent) 下全部记忆——这是产品上的"核按钮"，
          调用方应在 UI 上做二次确认。
        - ``rule_kind`` 参数让"只清空允许列表 / 只清空拒绝列表"成为可能
          （Phase 5 UI 真实需求）。

        返回真的删掉的行数。
        """
        if rule_kind is not None and rule_kind not in {
            UserAgentApprovalMemo.RULE_KIND_ALLOW,
            UserAgentApprovalMemo.RULE_KIND_DENY,
        }:
            raise ValueError(
                f"rule_kind must be 'allow' / 'deny' / None, got {rule_kind!r}"
            )

        qs = UserAgentApprovalMemo.objects.filter(
            user_id=user_id,
            agent_id=agent_id,
        )
        if action_type:
            qs = qs.filter(action_type=action_type)
        if rule_kind:
            qs = qs.filter(rule_kind=rule_kind)
        deleted, _ = qs.delete()
        return deleted

    @staticmethod
    def find_match(
        user_id: str,
        agent_id: UUID,
        action_type: str,
        raw_pattern: str,
    ) -> Optional[UserAgentApprovalMemo]:
        """
        给定一次工具调用，查 (user, agent, action_type, pattern) 是否命中 always 记忆。

        匹配规则：
          - 先对 raw_pattern 走与 create_memo 相同的归一化（终端类 normalizeCommand）；
          - 在该 (user, agent, action_type) 范围内查 pattern 精确匹配的记录；
          - unique key 保证同一 (user, agent, action_type, pattern) 至多一行
            （allow / deny 互斥，不会共存）—— 不需要"deny 优先"的优先级逻辑；
          - 方案 §4.4 的"deny 永远优先于 allow"是**跨层**优先级（治理层 deny
            > 记忆层 allow），不是 Memo 单表内冲突——跨层判决由 W1.2
            ApprovalRulesService 串联，本表只回答"用户对这条规则的最终选择"；
          - 命中时更新该行 last_matched_at；
          - 返回的 ``rule_kind`` 由调用方判断 allow / deny。

        当前不实现前缀匹配——pattern 的 unique key 设计就是按精确等价存的。
        TS 端 ``commandMatches`` 的前缀语义是 D-tech-7 后续两端统一时再处理。
        """
        if not action_type:
            return None
        normalized_pattern = _normalize_pattern(action_type, raw_pattern)

        memo = UserAgentApprovalMemo.objects.filter(
            user_id=user_id,
            agent_id=agent_id,
            action_type=action_type,
            pattern=normalized_pattern,
        ).first()
        if memo is None:
            return None

        # 用 .update() 而不是 .save() 的真理由：避免写全字段 + 跑全字段
        # validators + 触发 save 信号——find_match 是工具调用热路径。
        # 字段没有 auto_now，不存在"避免 auto_now"问题。
        # 本地内存同步 last_matched_at 即可，不再二次 SELECT。
        now = timezone.now()
        UserAgentApprovalMemo.objects.filter(pk=memo.pk).update(last_matched_at=now)
        memo.last_matched_at = now
        return memo


__all__ = ['ApprovalMemoService', '_normalize_command']
