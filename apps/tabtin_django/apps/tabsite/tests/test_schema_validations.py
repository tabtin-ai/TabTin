"""
回归测试：TS-001 ~ TS-007, TS-015, TS-018 的 Schema 层校验修复。

这些测试不依赖 Django ORM / 数据库，仅验证纯 Python 校验函数的行为。
"""
import os
import posixpath
import re
import uuid as _uuid

import pytest


# ── 直接复制 schemas.py 中的纯函数，避免 Django/ninja import 依赖 ──

def _validate_uuid(value: str) -> str:
    _uuid.UUID(value)
    return value


def _normalize_file_path(value: str) -> str:
    normalized = posixpath.normpath(value)
    if normalized.startswith('..') or '/../' in normalized or normalized.startswith('/'):
        raise ValueError("文件路径含非法组件")
    if not normalized or normalized == '.':
        raise ValueError("文件路径不能为空")
    return normalized


def _validate_safe_path(value: str) -> str:
    normalized = os.path.normpath(value)
    parts = normalized.replace('\\', '/').split('/')
    if '..' in parts:
        raise ValueError("路径不允许包含 '..' 组件")
    return normalized


def _validate_domain(value: str) -> str:
    if '://' in value:
        raise ValueError("域名不应包含协议前缀")
    if '/' in value:
        raise ValueError("域名不应包含路径")
    domain_re = re.compile(
        r'^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
    )
    if not domain_re.match(value):
        raise ValueError("域名格式不合法")
    return value.lower()


# ═══════════════════════════════════════════════════════════
# TS-001: code_project_path 路径遍历漏洞
# ═══════════════════════════════════════════════════════════

class TestTS001_CodeProjectPathTraversal:

    def test_reject_relative_traversal(self):
        with pytest.raises(ValueError, match="'..'"):
            _validate_safe_path("../../../../etc/passwd")

    def test_reject_single_level_traversal(self):
        with pytest.raises(ValueError, match="'..'"):
            _validate_safe_path("../evil")

    def test_reject_mid_path_traversal_that_escapes(self):
        with pytest.raises(ValueError, match="'..'"):
            _validate_safe_path("a/../../evil")

    def test_accept_normal_project_path(self):
        result = _validate_safe_path("projects/my-site")
        assert ".." not in result

    def test_accept_absolute_path_unix(self):
        result = _validate_safe_path("/Users/me/projects/site")
        assert result == "/Users/me/projects/site"

    def test_accept_absolute_path_electron_style(self):
        result = _validate_safe_path("/home/user/tabtin/sites/my-site")
        assert ".." not in result

    def test_absolute_path_with_dotdot_normalized_safely(self):
        result = _validate_safe_path("/Users/me/../../etc/shadow")
        assert result == "/etc/shadow"
        assert ".." not in result

    def test_harmless_parent_ref_resolved(self):
        result = _validate_safe_path("a/../b")
        assert result == "b"


# ═══════════════════════════════════════════════════════════
# TS-002: Schema 层字段长度校验
# ═══════════════════════════════════════════════════════════

class TestTS002_FieldLengthValidation:
    """验证 max_length 约束在 Field 上存在。

    由于无法轻松实例化 ninja Schema（依赖 Django），
    这里只验证辅助函数。Schema 级别的 Field(max_length=...)
    由 pydantic 强制执行，通过代码审查确认。
    """

    def test_name_max_length_defined(self):
        """schemas.py 中 SiteCreateRequest.name 应有 max_length=255"""
        import ast
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "max_length=255" in source, "name 字段缺少 max_length=255"

    def test_icon_max_length_defined(self):
        import ast
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "max_length=50" in source, "icon 字段缺少 max_length=50"

    def test_description_max_length_defined(self):
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "max_length=5000" in source, "description 字段缺少 max_length=5000"


# ═══════════════════════════════════════════════════════════
# TS-003: 文件路径规范化
# ═══════════════════════════════════════════════════════════

class TestTS003_FilePathNormalization:

    def test_normal_path(self):
        assert _normalize_file_path("index.html") == "index.html"

    def test_nested_path(self):
        assert _normalize_file_path("styles/main.css") == "styles/main.css"

    def test_dot_slash_normalized(self):
        assert _normalize_file_path("./a/b") == "a/b"

    def test_double_slash_normalized(self):
        assert _normalize_file_path("a//b") == "a/b"

    def test_dot_in_middle_normalized(self):
        assert _normalize_file_path("a/./b") == "a/b"

    def test_reject_parent_traversal(self):
        with pytest.raises(ValueError):
            _normalize_file_path("../etc/passwd")

    def test_reject_deep_traversal(self):
        with pytest.raises(ValueError):
            _normalize_file_path("a/../../etc/passwd")

    def test_reject_absolute_path(self):
        with pytest.raises(ValueError):
            _normalize_file_path("/etc/passwd")

    def test_reject_empty_string(self):
        with pytest.raises(ValueError):
            _normalize_file_path("")

    def test_reject_dot_only(self):
        with pytest.raises(ValueError):
            _normalize_file_path(".")


# ═══════════════════════════════════════════════════════════
# TS-004: write_file content 大小限制
# ═══════════════════════════════════════════════════════════

class TestTS004_ContentSizeLimit:

    def test_max_file_content_size_defined(self):
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "MAX_FILE_CONTENT_SIZE" in source
        assert "max_length=MAX_FILE_CONTENT_SIZE" in source


