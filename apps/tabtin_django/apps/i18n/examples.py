"""
示例：如何在现有模块中使用i18n

展示如何将错误消息、API响应和LLM提示词迁移到i18n系统
"""

# ============================================================================
# 示例 1: API错误响应
# ============================================================================

# ❌ 旧代码
from apps.tabdata.error_codes import ErrorCode, ErrorMessage

def get_table_old(request, table_id: str):
    table = Table.objects.filter(id=table_id).first()
    if not table:
        return {
            "success": False,
            "code": ErrorCode.TABLE_NOT_FOUND,
            "message": "表格不存在",  # ❌ 硬编码中文
            "data": None
        }
    return {"success": True, "data": serialize_table(table)}


# ✅ 新代码 - 使用i18n
from apps.i18n.response import success_response, error_response

def get_table_new(request, table_id: str):
    table = Table.objects.filter(id=table_id).first()
    if not table:
        return error_response(
            code="TABLE_NOT_FOUND",
            message_key="resource.table_not_found",  # ✅ 自动翻译
            status_code=404
        )
    return success_response(data=serialize_table(table))


# ============================================================================
# 示例 2: 参数化错误消息
# ============================================================================

# ❌ 旧代码
def validate_field_old(field_name: str, value: Any):
    if not value:
        return {
            "success": False,
            "code": "FIELD_REQUIRED",
            "message": f"字段 {field_name} 是必填的",  # ❌ 硬编码中文
            "data": None
        }


# ✅ 新代码
from apps.i18n.response import error_response

def validate_field_new(field_name: str, value: Any):
    if not value:
        return error_response(
            code="FIELD_REQUIRED",
            message_key="validation.field_required",
            field_name=field_name  # ✅ 参数会自动替换到翻译中
        )


# ============================================================================
# 示例 3: LLM提示词多语言
# ============================================================================

# ❌ 旧代码 - 已移除的 pagination_analysis_prompts 模块
def build_pagination_analysis_prompt_old(html: str, url: str) -> str:
    return f"""你是专业的网页数据提取规则生成专家。分析页面的翻页方式。

## 页面信息
URL: {url}

## 翻页策略示例
- 滚动翻页：知乎、微博、抖音、小红书等  # ❌ 硬编码中文网站
- 点击翻页：豆瓣、淘宝搜索、京东搜索等

请返回JSON格式的分析结果。

```html
{html}
```
"""


# ✅ 新代码 - 使用i18n
from apps.i18n.prompt import prompt_i18n_manager, get_localized_prompt
from apps.i18n.language import SupportedLanguage

# 1. 注册多语言提示词（在应用启动时执行一次）
def register_prompts():
    prompt_i18n_manager.register_prompt(
        "pagination_analysis",
        {
            SupportedLanguage.ZH_CN: """你是专业的网页数据提取规则生成专家。分析页面的翻页方式。

## 页面信息
URL: {url}

## 翻页策略示例
- 滚动翻页：{example_websites}
- 点击翻页：{example_websites}

请返回JSON格式的分析结果。

```html
{html}
```
""",
            SupportedLanguage.EN_US: """You are a professional web data extraction expert. Analyze the pagination method.

## Page Information
URL: {url}

## Pagination Strategy Examples
- Scroll pagination: {example_websites}
- Click pagination: {example_websites}

Please return the analysis in JSON format.

```html
{html}
```
"""
        }
    )

# 2. 使用多语言提示词
def build_pagination_analysis_prompt_new(html: str, url: str) -> str:
    # ✅ 会根据用户语言自动选择提示词，并本地化网站示例
    return get_localized_prompt(
        "pagination_analysis",
        url=url,
        html=html
    )
    # 中文用户看到: 滚动翻页：微博、知乎、小红书、淘宝...
    # 英文用户看到: Scroll pagination: Twitter, Reddit, Medium, Amazon...


# ============================================================================
# 示例 4: 在services中使用
# ============================================================================

# ❌ 旧代码 - apps/tabdata/services/table_service.py
from apps.tabdata.error_codes import ErrorMessage

class TableService:
    def delete_table_old(self, table_id: str):
        table = self.get_table(table_id)
        if not table:
            raise ValueError("表格不存在")  # ❌ 硬编码中文

        if table.is_default:
            raise ValueError("无法删除默认表格")  # ❌ 硬编码中文

        table.delete()
        return True


# ✅ 新代码
from apps.i18n import get_text

class TableService:
    def delete_table_new(self, table_id: str):
        table = self.get_table(table_id)
        if not table:
            raise ValueError(get_text("resource.table_not_found"))  # ✅ 自动翻译

        if table.is_default:
            raise ValueError(get_text("business.default_table_delete_denied"))  # ✅ 自动翻译

        table.delete()
        return True


# ============================================================================
# 示例 5: 在Celery任务中使用
# ============================================================================

from celery import shared_task
from apps.i18n.language import set_user_language, SupportedLanguage
from apps.i18n import get_text

@shared_task
def send_notification_task(user_id: str, message_key: str, **params):
    """发送通知任务（支持用户语言）"""
    from apps.users.auth.models import User

    # 获取用户
    user = User.objects.get(id=user_id)

    # 设置用户语言
    if hasattr(user, 'language_preference') and user.language_preference:
        set_user_language(SupportedLanguage(user.language_preference))

    # 获取翻译后的消息
    message = get_text(message_key, **params)

    # 发送通知
    send_email(user.email, "通知", message)


# ============================================================================
# 示例 6: 迁移策略（向后兼容）
# ============================================================================

from apps.i18n.migration_helper import migrate_error_response

# 第一阶段：使用迁移助手（保持向后兼容）
def get_table_migration_phase1(request, table_id: str):
    table = Table.objects.filter(id=table_id).first()
    if not table:
        return migrate_error_response(
            "TABLE_NOT_FOUND",
            message_key="resource.table_not_found",
            legacy_message="表格不存在"  # 如果翻译不存在，使用这个
        )
    return success_response(data=serialize_table(table))


# 第二阶段：完全迁移到i18n
def get_table_migration_phase2(request, table_id: str):
    table = Table.objects.filter(id=table_id).first()
    if not table:
        return error_response(
            code="TABLE_NOT_FOUND",
            message_key="resource.table_not_found"  # 只使用翻译键
        )
    return success_response(data=serialize_table(table))


# ============================================================================
# 示例 7: 在Django Admin中使用
# ============================================================================

from django.contrib import admin
from apps.i18n import get_text

class TableAdmin(admin.ModelAdmin):
    def delete_queryset(self, request, queryset):
        for obj in queryset:
            if obj.is_default:
                self.message_user(
                    request,
                    get_text("business.default_table_delete_denied"),  # ✅ 自动翻译
                    level='ERROR'
                )
                return
        super().delete_queryset(request, queryset)


# ============================================================================
# 示例 8: 测试
# ============================================================================

from django.test import TestCase
from apps.i18n.language import set_user_language, SupportedLanguage
from apps.i18n import get_text

class TableServiceTestCase(TestCase):
    def test_delete_table_error_message(self):
        # 测试中文
        set_user_language(SupportedLanguage.ZH_CN)
        service = TableService()

        with self.assertRaises(ValueError) as cm:
            service.delete_table_new("non-existent-id")

        self.assertEqual(str(cm.exception), "表格不存在")

        # 测试英文
        set_user_language(SupportedLanguage.EN_US)

        with self.assertRaises(ValueError) as cm:
            service.delete_table_new("non-existent-id")

        self.assertEqual(str(cm.exception), "Table not found")
