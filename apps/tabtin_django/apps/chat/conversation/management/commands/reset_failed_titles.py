"""把所有 ``title_generation_status='failed'`` 的 session 重置为 ``pending``。

典型使用场景：

1. dogfood 配 LLMSceneBinding(scene_key='title_generation') 之前，
   ``generate_session_title_task`` 都因为永久错 mark failed → 4 小时退避
2. 现在配好了——不想等 1 小时退避窗口（``_TITLE_BACKFILL_FAIL_COOLDOWN_HOURS``），
   想立即让 backfill 把它们全部重新入队

用法::

    python manage.py reset_failed_titles                # reset 所有 failed
    python manage.py reset_failed_titles --enqueue      # reset + 立即跑一次 backfill

reset 只改字段，不直接入队——下一次 backfill 周期任务（cron `*/15`）会拿到它们。
``--enqueue`` 立即 dispatch 一次 `backfill_session_titles.delay()`。
"""

from django.core.management.base import BaseCommand
from apps.chat.conversation.models import ChatSession


class Command(BaseCommand):
    help = '把 title_generation_status=failed 的 session 重置为 pending,可选立即触发 backfill'

    def add_arguments(self, parser):
        parser.add_argument(
            '--enqueue',
            action='store_true',
            help='reset 后立即 dispatch backfill_session_titles 一次,不等 cron',
        )

    def handle(self, *args, **opts):
        affected = ChatSession.objects.filter(
            title_generation_status='failed',
        ).update(
            title_generation_status='pending',
            title_generation_failed_at=None,
        )
        self.stdout.write(self.style.SUCCESS(
            f'[reset_failed_titles] reset {affected} session(s) to pending'
        ))

        if opts.get('enqueue') and affected:
            from apps.chat.conversation.tasks import backfill_session_titles
            result = backfill_session_titles.delay()
            self.stdout.write(self.style.SUCCESS(
                f'[reset_failed_titles] dispatched backfill_session_titles task={result.id}'
            ))