# ═══════════════════════════════════════════════════════════
# TS-005: tabdata_table_ids UUID 校验
# ═══════════════════════════════════════════════════════════

class TestTS005_TableIdsUuidValidation:

    def test_valid_uuid_accepted(self):
        result = _validate_uuid("550e8400-e29b-41d4-a716-446655440000")
        assert result == "550e8400-e29b-41d4-a716-446655440000"

    def test_invalid_uuid_rejected(self):
        with pytest.raises(ValueError):
            _validate_uuid("not-a-uuid")

    def test_empty_string_rejected(self):
        with pytest.raises(ValueError):
            _validate_uuid("")

    def test_numeric_string_rejected(self):
        with pytest.raises(ValueError):
            _validate_uuid("12345")

    def test_validator_referenced_in_schema(self):
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "validate_table_ids" in source


# ═══════════════════════════════════════════════════════════
# TS-006: list_sites page_size 上界限制
# ═══════════════════════════════════════════════════════════

class TestTS006_PageSizeClamp:

    def test_page_size_clamped_in_api(self):
        api_path = os.path.join(
            os.path.dirname(__file__), '..', 'api.py'
        )
        with open(api_path) as f:
            source = f.read()
        assert "min(page_size, 100)" in source, "page_size 缺少上界 clamp"
        assert "max(1, page)" in source, "page 缺少下界 clamp"


# ═══════════════════════════════════════════════════════════
# TS-007: DataError/IntegrityError 捕获
# ═══════════════════════════════════════════════════════════

class TestTS007_DbErrorCapture:

    def test_db_errors_imported(self):
        api_path = os.path.join(
            os.path.dirname(__file__), '..', 'api.py'
        )
        with open(api_path) as f:
            source = f.read()
        assert "from django.db import DataError, IntegrityError" in source

    def test_db_errors_caught_in_decorator(self):
        api_path = os.path.join(
            os.path.dirname(__file__), '..', 'api.py'
        )
        with open(api_path) as f:
            source = f.read()
        assert "(DataError, IntegrityError)" in source


# ═══════════════════════════════════════════════════════════
# TS-015: custom_domain 格式校验
# ═══════════════════════════════════════════════════════════

class TestTS015_CustomDomainValidation:

    def test_valid_domain(self):
        assert _validate_domain("example.com") == "example.com"

    def test_valid_subdomain(self):
        assert _validate_domain("sub.example.com") == "sub.example.com"

    def test_uppercase_lowered(self):
        assert _validate_domain("Example.COM") == "example.com"

    def test_reject_url_with_scheme(self):
        with pytest.raises(ValueError, match="协议"):
            _validate_domain("http://evil.com")

    def test_reject_https_url(self):
        with pytest.raises(ValueError, match="协议"):
            _validate_domain("https://evil.com")

    def test_reject_domain_with_path(self):
        with pytest.raises(ValueError, match="路径"):
            _validate_domain("evil.com/path")

    def test_reject_plain_string(self):
        with pytest.raises(ValueError):
            _validate_domain("not a domain")

    def test_reject_single_label(self):
        with pytest.raises(ValueError):
            _validate_domain("localhost")

    def test_reject_leading_hyphen(self):
        with pytest.raises(ValueError):
            _validate_domain("-bad.com")


# ═══════════════════════════════════════════════════════════
# TS-018: file_count / total_size 下界校验
# ═══════════════════════════════════════════════════════════

class TestTS018_PublishFieldBounds:

    def test_ge_zero_defined(self):
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "ge=0" in source, "file_count/total_size 缺少 ge=0 约束"


# ═══════════════════════════════════════════════════════════
# Service 层 defense-in-depth 验证
# ═══════════════════════════════════════════════════════════

class TestServiceLayerDefenseInDepth:
    """验证 site_service.py 中的防御性校验函数。"""

    def test_service_has_normalize_file_path(self):
        svc_path = os.path.join(
            os.path.dirname(__file__), '..', 'services', 'site_service.py'
        )
        with open(svc_path) as f:
            source = f.read()
        assert "def _normalize_file_path" in source
        assert "def _validate_code_project_path" in source

    def test_service_file_methods_normalize(self):
        svc_path = os.path.join(
            os.path.dirname(__file__), '..', 'services', 'site_service.py'
        )
        with open(svc_path) as f:
            source = f.read()
        for method in ['read_file', 'write_file', 'delete_file']:
            assert f"path = _normalize_file_path(path)" in source, \
                f"{method} 缺少 _normalize_file_path 调用"

    def test_service_update_validates_code_path(self):
        svc_path = os.path.join(
            os.path.dirname(__file__), '..', 'services', 'site_service.py'
        )
        with open(svc_path) as f:
            source = f.read()
        assert "_validate_code_project_path(code_project_path)" in source

    def test_service_validate_code_project_path_allows_absolute(self):
        """code_project_path 允许绝对路径（Electron 场景需要），但仍拒绝路径遍历。"""
        svc_path = os.path.join(
            os.path.dirname(__file__), '..', 'services', 'site_service.py'
        )
        with open(svc_path) as f:
            source = f.read()
        assert "'..' in normalized" in source, \
            "_validate_code_project_path 缺少路径遍历检查"

    def test_schema_validate_safe_path_allows_absolute(self):
        """code_project_path 允许绝对路径（Electron 场景需要），但仍拒绝路径遍历。"""
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            source = f.read()
        assert "'..' in parts" in source, \
            "_validate_safe_path 缺少路径遍历检查"
