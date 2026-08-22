"""
CD-010 / CD-011 / CD-012 回归测试

CD-010: validate_parent_delegation while 循环必须有 MAX_DELEGATION_DEPTH 深度限制
CD-011: require_space_access 不得通过不同状态码泄露 Space 存在性
CD-012: _build_token_validation_error 不得将委托链内部状态泄露给调用方
"""

import uuid
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, SimpleTestCase

from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models_token import (
    TableApiToken,
    TokenTargetValidationError,
)
from apps.tabdata.api_token import (
    _build_token_validation_error,
    _DELEGATION_CHAIN_INTERNAL_KEYWORDS,
    _GENERIC_DELEGATION_ERROR,
)
from apps.tabdata.auth_open_api import require_space_access


# ── CD-010: validate_parent_delegation 深度限制 ──


class DelegationDepthLimitTests(SimpleTestCase):
    """CD-010: validate_parent_delegation 必须在超过 MAX_DELEGATION_DEPTH 时拒绝"""

    def _build_chain(self, depth):
        """构建一条 depth 长的 Token 链，返回 (child, tokens_dict)"""
        user_id = uuid.uuid4()
        tokens = []
        for i in range(depth):
            token = TableApiToken(
                id=uuid.uuid4(),
                user_id=user_id,
                token_id=f'test_{i}',
                scopes=['record:read'],
                is_active=True,
                rate_limit=60,
            )
            tokens.append(token)

        for i in range(1, depth):
            tokens[i].parent_token_id = tokens[i - 1].id

        child = TableApiToken(
            id=uuid.uuid4(),
            user_id=user_id,
            token_id='test_child',
            scopes=['record:read'],
            parent_token_id=tokens[-1].id,
            is_active=True,
            rate_limit=60,
        )

        tokens_by_id = {str(t.pk): t for t in tokens}
        return child, tokens[-1], tokens_by_id

    def test_validate_parent_delegation_rejects_deep_chain(self):
        """构造超过 MAX_DELEGATION_DEPTH 的链应抛出 TokenTargetValidationError"""
        depth = TableApiToken.MAX_DELEGATION_DEPTH + 2
        child, direct_parent, tokens_by_id = self._build_chain(depth)

        def mock_get(**kwargs):
            pk = str(kwargs.get('pk'))
            if pk in tokens_by_id:
                return tokens_by_id[pk]
            raise TableApiToken.DoesNotExist()

        mock_qs = MagicMock()
        mock_qs.only.return_value = mock_qs
        mock_qs.get = mock_get

        with patch.object(
            child, '_get_parent_token_for_validation', return_value=direct_parent
        ), patch.object(
            TableApiToken.objects, 'using', return_value=mock_qs
        ), patch.object(
            TableApiToken, 'validate_within_parent_boundary'
        ):
            with self.assertRaises(TokenTargetValidationError) as ctx:
                child.validate_parent_delegation()

            self.assertIn('深度超过上限', str(ctx.exception))

    def test_validate_parent_delegation_allows_within_limit(self):
        """链深度恰好在 MAX_DELEGATION_DEPTH 内应通过"""
        depth = TableApiToken.MAX_DELEGATION_DEPTH
        child, direct_parent, tokens_by_id = self._build_chain(depth)

        def mock_get(**kwargs):
            pk = str(kwargs.get('pk'))
            if pk in tokens_by_id:
                return tokens_by_id[pk]
            raise TableApiToken.DoesNotExist()

        mock_qs = MagicMock()
        mock_qs.only.return_value = mock_qs
        mock_qs.get = mock_get

        with patch.object(
            child, '_get_parent_token_for_validation', return_value=direct_parent
        ), patch.object(
            TableApiToken.objects, 'using', return_value=mock_qs
        ), patch.object(
            TableApiToken, 'validate_within_parent_boundary'
        ):
            result = child.validate_parent_delegation()
            self.assertIsNotNone(result)


# ── CD-011: require_space_access 不泄露 Space 存在性 ──


