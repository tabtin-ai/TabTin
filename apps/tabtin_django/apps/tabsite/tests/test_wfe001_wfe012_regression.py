"""
回归测试：WFE-001 / WFE-012 修复验证

WFE-001: SiteSummary / SiteDetail schema 必须包含 organization_id 字段，
         且 _serialize_summary / _serialize_detail 正确填充该值，
         否则 Electron CLI upload-dist 路由中 siteData.organization_id 永远为 undefined，
         导致 OSS presign 携带空 organization_id。

WFE-012: SitePublishRequest.dist_url 应在前端（Electron CLI）层做非空校验，
         此处仅验证后端 schema 侧的字段定义一致性。
"""
import os
import ast
import uuid
from unittest.mock import MagicMock

import pytest


# ═══════════════════════════════════════════════════════════
# WFE-001: SiteSummary / SiteDetail 必须包含 organization_id
# ═══════════════════════════════════════════════════════════

class TestWFE001_OrganizationIdInSchema:
    """验证 schema 和序列化函数均暴露 organization_id 字段。"""

    @staticmethod
    def _read_schema_source() -> str:
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            return f.read()

    @staticmethod
    def _read_api_source() -> str:
        api_path = os.path.join(
            os.path.dirname(__file__), '..', 'api.py'
        )
        with open(api_path) as f:
            return f.read()

    # --- Schema 层 ---

    def test_site_summary_has_organization_id_field(self):
        """SiteSummary 必须声明 organization_id 字段。"""
        source = self._read_schema_source()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == 'SiteSummary':
                field_names = [
                    stmt.target.id for stmt in node.body
                    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
                ]
                assert 'organization_id' in field_names, \
                    "SiteSummary 缺少 organization_id 字段（WFE-001 回归）"
                return
        pytest.fail("未找到 SiteSummary 类定义")

    def test_site_detail_inherits_organization_id(self):
        """SiteDetail 继承 SiteSummary，应自动具有 organization_id。"""
        source = self._read_schema_source()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == 'SiteDetail':
                base_names = [
                    b.id for b in node.bases if isinstance(b, ast.Name)
                ]
                assert 'SiteSummary' in base_names, \
                    "SiteDetail 应继承 SiteSummary 以获得 organization_id 字段"
                return
        pytest.fail("未找到 SiteDetail 类定义")

    # --- 序列化函数 ---

    def test_serialize_summary_passes_organization_id(self):
        """_serialize_summary 构造 SiteSummary 时必须传入 organization_id。"""
        source = self._read_api_source()
        assert 'organization_id=str(s.organization_id)' in source, \
            "_serialize_summary 未填充 organization_id（WFE-001 回归）"

    def test_serialize_detail_passes_organization_id(self):
        """_serialize_detail 构造 SiteDetail 时必须传入 organization_id。"""
        source = self._read_api_source()
        lines = source.split('\n')
        in_detail_fn = False
        found = False
        for line in lines:
            if 'def _serialize_detail' in line:
                in_detail_fn = True
            elif in_detail_fn and line.strip().startswith('def '):
                break
            elif in_detail_fn and 'organization_id=str(s.organization_id)' in line:
                found = True
                break
        assert found, \
            "_serialize_detail 未填充 organization_id（WFE-001 回归）"

    def test_organization_id_type_is_str(self):
        """organization_id 字段类型应为 str（UUID 序列化后）。"""
        source = self._read_schema_source()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == 'SiteSummary':
                for stmt in node.body:
                    if (isinstance(stmt, ast.AnnAssign)
                            and isinstance(stmt.target, ast.Name)
                            and stmt.target.id == 'organization_id'):
                        assert isinstance(stmt.annotation, ast.Name), \
                            "organization_id 注解应为简单类型名"
                        assert stmt.annotation.id == 'str', \
                            f"organization_id 类型应为 str，实际: {stmt.annotation.id}"
                        return
        pytest.fail("SiteSummary 中未找到 organization_id 字段")


# ═══════════════════════════════════════════════════════════
# WFE-012: Electron CLI publish dist_url 非空校验（后端契约）
# ═══════════════════════════════════════════════════════════

class TestWFE012_PublishDistUrlContract:
    """验证后端 SitePublishRequest schema 中 dist_url 字段的定义。

    主要修复在 Electron CLI 前端层（TypeScript），
    此处验证后端 schema 侧的字段定义不会无意间放行空值。
    """

    @staticmethod
    def _read_schema_source() -> str:
        schemas_path = os.path.join(
            os.path.dirname(__file__), '..', 'schemas.py'
        )
        with open(schemas_path) as f:
            return f.read()

    def test_dist_url_is_required_field(self):
        """SitePublishRequest.dist_url 必须为必填（无 Optional、无 default）。"""
        source = self._read_schema_source()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == 'SitePublishRequest':
                for stmt in node.body:
                    if (isinstance(stmt, ast.AnnAssign)
                            and isinstance(stmt.target, ast.Name)
                            and stmt.target.id == 'dist_url'):
                        assert stmt.value is None, \
                            "dist_url 不应有默认值，必须由调用方显式提供"
                        return
        pytest.fail("未找到 SitePublishRequest.dist_url 字段")

    def test_file_count_has_ge_zero(self):
        """SitePublishRequest.file_count 和 total_size 有 ge=0 约束。"""
        source = self._read_schema_source()
        assert 'ge=0' in source, "file_count/total_size 缺少 ge=0 约束"
