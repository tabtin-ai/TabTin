"""
DVC-006 / DVC-021 回归测试

DVC-006: _verify_presign_ownership 区分 Redis 连接异常（降级放行）与 key 不存在（拒绝）
DVC-021: confirm-upload-batch 批次级前置配额校验，防止中间超配额产生孤儿 FileRecord
"""
import uuid
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase


# ---------------------------------------------------------------------------
# DVC-006: _verify_presign_ownership 回归测试
# ---------------------------------------------------------------------------
class VerifyPresignOwnershipTest(SimpleTestCase):
    """_verify_presign_ownership 应区分 Redis 连接异常与 key 不存在"""

    def _call(self, object_key: str, user_id: str):
        from apps.services.oss.api import _verify_presign_ownership
        return _verify_presign_ownership(object_key, user_id)

    @patch("apps.services.oss.api.django_cache")
    def test_key_exists_and_owner_matches(self, mock_cache):
        """cache 命中且 owner 匹配 → 返回 None（校验通过）"""
        user_id = str(uuid.uuid4())
        mock_cache.get.return_value = user_id
        result = self._call("tabsite/sites/abc/file.js", user_id)
        self.assertIsNone(result)

    @patch("apps.services.oss.api.django_cache")
    def test_key_exists_but_owner_mismatch(self, mock_cache):
        """cache 命中但 owner 不匹配 → 返回错误"""
        real_owner = str(uuid.uuid4())
        attacker = str(uuid.uuid4())
        mock_cache.get.return_value = real_owner
        result = self._call("tabsite/sites/abc/file.js", attacker)
        self.assertIsNotNone(result)
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "OBJECT_KEY_OWNERSHIP_MISMATCH")

    @patch("apps.services.oss.api.django_cache")
    def test_key_not_found_rejects(self, mock_cache):
        """DVC-006 核心：cache 正常但 key 不存在 → 拒绝（不再降级放行）"""
        mock_cache.get.return_value = None
        result = self._call("tabsite/sites/abc/file.js", str(uuid.uuid4()))
        self.assertIsNotNone(result, "key 不存在时应该返回错误响应，而非 None（降级放行）")
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "PRESIGN_TOKEN_EXPIRED")

    @patch("apps.services.oss.api.django_cache")
    def test_redis_connection_error_degrades(self, mock_cache):
        """DVC-006 核心：Redis 连接异常 → 降级放行（返回 None）"""
        mock_cache.get.side_effect = ConnectionError("Redis unreachable")
        result = self._call("tabsite/sites/abc/file.js", str(uuid.uuid4()))
        self.assertIsNone(result, "Redis 连接异常时应降级放行（返回 None）")

    @patch("apps.services.oss.api.django_cache")
    def test_redis_timeout_error_degrades(self, mock_cache):
        """Redis 超时也应降级放行"""
        mock_cache.get.side_effect = TimeoutError("Redis timeout")
        result = self._call("tabsite/sites/abc/file.js", str(uuid.uuid4()))
        self.assertIsNone(result, "Redis 超时时应降级放行（返回 None）")

    @patch("apps.services.oss.api.django_cache")
    def test_owner_type_coercion(self, mock_cache):
        """cache 中存的可能是 int/UUID，比对应做类型转换"""
        user_id = str(uuid.uuid4())
        mock_cache.get.return_value = user_id
        result = self._call("some/key", user_id)
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# DVC-021: confirm-upload-batch 批次级配额预检回归测试
# ---------------------------------------------------------------------------
class ConfirmUploadBatchQuotaPreCheckTest(SimpleTestCase):
    """confirm_upload_batch 应在处理任何文件前做批次级配额校验"""

    def _make_item(self, object_key="k", file_name="f.js", file_size=1024,
                   organization_id="ws-1", **kwargs):
        item = MagicMock()
        item.object_key = object_key
        item.file_name = file_name
        item.file_size = file_size
        item.organization_id = organization_id
        item.content_type = kwargs.get("content_type", "application/javascript")
        item.module = kwargs.get("module", "tabsite")
        item.context_type = kwargs.get("context_type", "site")
        item.context_id = kwargs.get("context_id", "ctx-1")
        item.file_hash = kwargs.get("file_hash", "")
        return item

    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.api.get_oss_service")
    @patch("apps.services.oss.api._verify_presign_ownership", return_value=None)
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    @patch("apps.services.oss.api._get_user_id", return_value="user-1")
    def test_batch_quota_exceeded_rejects_entire_batch(
        self, mock_uid, mock_validate, mock_presign, mock_oss, mock_register,
    ):
        """DVC-021 核心：批次总量超配额时应拒绝整个批次，不注册任何 FileRecord"""
        from apps.services.oss.api import confirm_upload_batch

        mock_request = MagicMock()
        mock_request.META = {"REMOTE_ADDR": "127.0.0.1"}
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()

        data = MagicMock()
        data.items = [
            self._make_item(object_key="tabsite/a.js", file_size=5000, organization_id="ws-1"),
            self._make_item(object_key="tabsite/b.js", file_size=5000, organization_id="ws-1"),
        ]

        with patch(
            "apps.services.billing.services.storage_service.OrganizationStorageBillingService"
            ".assert_storage_upload_allowed",
            side_effect=ValueError("Storage quota exceeded"),
        ):
            result = confirm_upload_batch(mock_request, data)

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "STORAGE_QUOTA_EXCEEDED")
        mock_register.assert_not_called()

    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.api.get_oss_service")
    @patch("apps.services.oss.api._verify_presign_ownership", return_value=None)
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    @patch("apps.services.oss.api._get_user_id", return_value="user-1")
    def test_billing_blocked_rejects_entire_batch(
        self, mock_uid, mock_validate, mock_presign, mock_oss, mock_register,
    ):
        """计费阻断时应拒绝整个批次"""
        from apps.services.oss.api import confirm_upload_batch
        from apps.services.billing.services.guard_service import BillingBlockedError

        mock_request = MagicMock()
        mock_request.META = {"REMOTE_ADDR": "127.0.0.1"}
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()

        data = MagicMock()
        data.items = [
            self._make_item(object_key="tabsite/a.js", file_size=100, organization_id="ws-1"),
        ]

        with patch(
            "apps.services.billing.services.storage_service.OrganizationStorageBillingService"
            ".assert_storage_upload_allowed",
            side_effect=BillingBlockedError(organization_id="ws-1", reason="blocked"),
        ):
            result = confirm_upload_batch(mock_request, data)

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "BILLING_BLOCKED")
        mock_register.assert_not_called()

    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.api.get_oss_service")
    @patch("apps.services.oss.api._verify_presign_ownership", return_value=None)
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    @patch("apps.services.oss.api._get_user_id", return_value="user-1")
    def test_no_organization_skips_quota_check(
        self, mock_uid, mock_validate, mock_presign, mock_oss, mock_register,
    ):
        """无 organization_id 的批次不做配额校验（直接进入循环处理）"""
        from apps.services.oss.api import confirm_upload_batch

        mock_request = MagicMock()
        mock_request.META = {"REMOTE_ADDR": "127.0.0.1"}
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()

        mock_oss_svc = mock_oss.return_value
        mock_oss_svc.file_exists.return_value = True
        mock_oss_svc.get_file_info.return_value = {"success": True, "data": {"content_length": 1024}}

        mock_record = MagicMock()
        mock_record.to_response_dict.return_value = {"id": "fr-1"}
        mock_record.mime_type = None
        mock_register.return_value = mock_record

        data = MagicMock()
        data.items = [
            self._make_item(object_key="tabsite/a.js", file_size=1024, organization_id=""),
        ]

        result = confirm_upload_batch(mock_request, data)
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["success_count"], 1)

    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.api.get_oss_service")
    @patch("apps.services.oss.api._verify_presign_ownership", return_value=None)
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    @patch("apps.services.oss.api._get_user_id", return_value="user-1")
    def test_batch_quota_aggregates_across_items(
        self, mock_uid, mock_validate, mock_presign, mock_oss, mock_register,
    ):
        """DVC-021 核心：批次配额应聚合同一 organization 的所有文件大小"""
        from apps.services.oss.api import confirm_upload_batch

        mock_request = MagicMock()
        mock_request.META = {"REMOTE_ADDR": "127.0.0.1"}
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()

        data = MagicMock()
        data.items = [
            self._make_item(object_key="tabsite/a.js", file_size=3000, organization_id="ws-1"),
            self._make_item(object_key="tabsite/b.js", file_size=4000, organization_id="ws-1"),
            self._make_item(object_key="tabsite/c.js", file_size=2000, organization_id="ws-2"),
        ]

        call_args_list = []

        def track_calls(organization_id, incoming_bytes):
            call_args_list.append((organization_id, incoming_bytes))

        mock_oss_svc = mock_oss.return_value
        mock_oss_svc.file_exists.return_value = True
        mock_oss_svc.get_file_info.return_value = {"success": True, "data": {"content_length": 3000}}

        mock_record = MagicMock()
        mock_record.to_response_dict.return_value = {"id": "fr-1"}
        mock_record.mime_type = None
        mock_register.return_value = mock_record

        with patch(
            "apps.services.billing.services.storage_service.OrganizationStorageBillingService"
            ".assert_storage_upload_allowed",
            side_effect=track_calls,
        ):
            confirm_upload_batch(mock_request, data)

        ws1_calls = [c for c in call_args_list if c[0] == "ws-1"]
        ws2_calls = [c for c in call_args_list if c[0] == "ws-2"]
        self.assertEqual(len(ws1_calls), 1)
        self.assertEqual(ws1_calls[0][1], 7000, "ws-1 应聚合 3000+4000=7000")
        self.assertEqual(len(ws2_calls), 1)
        self.assertEqual(ws2_calls[0][1], 2000)
