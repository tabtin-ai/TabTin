"""
为现有用户创建默认组织的Django管理命令

使用方法:
    python manage.py create_default_organizations
    python manage.py create_default_organizations --dry-run  # 预览模式
    python manage.py create_default_organizations --user-id <user_id>  # 为特定用户创建
"""

import os
import sys
import django
from django.core.management.base import BaseCommand, CommandError
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
import logging

# 设置Django环境
sys.path.append('/www/wwwroot/tabtin')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
django.setup()

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabtinspace.models import Organization, OrganizationMember, Space

User = get_user_model()
logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = '为现有用户创建默认组织'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='预览模式，不实际创建组织',
        )
        parser.add_argument(
            '--user-id',
            type=str,
            help='为特定用户ID创建默认组织',
        )
        parser.add_argument(
            '--force',
            action='store_true',
            help='强制为已有组织的用户也创建默认组织',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        user_id = options['user_id']
        force = options['force']

        self.stdout.write(
            self.style.SUCCESS('🚀 开始为现有用户创建默认组织...')
        )

        if dry_run:
            self.stdout.write(
                self.style.WARNING('⚠️  预览模式：不会实际创建组织')
            )

        try:
            # 获取需要处理的用户
            if user_id:
                users = User.objects.using('default').filter(id=user_id)
                if not users.exists():
                    raise CommandError(f'用户ID {user_id} 不存在')
            else:
                users = User.objects.using('default').all()

            # 统计信息
            total_users = users.count()
            processed_users = 0
            created_organizations = 0
            skipped_users = 0

            self.stdout.write(f'📊 总用户数: {total_users}')

            for user in users:
                try:
                    # 检查用户是否已有默认组织
                    has_default_organization = Organization.objects.using(TABDATA_DB_ALIAS).filter(
                        owner=user,
                        is_default=True
                    ).exists()

                    if has_default_organization and not force:
                        self.stdout.write(
                            f'⏭️  跳过用户 {user.username} (ID: {user.id}) - 已有默认组织'
                        )
                        skipped_users += 1
                        continue

                    # 检查用户是否有任何组织
                    has_any_organization = Organization.objects.using(TABDATA_DB_ALIAS).filter(
                        owner=user
                    ).exists()

                    if has_any_organization and not force:
                        self.stdout.write(
                            f'⏭️  跳过用户 {user.username} (ID: {user.id}) - 已有组织但非默认'
                        )
                        skipped_users += 1
                        continue

                    if not dry_run:
                        # 创建默认组织
                        with transaction.atomic(using=TABDATA_DB_ALIAS):
                            organization = self._create_default_organization(user)
                            created_organizations += 1

                        self.stdout.write(
                            self.style.SUCCESS(
                                f'✅ 为用户 {user.username} (ID: {user.id}) 创建了默认组织 (ID: {organization.id})'
                            )
                        )
                    else:
                        self.stdout.write(
                            f'🔍 [预览] 将为用户 {user.username} (ID: {user.id}) 创建默认组织'
                        )
                        created_organizations += 1

                    processed_users += 1

                except Exception as e:
                    self.stdout.write(
                        self.style.ERROR(
                            f'❌ 为用户 {user.username} (ID: {user.id}) 创建组织失败: {str(e)}'
                        )
                    )
                    logger.error("创建默认组织失败: %s", e, exc_info=True)

            # 输出统计结果
            self.stdout.write('\n' + '='*50)
            self.stdout.write(self.style.SUCCESS('📈 执行结果统计:'))
            self.stdout.write(f'  总用户数: {total_users}')
            self.stdout.write(f'  处理用户数: {processed_users}')
            self.stdout.write(f'  跳过用户数: {skipped_users}')
            if dry_run:
                self.stdout.write(f'  预计创建组织数: {created_organizations}')
            else:
                self.stdout.write(f'  实际创建组织数: {created_organizations}')

            if not dry_run and created_organizations > 0:
                self.stdout.write(
                    self.style.SUCCESS(f'🎉 成功为 {created_organizations} 个用户创建了默认组织!')
                )

        except Exception as e:
            raise CommandError(f'执行失败: {str(e)}')

    def _create_default_organization(self, user):
        """为用户创建默认组织和默认 Space"""
        from apps.tabtinspace.services.organization_service import OrganizationService

        try:
            display_name = getattr(user, 'username', str(user.id))
            if hasattr(user, 'get_display_name'):
                display_name = user.get_display_name()

            organization = Organization.objects.using(TABDATA_DB_ALIAS).create(
                name=f"{display_name}的组织",
                description="个人默认组织",
                icon="🏠",
                owner=user,
                type=Organization.OrganizationType.PERSONAL,
                is_default=True,
                settings={
                    'is_default': True,
                    'auto_created': True,
                    'created_by_command': True,
                    'created_at': timezone.now().isoformat()
                }
            )

            space = OrganizationService.provision_organization_defaults(organization, user)

            logger.info(
                "为用户 %s 创建默认组织(%s)，绑定 Space=%s",
                display_name,
                organization.id,
                space.id if space else None,
            )

            return organization

        except Exception as e:
            logger.error("创建默认组织和 Space 失败: %s", e, exc_info=True)
            raise
