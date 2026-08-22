"""
应用更新 Admin 管理界面
"""
from django.contrib import admin
from django.utils.html import format_html
from django.utils import timezone
from django.shortcuts import redirect
from django.contrib import messages
from django.urls import reverse, path
from django.http import JsonResponse

from .models import AppRelease, UpdatePushRecord, UpdateLog
from .services.push_service import UpdatePushService


@admin.register(AppRelease)
class AppReleaseAdmin(admin.ModelAdmin):
    list_display = [
        'version',
        'platform',
        'arch',
        'channel',
        'status_badge',
        'rollout_badge',
        'published_at',
        'action_buttons'
    ]
    list_filter = ['platform', 'arch', 'channel', 'is_draft', 'is_mandatory', 'priority']
    search_fields = ['version', 'release_notes']
    readonly_fields = ['created_at', 'updated_at', 'created_by']
    ordering = ['-created_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('version', 'platform', 'arch', 'channel')
        }),
        ('文件信息', {
            'fields': ('file_url', 'website_file_url', 'feed_url', 'file_size', 'checksum_sha256')
        }),
        ('发布控制', {
            'fields': (
                'is_draft',
                'published_at',
                'deprecated_at',
                'is_mandatory',
                'min_compatible_version',
                'priority'
            )
        }),
        ('更新内容', {
            'fields': ('release_notes', 'release_notes_en')
        }),
        ('灰度发布', {
            'fields': ('rollout_percentage', 'rollout_target_users'),
            'description': '灰度发布百分比：0-100，0 表示未推送'
        }),
        ('元数据', {
            'fields': ('created_by', 'created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def status_badge(self, obj):
        """状态徽章"""
        if obj.is_deprecated:
            return format_html(
                '<span style="color: red;">⛔ 已废弃</span>'
            )
        elif obj.is_draft:
            return format_html(
                '<span style="color: gray;">📝 草稿</span>'
            )
        elif obj.published_at:
            return format_html(
                '<span style="color: green;">✅ 已发布</span>'
            )
        else:
            return format_html(
                '<span style="color: orange;">⏳ 待发布</span>'
            )
    status_badge.short_description = '状态'

    def rollout_badge(self, obj):
        """灰度徽章"""
        if obj.rollout_percentage == 0:
            color = 'gray'
            text = f'{obj.rollout_percentage}% (未推送)'
        elif obj.rollout_percentage < 20:
            color = 'orange'
            text = f'{obj.rollout_percentage}% (灰度中)'
        elif obj.rollout_percentage < 100:
            color = 'blue'
            text = f'{obj.rollout_percentage}% (灰度中)'
        else:
            color = 'green'
            text = f'{obj.rollout_percentage}% (全量)'

        return format_html(
            f'<span style="color: {color}; font-weight: bold;">{text}</span>'
        )
    rollout_badge.short_description = '灰度比例'

    def action_buttons(self, obj):
        """操作按钮"""
        buttons = []

        # 发布按钮
        if obj.is_draft:
            buttons.append(
                f'<a class="button" href="{reverse("admin:updater_release_publish", args=[obj.pk])}" '
                f'style="background-color: #417690; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">发布</a>'
            )

        # 推送按钮
        if obj.is_published and not obj.is_deprecated:
            buttons.append(
                f'<a class="button" href="{reverse("admin:updater_release_push", args=[obj.pk])}" '
                f'style="background-color: #28a745; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">🚀 推送更新</a>'
            )

        # 增加灰度按钮
        if obj.is_published and obj.rollout_percentage < 100:
            next_rollout = min(obj.rollout_percentage + 20, 100)
            buttons.append(
                f'<a class="button" href="{reverse("admin:updater_release_increase_rollout", args=[obj.pk])}?percentage={next_rollout}" '
                f'style="background-color: #007bff; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">📈 灰度至 {next_rollout}%</a>'
            )

        # 统计按钮
        if obj.is_published:
            buttons.append(
                f'<a class="button" href="{reverse("admin:updater_release_stats", args=[obj.pk])}" '
                f'target="_blank" style="background-color: #6c757d; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">📊 查看统计</a>'
            )

        # 废弃按钮
        if obj.is_published and not obj.is_deprecated:
            buttons.append(
                f'<a class="button" href="{reverse("admin:updater_release_deprecate", args=[obj.pk])}" '
                f'style="background-color: #dc3545; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">废弃</a>'
            )

        return format_html(' '.join(buttons))
    action_buttons.short_description = '操作'

    def save_model(self, request, obj, form, change):
        """保存时记录创建者"""
        if not change:  # 新创建
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    def get_urls(self):
        """添加自定义 URL"""
        urls = super().get_urls()
        custom_urls = [
            path('<int:pk>/publish/', self.admin_site.admin_view(self.publish_release), name='updater_release_publish'),
            path('<int:pk>/push/', self.admin_site.admin_view(self.push_release), name='updater_release_push'),
            path('<int:pk>/increase-rollout/', self.admin_site.admin_view(self.increase_rollout), name='updater_release_increase_rollout'),
            path('<int:pk>/deprecate/', self.admin_site.admin_view(self.deprecate_release), name='updater_release_deprecate'),
            path('<int:pk>/stats/', self.admin_site.admin_view(self.view_stats), name='updater_release_stats'),
        ]
        return custom_urls + urls

    def publish_release(self, request, pk):
        """发布版本"""
        release = AppRelease.objects.get(pk=pk)

        if not release.is_draft:
            messages.warning(request, f'版本 {release.version} 已经发布过了')
            return redirect('admin:updater_apprelease_changelist')

        release.publish()
        messages.success(request, f'✅ 版本 {release.version} 发布成功！')

        return redirect('admin:updater_apprelease_change', pk)

    def push_release(self, request, pk):
        """推送更新"""
        release = AppRelease.objects.get(pk=pk)

        if release.is_draft:
            messages.error(request, '草稿版本无法推送，请先发布')
            return redirect('admin:updater_apprelease_change', pk)

        try:
            service = UpdatePushService()
            push_record = service.push_update(
                release,
                rollout_percentage=release.rollout_percentage,
                silent=False,
                pushed_by=request.user
            )

            messages.success(
                request,
                f'🚀 更新推送成功！版本 {release.version} 已推送给 '
                f'{release.rollout_percentage}% 的用户'
            )
        except Exception as e:
            messages.error(request, f'推送失败: {str(e)}')

        return redirect('admin:updater_apprelease_change', pk)

    def increase_rollout(self, request, pk):
        """增加灰度比例"""
        release = AppRelease.objects.get(pk=pk)
        new_percentage = int(request.GET.get('percentage', 100))

        try:
            service = UpdatePushService()
            push_record = service.increase_rollout(
                release,
                new_percentage=new_percentage,
                pushed_by=request.user
            )

            messages.success(
                request,
                f'📈 灰度比例已更新至 {new_percentage}% 并推送'
            )
        except Exception as e:
            messages.error(request, f'灰度更新失败: {str(e)}')

        return redirect('admin:updater_apprelease_change', pk)

    def deprecate_release(self, request, pk):
        """废弃版本"""
        release = AppRelease.objects.get(pk=pk)
        release.deprecate()

        messages.success(request, f'版本 {release.version} 已标记为废弃')
        return redirect('admin:updater_apprelease_change', pk)

    def view_stats(self, request, pk):
        """查看统计（返回 JSON）"""
        from django.db.models import Count, Avg

        release = AppRelease.objects.get(pk=pk)

        # 推送统计
        push_records = release.push_records.all()
        total_pushes = push_records.count()
        successful_pushes = push_records.filter(status='sent').count()

        # 更新日志统计
        update_logs = UpdateLog.objects.filter(to_version=release.version, channel=release.channel)
        total_updates = update_logs.count()
        successful_updates = update_logs.filter(success=True).count()
        failed_updates = update_logs.filter(success=False).count()

        # 状态分布
        status_dist = update_logs.values('status').annotate(count=Count('id')).order_by('-count')

        # 平台分布
        platform_dist = update_logs.values('platform').annotate(count=Count('id')).order_by('-count')

        # 平均下载时长
        avg_duration = update_logs.filter(download_duration_ms__isnull=False).aggregate(
            Avg('download_duration_ms')
        )['download_duration_ms__avg']

        return JsonResponse({
            'version': release.version,
            'channel': release.channel,
            'release_info': {
                'published_at': release.published_at.isoformat() if release.published_at else None,
                'is_mandatory': release.is_mandatory,
                'priority': release.priority,
                'rollout_percentage': release.rollout_percentage,
            },
            'push_stats': {
                'total_pushes': total_pushes,
                'successful_pushes': successful_pushes,
            },
            'update_stats': {
                'total_attempts': total_updates,
                'successful': successful_updates,
                'failed': failed_updates,
                'success_rate': round(successful_updates / total_updates * 100, 2) if total_updates > 0 else 0,
            },
            'status_distribution': list(status_dist),
            'platform_distribution': list(platform_dist),
            'performance': {
                'avg_download_duration_ms': int(avg_duration) if avg_duration else None,
                'avg_download_duration_sec': round(avg_duration / 1000, 2) if avg_duration else None,
            }
        })

    # 批量操作
    actions = ['publish_selected', 'push_selected']

    def publish_selected(self, request, queryset):
        """批量发布"""
        count = 0
        for release in queryset.filter(is_draft=True):
            release.publish()
            count += 1
        self.message_user(request, f'已发布 {count} 个版本')
    publish_selected.short_description = '发布选中的版本'

    def push_selected(self, request, queryset):
        """批量推送"""
        service = UpdatePushService()
        count = 0
        for release in queryset.filter(is_draft=False, deprecated_at__isnull=True):
            try:
                service.push_update(release, pushed_by=request.user)
                count += 1
            except Exception as e:
                self.message_user(request, f'推送 {release.version} 失败: {e}', level='error')

        self.message_user(request, f'已推送 {count} 个版本')
    push_selected.short_description = '推送选中的版本'


@admin.register(UpdatePushRecord)
class UpdatePushRecordAdmin(admin.ModelAdmin):
    list_display = ['id', 'release_version', 'target_group', 'rollout_percentage', 'status', 'pushed_at', 'pushed_by']
    list_filter = ['status', 'silent', 'pushed_at']
    search_fields = ['release__version', 'target_group']
    readonly_fields = ['pushed_at']
    ordering = ['-pushed_at']

    def release_version(self, obj):
        return obj.release.version
    release_version.short_description = '版本'


@admin.register(UpdateLog)
class UpdateLogAdmin(admin.ModelAdmin):
    list_display = [
        'id',
        'device_id',
        'from_version',
        'to_version',
        'platform',
        'status',
        'trigger_source',
        'success',
        'started_at'
    ]
    list_filter = ['status', 'trigger_source', 'success', 'platform', 'arch', 'channel']
    search_fields = ['device_id', 'user_id', 'to_version']
    readonly_fields = ['started_at', 'completed_at']
    ordering = ['-started_at']

    def has_add_permission(self, request):
        """禁止手动添加日志"""
        return False
