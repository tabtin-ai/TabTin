"""
批量生成历史会话标题的 Django 管理命令
"""

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q, Count
from apps.chat.conversation.models import ChatSession
from apps.chat.conversation.services.title_generator import generate_session_title
import time
from datetime import datetime


class Command(BaseCommand):
    help = '为历史会话批量生成标题'

    def add_arguments(self, parser):
        parser.add_argument(
            '--organization',
            type=str,
            help='仅处理指定工作空间的会话',
        )
        parser.add_argument(
            '--user',
            type=str,
            help='仅处理指定用户ID的会话',
        )
        parser.add_argument(
            '--limit',
            type=int,
            default=None,
            help='限制处理的会话数量',
        )
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='预览模式，不实际生成标题',
        )
        parser.add_argument(
            '--force',
            action='store_true',
            help='强制重新生成所有标题（包括已有标题的会话）',
        )
        parser.add_argument(
            '--model-id',
            type=str,
            default=None,
            help='指定使用的模型ID（默认使用系统配置）',
        )
        parser.add_argument(
            '--batch-size',
            type=int,
            default=10,
            help='批次大小，每批处理多少会话（默认10）',
        )
        parser.add_argument(
            '--delay',
            type=float,
            default=0.5,
            help='每次调用之间的延迟（秒），避免频繁调用LLM（默认0.5秒）',
        )

    def handle(self, *args, **options):
        organization_id = options.get('organization')
        user_id = options.get('user')
        limit = options.get('limit')
        dry_run = options.get('dry_run')
        force = options.get('force')
        model_id = options.get('model_id')
        batch_size = options.get('batch_size')
        delay = options.get('delay')

        self.stdout.write(self.style.SUCCESS('=' * 70))
        self.stdout.write(self.style.SUCCESS('批量生成会话标题'))
        self.stdout.write(self.style.SUCCESS('=' * 70))
        self.stdout.write('')

        # 构建查询条件
        query = ChatSession.objects.all()

        if organization_id:
            query = query.filter(organization_id=organization_id)
            self.stdout.write(f'🔍 过滤组织: {organization_id}')

        if user_id:
            query = query.filter(user_id=user_id)
            self.stdout.write(f'🔍 过滤用户ID: {user_id}')

        # 根据force参数决定是否只处理默认标题的会话
        if not force:
            from apps.chat.conversation.services.title_generator import _get_default_titles
            default_titles = list(_get_default_titles())
            query = query.filter(
                Q(title__in=default_titles) | Q(title__isnull=True)
            )
            self.stdout.write('🔍 仅处理标题为空或默认值的会话')
        else:
            self.stdout.write('⚠️  强制模式：将重新生成所有会话标题')

        # 只处理有消息的会话
        query = query.annotate(message_count=Count('messages')).filter(message_count__gte=1)

        # 排序：最近更新的优先
        query = query.order_by('-updated_at')

        # 应用限制
        if limit:
            query = query[:limit]

        total_sessions = query.count()

        if total_sessions == 0:
            self.stdout.write(self.style.WARNING('✅ 没有需要生成标题的会话'))
            return

        self.stdout.write(f'📊 找到 {total_sessions} 个需要处理的会话')
        self.stdout.write('')

        if dry_run:
            self.stdout.write(self.style.WARNING('⚠️  预览模式（--dry-run）：不会实际生成标题'))
            self.stdout.write('')
            self._preview_sessions(query, limit=20)
            return

        # 确认继续
        if not options.get('no_input', False):
            confirm = input(f'\n是否继续处理这 {total_sessions} 个会话？[y/N]: ')
            if confirm.lower() != 'y':
                self.stdout.write(self.style.WARNING('❌ 已取消操作'))
                return

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('🚀 开始批量生成标题...'))
        self.stdout.write(f'⚙️  批次大小: {batch_size}')
        self.stdout.write(f'⏱️  延迟: {delay} 秒')
        if model_id:
            self.stdout.write(f'🤖 使用模型: {model_id}')
        self.stdout.write('')

        # 开始处理
        start_time = time.time()
        success_count = 0
        fail_count = 0
        skip_count = 0

        for index, session in enumerate(query, 1):
            try:
                # 显示进度
                progress = f'[{index}/{total_sessions}]'
                self.stdout.write(
                    f'{progress} 处理会话 {session.id} (用户: {session.user.username})...',
                    ending=' '
                )

                # 获取消息数量
                message_count = session.messages.count()
                if message_count == 0:
                    self.stdout.write(self.style.WARNING('⏭️  跳过（无消息）'))
                    skip_count += 1
                    continue

                # 保存原标题
                old_title = session.title

                # 生成标题
                result = generate_session_title(session, model_id=model_id)

                if result:
                    # 重新加载以获取最新标题
                    session.refresh_from_db()
                    new_title = session.title

                    self.stdout.write(
                        self.style.SUCCESS(f'✅ 成功')
                    )
                    self.stdout.write(
                        f'    旧标题: "{old_title}"'
                    )
                    self.stdout.write(
                        self.style.SUCCESS(f'    新标题: "{new_title}"')
                    )
                    self.stdout.write(
                        f'    消息数: {message_count}'
                    )
                    success_count += 1
                else:
                    self.stdout.write(
                        self.style.ERROR('❌ 失败')
                    )
                    fail_count += 1

                # 延迟，避免频繁调用
                if index < total_sessions and delay > 0:
                    time.sleep(delay)

                # 批次间暂停（可选）
                if index % batch_size == 0:
                    elapsed = time.time() - start_time
                    avg_time = elapsed / index
                    remaining = (total_sessions - index) * avg_time
                    self.stdout.write('')
                    self.stdout.write(
                        f'📊 进度: {index}/{total_sessions} '
                        f'({success_count} 成功, {fail_count} 失败, {skip_count} 跳过)'
                    )
                    self.stdout.write(
                        f'⏱️  已用时: {self._format_time(elapsed)}, '
                        f'预计剩余: {self._format_time(remaining)}'
                    )
                    self.stdout.write('')

            except Exception as e:
                self.stdout.write(
                    self.style.ERROR(f'❌ 错误: {str(e)}')
                )
                fail_count += 1

        # 总结
        elapsed_time = time.time() - start_time
        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('=' * 70))
        self.stdout.write(self.style.SUCCESS('✅ 批量处理完成'))
        self.stdout.write(self.style.SUCCESS('=' * 70))
        self.stdout.write(f'📊 总计处理: {total_sessions} 个会话')
        self.stdout.write(self.style.SUCCESS(f'✅ 成功: {success_count}'))
        if fail_count > 0:
            self.stdout.write(self.style.ERROR(f'❌ 失败: {fail_count}'))
        if skip_count > 0:
            self.stdout.write(self.style.WARNING(f'⏭️  跳过: {skip_count}'))
        self.stdout.write(f'⏱️  总用时: {self._format_time(elapsed_time)}')
        self.stdout.write(f'⚡ 平均速度: {elapsed_time/max(success_count, 1):.2f} 秒/会话')
        self.stdout.write('')

    def _preview_sessions(self, queryset, limit=20):
        """预览会话列表"""
        self.stdout.write(self.style.SUCCESS('📋 预览会话列表（前20个）：'))
        self.stdout.write('')

        sessions = list(queryset[:limit])

        for index, session in enumerate(sessions, 1):
            message_count = session.messages.count()
            self.stdout.write(
                f'{index}. 会话 {session.id}'
            )
            self.stdout.write(
                f'   用户: {session.user.username} | '
                f'标题: "{session.title}" | '
                f'消息数: {message_count} | '
                f'更新: {session.updated_at.strftime("%Y-%m-%d %H:%M")}'
            )
            self.stdout.write('')

        if queryset.count() > limit:
            self.stdout.write(f'... 还有 {queryset.count() - limit} 个会话未显示')
            self.stdout.write('')

    def _format_time(self, seconds):
        """格式化时间显示"""
        if seconds < 60:
            return f'{seconds:.1f} 秒'
        elif seconds < 3600:
            minutes = seconds / 60
            return f'{minutes:.1f} 分钟'
        else:
            hours = seconds / 3600
            return f'{hours:.1f} 小时'
