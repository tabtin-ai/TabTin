"""
CD-013 / CD-016 回归测试

CD-013: iter_descendant_tokens BFS 遍历必须有深度上限，与 MAX_DELEGATION_DEPTH 一致。
CD-016: OpenApiAuth._authenticate_jwt 必须只接受 access 类型 token，拒绝 daemon/refresh 等。
"""

import uuid
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, SimpleTestCase

from apps.tabdata.auth_open_api import OpenApiAuth
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models_token import TableApiToken, TokenTargetValidationError


# ── CD-013: iter_descendant_tokens 深度上限 ──


class IterDescendantTokensDepthLimitTests(SimpleTestCase):
    """CD-013: iter_descendant_tokens 的 BFS 深度不得超过 MAX_DELEGATION_DEPTH。"""

    def test_depth_limit_matches_ancestor_limit(self):
        """子树遍历和祖先遍历使用相同的深度上限常量。"""
        import inspect
        source = inspect.getsource(TableApiToken.iter_descendant_tokens)
        self.assertIn('MAX_DELEGATION_DEPTH', source)

    def test_shallow_tree_traverses_normally(self):
        """深度在限制内的合法子树能正常遍历完。"""
        root = MagicMock(spec=TableApiToken)
        root.pk = uuid.uuid4()
        root.MAX_DELEGATION_DEPTH = 10

        child = MagicMock(spec=TableApiToken)
        child.pk = uuid.uuid4()
        child.iter_child_tokens.return_value = []

        root.iter_child_tokens.return_value = [child]

        result = list(TableApiToken.iter_descendant_tokens(root))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].pk, child.pk)

    def test_exceeding_depth_raises_error(self):
        """超过 MAX_DELEGATION_DEPTH 的子树触发 TokenTargetValidationError。"""
        max_depth = TableApiToken.MAX_DELEGATION_DEPTH

        nodes = []
        for i in range(max_depth + 2):
            node = MagicMock(spec=TableApiToken)
            node.pk = uuid.uuid4()
            node.MAX_DELEGATION_DEPTH = max_depth
            nodes.append(node)

        for i in range(len(nodes) - 1):
            nodes[i].iter_child_tokens.return_value = [nodes[i + 1]]
        nodes[-1].iter_child_tokens.return_value = []

        with self.assertRaises(TokenTargetValidationError) as cm:
            list(TableApiToken.iter_descendant_tokens(nodes[0]))

        error_msg = str(cm.exception)
        self.assertIn('深度超过上限', error_msg)

    def test_cycle_detection_still_works(self):
        """循环检测在深度限制下依然生效。"""
        root = MagicMock(spec=TableApiToken)
        root.pk = uuid.uuid4()
        root.MAX_DELEGATION_DEPTH = 10

        child = MagicMock(spec=TableApiToken)
        child.pk = uuid.uuid4()
        child.iter_child_tokens.return_value = [root]

        root.iter_child_tokens.return_value = [child]

        with self.assertRaises(TokenTargetValidationError) as cm:
            list(TableApiToken.iter_descendant_tokens(root))

        error_msg = str(cm.exception)
        self.assertIn('循环', error_msg)


# ── CD-016: OpenApiAuth._authenticate_jwt token_type 白名单 ──


class OpenApiAuthTokenTypeTests(SimpleTestCase):
    """CD-016: _authenticate_jwt 必须只接受 token_type='access'。"""

    def setUp(self):
        self.factory = RequestFactory()
        self.auth = OpenApiAuth()

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    def test_rejects_daemon_token(self, mock_verify):
        """daemon 类型 token 必须被拒绝。"""
        mock_verify.return_value = {
            'user_id': str(uuid.uuid4()),
            'token_type': 'daemon',
        }
        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'fake-jwt-token')
        self.assertIsNone(result)

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    def test_rejects_refresh_token(self, mock_verify):
        """refresh 类型 token 仍然被拒绝。"""
        mock_verify.return_value = {
            'user_id': str(uuid.uuid4()),
            'token_type': 'refresh',
        }
        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'fake-jwt-token')
        self.assertIsNone(result)

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    def test_rejects_unknown_token_type(self, mock_verify):
        """未知 token_type 必须被拒绝。"""
        mock_verify.return_value = {
            'user_id': str(uuid.uuid4()),
            'token_type': 'unknown_type',
        }
        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'fake-jwt-token')
        self.assertIsNone(result)

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    def test_rejects_missing_token_type(self, mock_verify):
        """缺少 token_type 字段的 payload 必须被拒绝。"""
        mock_verify.return_value = {
            'user_id': str(uuid.uuid4()),
        }
        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'fake-jwt-token')
        self.assertIsNone(result)

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    @patch('apps.tabdata.auth_open_api.User.objects')
    def test_accepts_access_token(self, mock_user_objects, mock_verify):
        """access 类型 token 正常通过认证。"""
        user_id = uuid.uuid4()
        mock_verify.return_value = {
            'user_id': str(user_id),
            'token_type': 'access',
        }
        mock_user = MagicMock()
        mock_user.id = user_id
        mock_user_objects.get.return_value = mock_user

        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'fake-jwt-token')
        self.assertEqual(result, mock_user)

    @patch('apps.tabdata.auth_open_api.verify_jwt_token')
    def test_invalid_token_returns_none(self, mock_verify):
        """无效 token（verify 返回 None）返回 None。"""
        mock_verify.return_value = None
        request = self.factory.get('/api/v1/test')
        result = self.auth._authenticate_jwt(request, 'invalid-token')
        self.assertIsNone(result)