class SpaceEnumerationPreventionTests(SimpleTestCase):
    """CD-011: 无论 Space 是否存在，权限不足时均返回 403 和相同消息"""

    def setUp(self):
        self.factory = RequestFactory()

    def _make_request(self, space_id):
        request = self.factory.get(f'/test/?space_id={space_id}')
        request.auth = MagicMock(id=uuid.uuid4())
        request.api_token = None
        return request

    def _call_decorated_view(self, request, space_id):
        @require_space_access
        def dummy_view(request, space_id=None):
            return 200, {'ok': True}

        return dummy_view(request, space_id=space_id)

    def test_nonexistent_space_returns_403(self):
        """不存在的 Space 应返回 403 而非 404"""
        fake_space_id = str(uuid.uuid4())
        request = self._make_request(fake_space_id)

        with patch('apps.tabtinspace.models.Space.objects') as mock_objects:
            mock_objects.filter.return_value.exists.return_value = False
            result = self._call_decorated_view(request, fake_space_id)

        status, body = result
        self.assertEqual(status, 403)
        self.assertEqual(body.get('code') or body.get('error_code'), 'SPACE_ACCESS_DENIED')

    def test_existing_space_no_permission_returns_403(self):
        """存在但无权限的 Space 也应返回 403"""
        fake_space_id = str(uuid.uuid4())
        request = self._make_request(fake_space_id)

        with patch('apps.tabtinspace.models.Space.objects') as mock_objects, \
             patch('apps.tabtinspace.services.base.BaseService') as MockService:
            mock_objects.filter.return_value.exists.return_value = True
            MockService.return_value.check_space_permission.return_value = False
            result = self._call_decorated_view(request, fake_space_id)

        status, body = result
        self.assertEqual(status, 403)
        self.assertEqual(body.get('code') or body.get('error_code'), 'SPACE_ACCESS_DENIED')

    def test_response_does_not_contain_space_id(self):
        """错误响应中不应包含 space_id 值"""
        fake_space_id = str(uuid.uuid4())
        request = self._make_request(fake_space_id)

        with patch('apps.tabtinspace.models.Space.objects') as mock_objects:
            mock_objects.filter.return_value.exists.return_value = False
            result = self._call_decorated_view(request, fake_space_id)

        status, body = result
        self.assertEqual(status, 403)
        self.assertNotIn(fake_space_id, str(body))

    def test_both_responses_have_same_message(self):
        """不存在和无权限的 Space 应返回相同的错误消息"""
        nonexistent_space_id = str(uuid.uuid4())
        existing_space_id = str(uuid.uuid4())

        request1 = self._make_request(nonexistent_space_id)
        with patch('apps.tabtinspace.models.Space.objects') as mock_objects:
            mock_objects.filter.return_value.exists.return_value = False
            result1 = self._call_decorated_view(request1, nonexistent_space_id)

        request2 = self._make_request(existing_space_id)
        with patch('apps.tabtinspace.models.Space.objects') as mock_objects, \
             patch('apps.tabtinspace.services.base.BaseService') as MockService:
            mock_objects.filter.return_value.exists.return_value = True
            MockService.return_value.check_space_permission.return_value = False
            result2 = self._call_decorated_view(request2, existing_space_id)

        _, body1 = result1
        _, body2 = result2
        self.assertEqual(body1.get('message'), body2.get('message'))


# ── CD-012: 委托链错误消息屏蔽 ──


class DelegationErrorMessageRedactionTests(SimpleTestCase):
    """CD-012: 委托链内部状态消息不得暴露给 API 调用方"""

    def test_internal_keywords_are_redacted(self):
        """所有委托链内部关键词消息都应被替换为通用消息"""
        for keyword in _DELEGATION_CHAIN_INTERNAL_KEYWORDS:
            exc = TokenTargetValidationError(
                f'包含{keyword}的详细内部消息',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
            result = _build_token_validation_error(exc)
            status_code, body = result
            self.assertNotIn(
                keyword,
                body.get('message', ''),
                f'关键词 "{keyword}" 不应出现在响应消息中',
            )
            self.assertEqual(body.get('message', ''), _GENERIC_DELEGATION_ERROR)

    def test_non_internal_message_passes_through(self):
        """非内部状态的普通验证错误消息应正常传递"""
        exc = TokenTargetValidationError(
            'Token 权限范围不足',
            error_code=ErrorCode.VALIDATION_ERROR,
            status_code=400,
        )
        result = _build_token_validation_error(exc)
        status_code, body = result
        self.assertEqual(body.get('message', ''), 'Token 权限范围不足')

    def test_not_found_errors_still_handled(self):
        """NOT_FOUND 类型的错误仍应正常路由到对应处理"""
        exc = TokenTargetValidationError(
            '目标父 Token 不存在',
            error_code=ErrorCode.NOT_FOUND,
            status_code=404,
        )
        result = _build_token_validation_error(exc)
        status_code, body = result
        self.assertEqual(status_code, 404)

    def test_broken_chain_message_logged_and_redacted(self):
        """'父链路已损坏' 消息应记录日志但不返回给调用方"""
        exc = TokenTargetValidationError(
            'Token 父链路已损坏，无法建立委托链',
            error_code=ErrorCode.VALIDATION_ERROR,
            status_code=400,
        )
        with patch('apps.tabdata.api_token.logger') as mock_logger:
            result = _build_token_validation_error(exc)
            mock_logger.warning.assert_called_once()
            logged_msg = mock_logger.warning.call_args[0][1]
            self.assertIn('父链路已损坏', logged_msg)

        status_code, body = result
        self.assertNotIn('父链路已损坏', body.get('message', ''))
        self.assertEqual(body.get('message', ''), _GENERIC_DELEGATION_ERROR)
