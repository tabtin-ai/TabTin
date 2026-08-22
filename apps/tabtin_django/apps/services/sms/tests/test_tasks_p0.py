"""COM-5 / COM-6 回归测试

验证短信任务不再通过 .apply_async().get() 阻塞 worker。
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import inspect  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

import pytest  # noqa: E402


# ---------------------------------------------------------------------------
# COM-5: send_verification_code_async 不再 .get() 死锁
# ---------------------------------------------------------------------------

class TestCOM5VerificationCodeNonBlocking:
    """COM-5: send_verification_code_async 不再调用 .apply_async().get()"""

    def test_no_apply_async_get_in_source(self):
        """确保源代码中 send_verification_code_async 不包含 .apply_async().get() 调用。"""
        import ast
        from apps.services.sms.tasks import send_verification_code_async
        source = inspect.getsource(send_verification_code_async)
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Call)
                and isinstance(node.func.value.func, ast.Attribute)
                and node.func.value.func.attr == "apply_async"):
                pytest.fail("send_verification_code_async 不应调用 .apply_async().get()")

    def test_calls_sms_service_directly(self):
        """验证码发送应直接调用短信服务。"""
        from apps.services.sms.tasks import send_verification_code_async
        source = inspect.getsource(send_verification_code_async)
        assert "sms_service.send_sms" in source or "get_sms_service" in source

    def test_uses_settings_sign_name(self):
        """验证码发送应使用 settings 配置的签名。"""
        from apps.services.sms.tasks import send_verification_code_async
        source = inspect.getsource(send_verification_code_async)
        assert "ALIYUN_SMS_SIGN_NAME" in source

    def test_uses_settings_template_code(self):
        """验证码发送应使用 settings 配置的模板码。"""
        from apps.services.sms.tasks import send_verification_code_async
        source = inspect.getsource(send_verification_code_async)
        assert "ALIYUN_SMS_TEMPLATE_CODE" in source
        assert "example-template-code" not in source


# ---------------------------------------------------------------------------
# COM-6: send_batch_sms_async 不再 .get() + 幂等保护
# ---------------------------------------------------------------------------

class TestCOM6BatchSmsNonBlocking:
    """COM-6: send_batch_sms_async 不再调用 .get() + 幂等保护。"""

    def test_no_apply_async_get_in_source(self):
        """确保源代码中 send_batch_sms_async 不包含 .get()。"""
        from apps.services.sms.tasks import send_batch_sms_async
        source = inspect.getsource(send_batch_sms_async)
        assert ".get()" not in source, "send_batch_sms_async 不应调用 .get()"

    def test_uses_delay_for_dispatch(self):
        """批量发送应使用 .delay() 分发子任务。"""
        from apps.services.sms.tasks import send_batch_sms_async
        source = inspect.getsource(send_batch_sms_async)
        assert "send_sms_async.delay" in source

    def test_has_idempotency_check(self):
        """批量发送应检查已存在记录（幂等保护）。"""
        from apps.services.sms.tasks import send_batch_sms_async
        source = inspect.getsource(send_batch_sms_async)
        assert "existing_records" in source or "existing_phones" in source


class TestHardcodedSignNameRemoved:
    """验证硬编码的签名已被替换为 settings 配置。"""

    def test_send_sms_uses_settings(self):
        from apps.services.sms.tasks import send_sms_async
        source = inspect.getsource(send_sms_async)
        assert "ALIYUN_SMS_SIGN_NAME" in source


class TestDeprecatedVerificationApiTemplateConfig:
    """验证 deprecated 验证码入口也不再硬编码模板码。"""

    def test_send_code_uses_settings_template(self):
        from apps.services.sms.api import send_verification_code
        source = inspect.getsource(send_verification_code)
        assert "ALIYUN_SMS_TEMPLATE_CODE" in source
        assert "example-template-code" not in source
