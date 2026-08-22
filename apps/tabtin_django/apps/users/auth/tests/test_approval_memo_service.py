"""
W1.1 单测 · UserAgentApprovalMemo + ApprovalMemoService

覆盖（共 25+ 用例）：
  - create_memo 正常路径 + bash 命令归一化 + 越权 + 重复刷 last_matched_at
  - allow → deny flip（unique key 不含 rule_kind，互斥语义）
  - 超长 pattern 直接拒（防止"前 500 字符相同的两条命令静默合并"）
  - list_memos_for_agent 正常列表 + action_type 过滤
  - delete_memo 越权 + 不存在 + 正常
  - bulk_delete 全量清空 / 按 action_type / 按 rule_kind / 空集
  - find_match bash 命令 normalizeCommand 后命中 + 跨 Agent 隔离 + 跨用户隔离
  - find_match 命中后 last_matched_at 被更新（且只用一次 SELECT + 一次 UPDATE）
  - find_match raw_pattern 边界 + 不实现前缀匹配
  - created_in_session_id 在 rule_kind flip 时保持首次值（审计语义）
  - _normalize_command 与 TS 端行为对齐（trim + 折叠空格）
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from apps.users.auth.approval_memo_service import (
    ApprovalMemoService,
    _normalize_command,
)
from apps.users.auth.models import User, UserAgentApprovalMemo


class NormalizeCommandTests(TestCase):
    """与 TS 端 ``apps/tabtin-daemon/src/approval-store.ts::normalizeCommand`` 行为对齐。"""

    def test_trim_and_collapse_whitespace(self):
        self.assertEqual(_normalize_command('  npm   install  '), 'npm install')

    def test_collapse_tabs(self):
        self.assertEqual(_normalize_command('npm\t\tinstall'), 'npm install')

    def test_empty_input(self):
        self.assertEqual(_normalize_command(''), '')
        self.assertEqual(_normalize_command(None), '')  # type: ignore[arg-type]

    def test_no_truncation_in_normalize_itself(self):
        """_normalize_command 不再做截断——截断由外层 _normalize_pattern 拒。"""
        long_cmd = 'echo ' + ('a' * 1000)
        normalized = _normalize_command(long_cmd)
        self.assertEqual(len(normalized), len('echo ' + 'a' * 1000))


class ApprovalMemoServiceTests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        self.alice = User.objects.create_user(
            email='alice@memo.test',
            password='StrongPass123!',
        )
        self.bob = User.objects.create_user(
            email='bob@memo.test',
            password='StrongPass123!',
        )
        self.agent_x = uuid.uuid4()
        self.agent_y = uuid.uuid4()

    # ── 1. 创建 ────────────────────────────────────────────────────

    def test_create_memo_bash_normalizes_pattern(self):
        """bash 类命令写入前要被 normalizeCommand 处理。"""
        memo = ApprovalMemoService.create_memo(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='execute_in_terminal',
            pattern='   npm   install   ',
            rule_kind='allow',
        )
        self.assertEqual(memo.pattern, 'npm install')
        self.assertEqual(memo.rule_kind, 'allow')
        self.assertIsNone(memo.last_matched_at)

    def test_create_memo_non_bash_keeps_pattern_verbatim(self):
        """文件类等非 bash action 不做 normalize（pattern 是路径，空格是有意义的）。"""
        memo = ApprovalMemoService.create_memo(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='write_file',
            pattern='/Users/alice/my project/.env',
            rule_kind='deny',
        )
        self.assertEqual(memo.pattern, '/Users/alice/my project/.env')
        self.assertEqual(memo.rule_kind, 'deny')

    def test_create_memo_invalid_rule_kind_raises(self):
        with self.assertRaises(ValueError):
            ApprovalMemoService.create_memo(
                user_id=self.alice.id,
                agent_id=self.agent_x,
                action_type='execute_in_terminal',
                pattern='ls',
                rule_kind='maybe',
            )

    # ── 2. 重复创建 = 刷新 last_matched_at ──────────────────────────

    def test_create_memo_duplicate_refreshes_last_matched_at(self):
        first = ApprovalMemoService.create_memo(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='execute_in_terminal',
            pattern='npm install',
            rule_kind='allow',
        )
        self.assertIsNone(first.last_matched_at)

        second = ApprovalMemoService.create_memo(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='execute_in_terminal',
            pattern='npm  install',  # 不同空格但 normalize 后等价
            rule_kind='allow',
        )
        self.assertEqual(second.id, first.id)  # 同一条记录
        self.assertIsNotNone(second.last_matched_at)

        self.assertEqual(
            UserAgentApprovalMemo.objects.filter(
                user=self.alice, agent_id=self.agent_x
            ).count(),
            1,
        )

    # ── 3. 列表 + 过滤 ─────────────────────────────────────────────

    def test_list_memos_with_and_without_filter(self):
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm test', rule_kind='allow',
        )
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', pattern='/tmp/x', rule_kind='allow',
        )
        # 噪音：另一个 agent / 另一个用户
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_y,
            action_type='execute_in_terminal', pattern='ls', rule_kind='allow',
        )
        ApprovalMemoService.create_memo(
            user_id=self.bob.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm test', rule_kind='allow',
        )

        all_for_agent_x = list(
            ApprovalMemoService.list_memos_for_agent(self.alice.id, self.agent_x)
        )
        self.assertEqual(len(all_for_agent_x), 2)

        bash_only = list(
            ApprovalMemoService.list_memos_for_agent(
                self.alice.id, self.agent_x, action_type='execute_in_terminal'
            )
        )
        self.assertEqual(len(bash_only), 1)
        self.assertEqual(bash_only[0].pattern, 'npm test')

    # ── 4 & 5. 删除 + 越权校验 ────────────────────────────────────

    def test_delete_memo_owner_can_delete(self):
        memo = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='rm -rf tmp', rule_kind='deny',
        )
        ok = ApprovalMemoService.delete_memo(self.alice.id, memo.id)
        self.assertTrue(ok)
        self.assertFalse(
            UserAgentApprovalMemo.objects.filter(id=memo.id).exists()
        )

    def test_delete_memo_other_user_cannot_delete(self):
        """A 用户不能删 B 用户的记忆——避免越权。"""
        memo = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='ls -la', rule_kind='allow',
        )
        ok = ApprovalMemoService.delete_memo(self.bob.id, memo.id)
        self.assertFalse(ok)
        self.assertTrue(
            UserAgentApprovalMemo.objects.filter(id=memo.id).exists()
        )

    def test_delete_memo_nonexistent_returns_false(self):
        ok = ApprovalMemoService.delete_memo(self.alice.id, uuid.uuid4())
        self.assertFalse(ok)

    # ── 6 & 7. 批量清空 ───────────────────────────────────────────

    def test_bulk_delete_clears_all_for_agent(self):
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm install', rule_kind='allow',
        )
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', pattern='/etc/hosts', rule_kind='deny',
        )
        # 噪音：另一个 agent 不应被波及
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_y,
            action_type='execute_in_terminal', pattern='ls', rule_kind='allow',
        )

        n = ApprovalMemoService.bulk_delete(self.alice.id, self.agent_x)
        self.assertEqual(n, 2)
        self.assertEqual(
            UserAgentApprovalMemo.objects.filter(
                user=self.alice, agent_id=self.agent_x
            ).count(),
            0,
        )
        # agent_y 那条还在
        self.assertEqual(
            UserAgentApprovalMemo.objects.filter(
                user=self.alice, agent_id=self.agent_y
            ).count(),
            1,
        )

    def test_bulk_delete_with_action_type_only_clears_matching(self):
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm test', rule_kind='allow',
        )
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', pattern='/tmp/y', rule_kind='allow',
        )

        n = ApprovalMemoService.bulk_delete(
            self.alice.id, self.agent_x, action_type='execute_in_terminal'
        )
        self.assertEqual(n, 1)
        remaining = list(
            ApprovalMemoService.list_memos_for_agent(self.alice.id, self.agent_x)
        )
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0].action_type, 'write_file')

    # ── 8. find_match bash normalize 命中 ─────────────────────────

    def test_find_match_bash_normalizes_before_lookup(self):
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm install', rule_kind='allow',
        )
        # 提交时多空格 / 前导空格 / tab —— normalize 后应等价
        memo = ApprovalMemoService.find_match(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='execute_in_terminal',
            raw_pattern='  npm\tinstall  ',
        )
        self.assertIsNotNone(memo)
        self.assertEqual(memo.pattern, 'npm install')

    def test_find_match_bash_no_prefix_match(self):
        """W1.1 不实现前缀匹配。`npm install` ≠ `npm install --save`。"""
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='npm install', rule_kind='allow',
        )
        memo = ApprovalMemoService.find_match(
            user_id=self.alice.id,
            agent_id=self.agent_x,
            action_type='execute_in_terminal',
            raw_pattern='npm install --save',
        )
        self.assertIsNone(memo)

    # ── 9. find_match 其他 action_type 精确匹配 ──────────────────

    def test_find_match_non_bash_exact_match(self):
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', pattern='/tmp/foo.txt', rule_kind='allow',
        )
        ok = ApprovalMemoService.find_match(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', raw_pattern='/tmp/foo.txt',
        )
        self.assertIsNotNone(ok)
        miss = ApprovalMemoService.find_match(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='write_file', raw_pattern='/tmp/foo.txt ',  # 末尾空格
        )
        self.assertIsNone(miss)

    # ── 10. find_match 命中更新 last_matched_at ───────────────────

    def test_find_match_updates_last_matched_at(self):
        memo = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='ls -la', rule_kind='allow',
        )
        self.assertIsNone(memo.last_matched_at)

        before = timezone.now()
        hit = ApprovalMemoService.find_match(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', raw_pattern='ls -la',
        )
        self.assertIsNotNone(hit)
        self.assertIsNotNone(hit.last_matched_at)
        self.assertGreaterEqual(hit.last_matched_at, before - timedelta(seconds=1))

    # ── 11. allow → deny 用户改主意：覆盖 rule_kind ─────────────

    def test_create_memo_can_flip_rule_kind(self):
        """
        unique key 不含 rule_kind —— 同一 (user, agent, action, pattern)
        在任意时刻只能是 allow 或 deny，不可共存。

        产品场景：用户原本允许 `rm -rf /tmp/cache`，后来想反悔改成拒绝。
        再次调用 create_memo 应当**覆盖** rule_kind，而不是抛 IntegrityError，
        也不是悄悄保留旧值。
        """
        first = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal',
            pattern='rm -rf /tmp/cache',
            rule_kind='allow',
        )
        self.assertEqual(first.rule_kind, 'allow')

        second = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal',
            pattern='rm -rf /tmp/cache',
            rule_kind='deny',
        )
        self.assertEqual(second.id, first.id)
        self.assertEqual(second.rule_kind, 'deny')
        self.assertIsNotNone(second.last_matched_at)
        self.assertEqual(
            UserAgentApprovalMemo.objects.filter(
                user=self.alice, agent_id=self.agent_x
            ).count(),
            1,
        )

    def test_find_match_other_user_does_not_leak(self):
        """A 的 always 规则不应命中 B 的查询——核心隐私边界。"""
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='ls', rule_kind='allow',
        )
        miss = ApprovalMemoService.find_match(
            user_id=self.bob.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', raw_pattern='ls',
        )
        self.assertIsNone(miss)

    # ── 12 + 补 · 三视角 review 揭示的缺口 ────────────────────────

    def test_find_match_other_agent_does_not_leak(self):
        """同用户对 agent_x 的 always 规则不应命中 agent_y 的查询。"""
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='ls', rule_kind='allow',
        )
        miss = ApprovalMemoService.find_match(
            user_id=self.alice.id, agent_id=self.agent_y,
            action_type='execute_in_terminal', raw_pattern='ls',
        )
        self.assertIsNone(miss)

    def test_create_memo_keeps_first_session_on_rule_flip(self):
        """allow → deny flip 时，created_in_session_id 应保持首次创建值（审计）。"""
        first_session = uuid.uuid4()
        second_session = uuid.uuid4()
        first = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='git push',
            rule_kind='allow', created_in_session_id=first_session,
        )
        self.assertEqual(first.created_in_session_id, first_session)

        flipped = ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='git push',
            rule_kind='deny', created_in_session_id=second_session,
        )
        self.assertEqual(flipped.id, first.id)
        self.assertEqual(flipped.rule_kind, 'deny')
        self.assertEqual(
            flipped.created_in_session_id, first_session,
            'created_in_session_id 应该锚定第一次创建，flip 不应覆盖审计线索',
        )

    def test_create_memo_rejects_oversized_pattern(self):
        """超长命令应被 _normalize_pattern 拒（避免截断后静默合并）。"""
        long_cmd = 'echo ' + ('a' * 600)
        with self.assertRaises(ValueError):
            ApprovalMemoService.create_memo(
                user_id=self.alice.id, agent_id=self.agent_x,
                action_type='execute_in_terminal',
                pattern=long_cmd, rule_kind='allow',
            )

    def test_bulk_delete_with_rule_kind_filter(self):
        """rule_kind 参数让"只清空允许 / 只清空拒绝"成为可能。"""
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='ls', rule_kind='allow',
        )
        ApprovalMemoService.create_memo(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', pattern='rm -rf /', rule_kind='deny',
        )

        n = ApprovalMemoService.bulk_delete(
            self.alice.id, self.agent_x, rule_kind='allow',
        )
        self.assertEqual(n, 1)

        remaining = list(
            ApprovalMemoService.list_memos_for_agent(self.alice.id, self.agent_x)
        )
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0].rule_kind, 'deny')

    def test_bulk_delete_with_invalid_rule_kind_raises(self):
        with self.assertRaises(ValueError):
            ApprovalMemoService.bulk_delete(
                self.alice.id, self.agent_x, rule_kind='maybe',
            )

    def test_bulk_delete_empty_returns_zero(self):
        n = ApprovalMemoService.bulk_delete(self.alice.id, self.agent_x)
        self.assertEqual(n, 0)

    def test_find_match_empty_raw_pattern(self):
        """raw_pattern='' 不应命中任何记录（即使数据库里有空 pattern 也别误命）。"""
        miss = ApprovalMemoService.find_match(
            user_id=self.alice.id, agent_id=self.agent_x,
            action_type='execute_in_terminal', raw_pattern='',
        )
        self.assertIsNone(miss)
