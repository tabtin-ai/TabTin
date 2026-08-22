"""
TabMemo 错误码一致性测试

验证 memo_service.py 和 api.py 中所有 ServiceError 使用的错误码
都在 ErrorCode 枚举中定义，杜绝硬编码字符串。
"""

import ast
import inspect
import textwrap

from django.test import SimpleTestCase


class ErrorCodeConsistencyTests(SimpleTestCase):
    """确保 service/api 中使用的错误码都在 ErrorCode 枚举中定义"""

    @staticmethod
    def _extract_service_error_codes(source: str) -> list[str]:
        """从源代码 AST 中提取所有 ServiceError(...) 的第一个参数（若为字符串常量）"""
        dedented = textwrap.dedent(source)
        tree = ast.parse(dedented)
        codes: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            is_service_error = (
                (isinstance(func, ast.Name) and func.id == "ServiceError")
                or (isinstance(func, ast.Attribute) and func.attr == "ServiceError")
            )
            if is_service_error and node.args:
                first_arg = node.args[0]
                if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str):
                    codes.append(first_arg.value)
        return codes

    @staticmethod
    def _extract_error_response_codes(source: str) -> list[str]:
        """从源代码 AST 中提取所有 error_response_with_status(...) 的第一个参数"""
        dedented = textwrap.dedent(source)
        tree = ast.parse(dedented)
        codes: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            is_target = (
                (isinstance(func, ast.Name) and func.id == "error_response_with_status")
                or (isinstance(func, ast.Attribute) and func.attr == "error_response_with_status")
            )
            if is_target and node.args:
                first_arg = node.args[0]
                if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str):
                    codes.append(first_arg.value)
        return codes

    def test_memo_service_has_no_hardcoded_error_codes(self):
        from apps.tabmemo.services.memo_service import MemoService

        source = inspect.getsource(MemoService)
        hardcoded = self._extract_service_error_codes(source)
        self.assertEqual(
            hardcoded, [],
            f"MemoService 中存在硬编码错误码: {hardcoded}，应使用 ErrorCode 枚举",
        )

    def test_api_has_no_hardcoded_error_codes(self):
        import apps.tabmemo.api as api_module

        source = inspect.getsource(api_module)
        hardcoded_service = self._extract_service_error_codes(source)
        hardcoded_response = self._extract_error_response_codes(source)
        all_hardcoded = hardcoded_service + hardcoded_response
        self.assertEqual(
            all_hardcoded, [],
            f"api.py 中存在硬编码错误码: {all_hardcoded}，应使用 ErrorCode 枚举",
        )

    @staticmethod
    def _extract_errorcode_attrs(source: str) -> set[str]:
        """从 AST 中提取所有 ErrorCode.XXX 引用（属性名）"""
        tree = ast.parse(textwrap.dedent(source))
        attrs: set[str] = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "ErrorCode"
                and node.attr.isupper()
            ):
                attrs.add(node.attr)
        return attrs

    def test_all_used_error_codes_are_defined(self):
        import apps.tabmemo.api as api_module
        from apps.tabmemo.error_codes import ErrorCode
        from apps.tabmemo.services.memo_service import MemoService

        defined_attrs = {
            name for name in dir(ErrorCode)
            if name.isupper() and not name.startswith("_")
        }

        used_attrs: set[str] = set()
        used_attrs |= self._extract_errorcode_attrs(inspect.getsource(MemoService))
        used_attrs |= self._extract_errorcode_attrs(inspect.getsource(api_module))

        for attr in used_attrs:
            self.assertIn(
                attr, defined_attrs,
                f"使用的错误码属性 ErrorCode.{attr} 未在 ErrorCode 中定义",
            )
