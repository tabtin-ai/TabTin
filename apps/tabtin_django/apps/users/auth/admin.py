"""
Django管理后台配置
"""

from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth import get_user_model
from django.utils.html import format_html
from django.urls import reverse
from django.utils.safestring import mark_safe

from .models import UserProfile, UserGroup, UserSession, UserActionLog

User = get_user_model()


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """用户管理（集成TabData数据一致性检查）"""

    list_display = [
        'get_display_name', 'email', 'phone', 'username',
        'is_active', 'is_verified_email', 'is_verified_phone',
        'login_count', 'has_tabdata_data', 'date_joined'
    ]
    actions = ['safe_delete_users_with_tabdata']
    list_filter = [
        'is_active', 'is_staff', 'is_superuser',
        'is_verified_email', 'is_verified_phone',
        'date_joined', 'last_login'
    ]
    search_fields = ['email', 'phone', 'username', 'nickname']
    ordering = ['-date_joined']

    fieldsets = (
        ('基本信息', {
            'fields': ('email', 'phone', 'username', 'password')
        }),
        ('个人信息', {
            'fields': ('nickname', 'avatar', 'bio')
        }),
        ('权限', {
            'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')
        }),
        ('验证状态', {
            'fields': ('is_verified_email', 'is_verified_phone')
        }),
        ('统计信息', {
            'fields': ('login_count', 'failed_login_attempts', 'last_login', 'date_joined'),
            'classes': ('collapse',)
        })
    )

    add_fieldsets = (
        ('创建用户', {
            'classes': ('wide',),
            'fields': ('email', 'phone', 'password1', 'password2')
        }),
    )

    readonly_fields = ['date_joined', 'last_login', 'login_count', 'failed_login_attempts']

    def save_model(self, request, obj, form, change):
        """保存用户时检测 is_active 变更，禁用时立即清除全部会话（SDI-014 兜底）。"""
        if change and 'is_active' in form.changed_data and not obj.is_active:
            super().save_model(request, obj, form, change)
            from .session_manager import SessionManager
            count = SessionManager.invalidate_all_user_sessions(str(obj.id))
            import logging
            logging.getLogger(__name__).info(
                "[AdminSaveModel] 管理员 %s 禁用用户 %s，已清除 %d 个活跃会话",
                request.user, obj.id, count,
            )
            self.message_user(
                request,
                f"用户 {obj.get_display_name()} 已禁用，{count} 个活跃会话已清除。",
                messages.WARNING,
            )
        else:
            super().save_model(request, obj, form, change)

    def get_display_name(self, obj):
        """显示名称"""
        return obj.get_display_name()
    get_display_name.short_description = '显示名称'

    def has_tabdata_data(self, obj):
        """检查是否有TabData数据"""
        try:
            from apps.tabtinspace.models import Organization
            from apps.tabdata.models import Table, TableRecord

            organization_count = Organization.objects.filter(owner_id=obj.id).count()
            table_count = Table.objects.filter(owner_id=obj.id).count()
            record_count = TableRecord.objects.filter(created_by_id=obj.id)[:1].count()

            total = organization_count + table_count + record_count

            if total > 0:
                return format_html(
                    '<span style="color: orange; font-weight: bold;" title="组织:{}, 表格:{}, 记录:{}+">⚠️ {}</span>',
                    organization_count, table_count, record_count, total
                )
            return format_html('<span style="color: green;">-</span>')
        except ImportError:
            return '-'
        except Exception as e:
            return format_html('<span style="color: gray;">?</span>')
    has_tabdata_data.short_description = 'TabData数据'

    def delete_model(self, request, obj):
        """删除单个用户（跨库清理失败时显示友好提示而非 500 页面）"""
        try:
            super().delete_model(request, obj)
        except Exception as exc:
            from apps.tabtinspace.exceptions import CrossDatabaseCleanupError
            if isinstance(exc, CrossDatabaseCleanupError) or isinstance(exc.__cause__, CrossDatabaseCleanupError):
                self.message_user(
                    request,
                    f"⚠️ 用户 {obj.get_display_name()} 删除失败：PostgreSQL 关联数据清理异常，请检查数据库连接后重试。",
                    messages.ERROR,
                )
            else:
                raise

    def delete_queryset(self, request, queryset):
        """批量删除用户（逐条执行，保证跨库清理的友好错误提示）"""
        from apps.tabtinspace.exceptions import CrossDatabaseCleanupError

        deleted = 0
        failed_users = []
        for user in queryset:
            try:
                user.delete()
                deleted += 1
            except (CrossDatabaseCleanupError, Exception) as exc:
                failed_users.append(f"{user.get_display_name()}: {exc}")

        parts = []
        if deleted:
            parts.append(f"✅ 已删除 {deleted} 个用户及其关联数据")
        if failed_users:
            parts.append(f"<br><br>⚠️ {len(failed_users)} 个用户删除失败：")
            for msg in failed_users[:5]:
                parts.append(f"<br>• {msg}")
            if len(failed_users) > 5:
                parts.append(f"<br>... 还有 {len(failed_users) - 5} 个")
            parts.append("<br><br>请检查 PostgreSQL 连接后重试。")

        level = messages.SUCCESS if not failed_users else messages.WARNING
        if parts:
            self.message_user(request, format_html(''.join(parts)), level)

    def safe_delete_users_with_tabdata(self, request, queryset):
        """安全删除用户（含 TabData / TabtinSpace 全部关联数据）。

        实际清理由 pre_delete signal (cleanup_user_data) 统一负责，
        此 action 仅做删除前统计、执行 user.delete() 并汇报结果。
        """
        try:
            from apps.tabtinspace.models import Organization, OrganizationMember
            from apps.tabdata.models import Table, TableRecord
        except ImportError:
            self.message_user(request, "TabData模块未安装，使用普通删除即可", messages.INFO)
            return

        deleted_stats = {'users': 0, 'failed': 0}
        failed_users = []

        for user in queryset:
            try:
                user.delete()
                deleted_stats['users'] += 1
            except Exception as exc:
                deleted_stats['failed'] += 1
                failed_users.append(f"{user.get_display_name()}: {exc}")

        parts = [f"✅ 已安全删除 {deleted_stats['users']} 个用户及其全部关联数据"]
        if failed_users:
            parts.append(f"<br><br>⚠️ {deleted_stats['failed']} 个用户删除失败：")
            for msg in failed_users[:5]:
                parts.append(f"<br>• {msg}")
            if len(failed_users) > 5:
                parts.append(f"<br>... 还有 {len(failed_users) - 5} 个")
            parts.append("<br><br>请检查 PostgreSQL 连接后重试。")

        level = messages.SUCCESS if not failed_users else messages.WARNING
        self.message_user(request, format_html(''.join(parts)), level)

    safe_delete_users_with_tabdata.short_description = "🗑️ 安全删除用户（含TabData数据）"

    def _check_tabdata_relations(self, user_id):
        """检查TabData关联数据"""
        try:
            from apps.tabtinspace.models import Organization, OrganizationMember
            from apps.tabdata.models import Table, TableRecord
        except ImportError:
            return True, None

        relations = {
            'owned_organizations': Organization.objects.filter(owner_id=user_id).count(),
            'owned_tables': Table.objects.filter(owner_id=user_id).count(),
            'created_records': TableRecord.objects.filter(created_by_id=user_id)[:100].count(),
            'organization_memberships': OrganizationMember.objects.filter(user_id=user_id).count(),
        }

        total_relations = sum(relations.values())

        if total_relations == 0:
            return True, None

        details = []
        if relations['owned_organizations'] > 0:
            details.append(f"• {relations['owned_organizations']} 个组织")
        if relations['owned_tables'] > 0:
            details.append(f"• {relations['owned_tables']} 个表格")
        if relations['created_records'] > 0:
            details.append(f"• {relations['created_records']}+ 条记录")
        if relations['organization_memberships'] > 0:
            details.append(f"• {relations['organization_memberships']} 个组织成员关系")

        message = format_html(
            """
            <strong>⚠️ 警告：该用户在TabData模块中有关联数据！</strong><br><br>
            如果删除该用户，以下数据将会受到影响：<br>
            {}<br><br>
            <strong>建议操作：</strong><br>
            1. 先在TabData管理界面转移或删除这些数据<br>
            2. 或使用"安全删除用户（含TabData数据）"操作<br><br>
            <strong>继续删除将导致这些数据变为孤儿记录！</strong>
            """,
            '<br>'.join(details)
        )

        return False, message

    def get_queryset(self, request):
        """优化查询"""
        return super().get_queryset(request).select_related('profile')


