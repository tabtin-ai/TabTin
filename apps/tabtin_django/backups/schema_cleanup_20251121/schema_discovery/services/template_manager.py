"""Template Manager Service

模板管理服务：负责模板的加载、组装和验证
"""

from typing import List, Dict, Optional
from apps.schema_discovery.models import SchemaTemplate
import logging

logger = logging.getLogger(__name__)


class TemplateManager:
    """模板管理器

    职责：
    - 加载指定的模板
    - 根据 required_modules 组装空白模板表
    - 验证填写完整性
    """

    @staticmethod
    def load_template(module_name: str) -> Optional[Dict]:
        """加载指定的模板

        Args:
            module_name: 模板名称（如 basic_schema, pagination_schema）

        Returns:
            模板 JSON 或 None（如果不存在）
        """
        try:
            template = SchemaTemplate.objects.get(
                module_name=module_name,
                is_active=True
            )
            logger.info(f"✅ 成功加载模板: {module_name} (v{template.version})")
            return template.template_json
        except SchemaTemplate.DoesNotExist:
            logger.warning(f"❌ 模板不存在: {module_name}")
            return None

    @staticmethod
    def load_templates(module_names: List[str]) -> Dict[str, Dict]:
        """批量加载模板

        Args:
            module_names: 模板名称列表

        Returns:
            {module_name: template_json} 的字典
        """
        templates = {}

        for module_name in module_names:
            template_json = TemplateManager.load_template(module_name)
            if template_json:
                templates[module_name] = template_json

        logger.info(f"📦 批量加载了 {len(templates)} 个模板")
        return templates

    @staticmethod
    def build_blank_schema(required_modules: List[str]) -> Dict:
        """根据required_modules组装空白模板表

        Args:
            required_modules: 需要的模块列表

        Returns:
            空白模板表结构
        """
        templates = TemplateManager.load_templates(required_modules)

        if not templates:
            logger.error("❌ 没有加载到任何模板")
            return {
                "modules": [],
                "fields_to_fill": {},
                "completion_status": {}
            }

        # 合并所有模板的 fields_to_fill
        all_fields = {}
        for module_name, template_json in templates.items():
            fields = template_json.get("fields_to_fill", {})
            all_fields.update(fields)

        # 初始化 completion_status
        completion_status = {}
        for field_name, field_config in all_fields.items():
            completion_status[field_name] = {
                "filled": False,
                "value": None,
                "required": field_config.get("required", False)
            }

        blank_schema = {
            "modules": required_modules,
            "fields_to_fill": all_fields,
            "completion_status": completion_status
        }

        logger.info(f"🏗️  组装空白模板表成功，包含 {len(all_fields)} 个字段")
        return blank_schema

    @staticmethod
    def validate_filled_schema(blank_schema: Dict) -> Dict:
        """验证填写完整性

        Args:
            blank_schema: 空白模板表（包含 completion_status）

        Returns:
            验证结果 {
                "is_complete": bool,
                "missing_fields": List[str],
                "filled_count": int,
                "total_count": int
            }
        """
        completion_status = blank_schema.get("completion_status", {})

        total_count = len(completion_status)
        filled_count = sum(1 for status in completion_status.values() if status.get("filled"))

        # 检查必填字段
        missing_fields = []
        for field_name, status in completion_status.items():
            if status.get("required") and not status.get("filled"):
                missing_fields.append(field_name)

        is_complete = len(missing_fields) == 0

        result = {
            "is_complete": is_complete,
            "missing_fields": missing_fields,
            "filled_count": filled_count,
            "total_count": total_count,
            "completion_rate": filled_count / total_count if total_count > 0 else 0
        }

        if is_complete:
            logger.info(f"✅ Schema 填写完整 ({filled_count}/{total_count})")
        else:
            logger.warning(f"⚠️  Schema 未完整填写 ({filled_count}/{total_count})，缺失: {missing_fields}")

        return result

    @staticmethod
    def get_all_templates() -> List[SchemaTemplate]:
        """获取所有活跃模板

        Returns:
            模板列表
        """
        templates = SchemaTemplate.objects.filter(is_active=True).order_by('module_name')
        logger.info(f"📋 获取到 {templates.count()} 个活跃模板")
        return list(templates)

    @staticmethod
    def get_template(module_name: str) -> Optional[SchemaTemplate]:
        """获取指定模板

        Args:
            module_name: 模板名称

        Returns:
            SchemaTemplate 对象或 None
        """
        try:
            template = SchemaTemplate.objects.get(
                module_name=module_name,
                is_active=True
            )
            logger.info(f"✅ 获取模板: {module_name}")
            return template
        except SchemaTemplate.DoesNotExist:
            logger.warning(f"❌ 模板不存在: {module_name}")
            return None

    @staticmethod
    def generate_from_template(module_name: str, overrides: Dict = None) -> Dict:
        """根据模板生成 Schema

        Args:
            module_name: 模板名称
            overrides: 覆盖的字段（可选）

        Returns:
            生成的 Schema
        """
        template = TemplateManager.get_template(module_name)
        if not template:
            raise ValueError(f"模板不存在: {module_name}")

        # 复制模板 JSON
        schema = template.template_json.copy()

        # 应用覆盖
        if overrides:
            schema.update(overrides)
            logger.info(f"✏️  应用了 {len(overrides)} 个覆盖字段")

        logger.info(f"🏗️  从模板 {module_name} 生成 Schema")
        return schema

    @staticmethod
    def update_completion_status(
        blank_schema: Dict,
        field_name: str,
        value: any
    ) -> Dict:
        """更新字段填写状态

        Args:
            blank_schema: 空白模板表
            field_name: 字段名
            value: 字段值

        Returns:
            更新后的 blank_schema
        """
        completion_status = blank_schema.get("completion_status", {})

        if field_name in completion_status:
            completion_status[field_name]["filled"] = True
            completion_status[field_name]["value"] = value
            logger.info(f"✏️  更新字段: {field_name}")
        else:
            logger.warning(f"⚠️  字段不存在于模板中: {field_name}")

        return blank_schema
