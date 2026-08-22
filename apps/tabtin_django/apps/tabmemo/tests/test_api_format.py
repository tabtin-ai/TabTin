"""
TabMemo API 响应格式验证测试

测试 _handle_service_error 装饰器的错误映射，使用 SimpleTestCase。
"""

from django.test import SimpleTestCase

from apps.tabtinspace.services.base import ServiceError


class HandleServiceErrorTests(SimpleTestCase):
    """验证 _handle_service_error 装饰器的错误映射"""

    def test_404_should_return_not_found_tuple(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            raise ServiceError("NOT_FOUND", "碎片不存在", status=404)

        result = view()
        self.assertIsInstance(result, tuple)
        status_code, body = result
        self.assertEqual(status_code, 404)
        self.assertFalse(body["success"])

    def test_403_should_return_permission_denied_tuple(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            raise ServiceError("PERMISSION_DENIED", "权限不足", status=403)

        result = view()
        status_code, body = result
        self.assertEqual(status_code, 403)
        self.assertFalse(body["success"])

    def test_400_should_return_generic_error_tuple(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            raise ServiceError("INVALID_INPUT", "输入无效", status=400)

        result = view()
        status_code, body = result
        self.assertEqual(status_code, 400)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "INVALID_INPUT")

    def test_success_should_pass_through(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            return {"success": True, "data": "ok"}

        result = view()
        self.assertEqual(result, {"success": True, "data": "ok"})

    def test_non_service_error_should_propagate(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            raise ValueError("unexpected")

        with self.assertRaises(ValueError):
            view()

    def test_error_message_should_be_preserved(self):
        from apps.tabmemo.api import _handle_service_error

        @_handle_service_error
        def view():
            raise ServiceError("MEMO_NOT_FOUND", "碎片不存在", status=404)

        status_code, body = view()
        self.assertEqual(body["message"], "碎片不存在")
        self.assertEqual(body["code"], "MEMO_NOT_FOUND")