class UserProfileInline(admin.StackedInline):
    """用户配置内联编辑"""
    model = UserProfile
    can_delete = False
    verbose_name_plural = '用户配置'

    fieldsets = (
        ('隐私设置', {
            'fields': ('is_public_profile', 'allow_email_notifications', 'allow_sms_notifications')
        }),
        ('个性化设置', {
            'fields': ('timezone', 'language', 'theme')
        }),
        ('业务设置', {
            'fields': ('homepage_template', 'max_collections')
        })
    )


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    """用户配置管理"""

    list_display = [
        'user', 'is_public_profile', 'language', 'theme',
        'allow_email_notifications', 'allow_sms_notifications'
    ]
    list_filter = [
        'is_public_profile', 'language', 'theme',
        'allow_email_notifications', 'allow_sms_notifications'
    ]
    search_fields = ['user__email', 'user__phone', 'user__nickname']

    fieldsets = (
        ('用户', {
            'fields': ('user',)
        }),
        ('隐私设置', {
            'fields': ('is_public_profile', 'allow_email_notifications', 'allow_sms_notifications')
        }),
        ('个性化设置', {
            'fields': ('timezone', 'language', 'theme')
        }),
        ('业务设置', {
            'fields': ('homepage_template', 'max_collections')
        })
    )


