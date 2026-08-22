"""一次性给所有现存 TEAM organization 加进宝（幂等）。"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.services.jinbao.provisioner import ensure_jinbao_in_all_organizations


class Command(BaseCommand):
    help = '给所有现存 TEAM organization 批量添加进宝成员（幂等，跳过 personal）'

    def handle(self, *args, **opts):
        count = ensure_jinbao_in_all_organizations()
        self.stdout.write(self.style.SUCCESS(
            f'[jinbao] backfill done: {count} new memberships'
        ))
