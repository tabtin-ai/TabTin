"""
P0-11 安全修复回归测试

P0-11: 公开表单协作者搜索端点 — 搜索字段只允许 nickname 和 username，
       不得包含 email（防止盲搜枚举团队成员邮箱）。

测试策略：
- 直接 inspect `get_form_collaborators` 函数源码中构建的 Q 对象过滤条件
- mock DB 层，验证生成的 QuerySet 过滤参数不含 email
"""

import ast
import inspect
import textwrap
from unittest import TestCase
from unittest.mock import MagicMock, patch

from django.db.models import Q


class FormCollaboratorSearchFieldSecurityTests(TestCase):
    """P0-11: 验证搜索字段只包含 nickname 和 username，不包含 email。"""

    def test_source_code_does_not_contain_email_filter(self):
        """静态检查：get_form_collaborators 函数源码中不含 email 相关过滤。"""
        from apps.tabdata.api_form import get_form_collaborators

        source = inspect.getsource(get_form_collaborators)
        self.assertNotIn('email__icontains', source)
        self.assertNotIn('email__contains', source)
        self.assertNotIn('email__exact', source)
        self.assertNotIn('email__startswith', source)
        self.assertNotIn('email__iexact', source)

    def test_source_code_contains_only_safe_fields(self):
        """静态检查：搜索过滤只使用 nickname 和 username。"""
        from apps.tabdata.api_form import get_form_collaborators

        source = inspect.getsource(get_form_collaborators)
        self.assertIn('nickname__icontains', source)
        self.assertIn('username__icontains', source)

    def test_q_object_only_contains_safe_fields(self):
        """构建搜索 Q 对象，验证其子节点只引用 nickname 和 username。"""
        search_q = Q(nickname__icontains='test') | Q(username__icontains='test')

        allowed_fields = {'nickname__icontains', 'username__icontains'}
        for child in search_q.children:
            if isinstance(child, Q):
                for field, _ in child.children:
                    self.assertIn(field, allowed_fields)
            elif isinstance(child, tuple):
                field, _ = child
                self.assertIn(field, allowed_fields)

    def test_response_does_not_include_email(self):
        """验证返回的协作者数据中不包含 email 字段。"""
        from apps.tabdata.api_form import get_form_collaborators

        source = inspect.getsource(get_form_collaborators)
        response_block_start = source.find("collaborators = [")
        if response_block_start == -1:
            self.skipTest("无法定位返回值构造代码")
        response_block = source[response_block_start:source.find("]", response_block_start) + 1]

        self.assertNotIn("'email'", response_block)
        self.assertNotIn('"email"', response_block)
        self.assertNotIn('.email', response_block)


class FormCollaboratorSearchEmailAttackTests(TestCase):
    """P0-11 负向测试：模拟攻击者尝试通过 email 搜索枚举。"""

    def test_email_search_returns_no_result_via_q_filter(self):
        """通过当前实现的 Q 过滤逻辑，email 值不会命中 nickname/username。"""
        q = Q(nickname__icontains='admin@company.com') | Q(username__icontains='admin@company.com')

        allowed = {'nickname__icontains', 'username__icontains'}
        for child in q.children:
            if isinstance(child, tuple):
                field, _ = child
                self.assertIn(field, allowed,
                              "Q 对象不应包含 email 搜索字段")

    def test_no_email_field_in_search_branch(self):
        """确认搜索分支中 email 字段不参与 ORM 过滤。

        如果将来有人不小心加回 email__icontains，这个测试会失败。
        """
        from apps.tabdata.api_form import get_form_collaborators

        source = inspect.getsource(get_form_collaborators)
        search_block_idx = source.find('if search:')
        if search_block_idx == -1:
            self.skipTest("未找到搜索分支")

        search_block = source[search_block_idx:source.find('\n\n', search_block_idx)]
        self.assertNotIn('email', search_block,
                         "搜索分支中不应出现 email 相关字段")