@admin.register(UserGroup)
class UserGroupAdmin(admin.ModelAdmin):
    """用户组管理"""

    list_display = [
        'name', 'group_type', 'get_member_count', 'max_members',
        'is_active', 'created_at'
    ]
    list_filter = ['group_type', 'is_active', 'created_at']
    search_fields = ['name', 'description']
    filter_horizontal = ['permissions', 'users']

    fieldsets = (
        ('基本信息', {
            'fields': ('name', 'description', 'group_type')
        }),
        ('设置', {
            'fields': ('max_members', 'is_active')
        }),
        ('权限', {
            'fields': ('permissions',)
        }),
        ('成员', {
            'fields': ('users',)
        })
    )

    def get_member_count(self, obj):
        """获取成员数量"""
        return obj.users.count()
    get_member_count.short_description = '成员数量'


@admin.register(UserSession)
class UserSessionAdmin(admin.ModelAdmin):
    """用户会话管理"""

    list_display = [
        'user', 'session_type', 'ip_address', 'get_device_info',
        'is_active', 'created_at', 'expires_at'
    ]
    list_filter = [
        'session_type', 'is_active', 'created_at', 'expires_at'
    ]
    search_fields = ['user__email', 'user__phone', 'ip_address']
    readonly_fields = ['session_key', 'created_at', 'last_activity']

    fieldsets = (
        ('会话信息', {
            'fields': ('user', 'session_key', 'session_type', 'is_active')
        }),
        ('设备信息', {
            'fields': ('ip_address', 'user_agent', 'device_info')
        }),
        ('时间信息', {
            'fields': ('created_at', 'last_activity', 'expires_at')
        })
    )

    def get_device_info(self, obj):
        """获取设备信息"""
        if obj.device_info:
            return f"{obj.device_info.get('os', 'Unknown')} - {obj.device_info.get('browser', 'Unknown')}"
        return "Unknown"
    get_device_info.short_description = '设备信息'

    def get_queryset(self, request):
        """优化查询"""
        return super().get_queryset(request).select_related('user')


@admin.register(UserActionLog)
class UserActionLogAdmin(admin.ModelAdmin):
    """用户操作日志管理"""

    list_display = [
        'user', 'action_type', 'get_success_icon', 'ip_address',
        'created_at'
    ]
    list_filter = [
        'action_type', 'success', 'created_at'
    ]
    search_fields = ['user__email', 'user__phone', 'description', 'ip_address']
    readonly_fields = ['created_at']
    date_hierarchy = 'created_at'

    fieldsets = (
        ('操作信息', {
            'fields': ('user', 'action_type', 'description', 'success')
        }),
        ('请求信息', {
            'fields': ('ip_address', 'user_agent', 'request_data')
        }),
        ('结果信息', {
            'fields': ('error_message', 'created_at')
        })
    )

    def get_success_icon(self, obj):
        """成功状态图标"""
        if obj.success:
            return format_html(
                '<img src="/static/admin/img/icon-yes.svg" alt="成功">'
            )
        else:
            return format_html(
                '<img src="/static/admin/img/icon-no.svg" alt="失败">'
            )
    get_success_icon.short_description = '状态'

    def get_queryset(self, request):
        """优化查询"""
        return super().get_queryset(request).select_related('user')

    def has_add_permission(self, request):
        """禁止添加日志"""
        return False

    def has_change_permission(self, request, obj=None):
        """禁止修改日志"""
        return False


# 自定义管理后台标题
admin.site.site_header = 'Tabtin 用户管理'
admin.site.site_title = 'Tabtin 用户管理'
admin.site.index_title = '用户认证模块管理'
