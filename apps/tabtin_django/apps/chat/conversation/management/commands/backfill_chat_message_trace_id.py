"""
Backfill ChatMessage.trace_id from ExecutionTrace by time window.

规则：
- 一个 user 消息对应一个“对话轮次”，轮次范围为该 user 消息到下一条 user 消息之间的消息。
- 轮次对应的 trace 选择：优先选 started_at >= user.created_at（允许少量前置缓冲），
  且 started_at < 下一条 user.created_at（如果存在）。
- 找不到则在给定窗口内找最近 trace。
"""

from datetime import timedelta
from typing import Optional

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.services.agent_engine.models import ExecutionTrace


class Command(BaseCommand):
    help = "Backfill chat_message.trace_id by matching ExecutionTrace."

    def add_arguments(self, parser):
        parser.add_argument("--session-id", type=str, default=None, help="仅处理指定的 session_id")
        parser.add_argument("--limit", type=int, default=None, help="最多处理多少个会话")
        parser.add_argument("--dry-run", action="store_true", help="仅打印，不写入")
        parser.add_argument("--window-seconds", type=int, default=3600, help="允许匹配的最大时间差（秒）")
        parser.add_argument("--pre-slack-seconds", type=int, default=5, help="允许 trace 提前开始的秒数")

    def handle(self, *args, **options):
        session_id = options.get("session_id")
        limit = options.get("limit")
        dry_run = options.get("dry_run")
        window_seconds = options.get("window_seconds") or 3600
        pre_slack_seconds = options.get("pre_slack_seconds") or 5

        sessions = ChatSession.objects.all().order_by("-updated_at")
        if session_id:
            sessions = sessions.filter(id=session_id)
        if limit:
            sessions = sessions[:limit]

        total_sessions = 0
        total_messages = 0
        total_bound = 0
        total_missing = 0

        for session in sessions:
            total_sessions += 1
            thread_id = session.thread_id or f"chat-session-{session.id}"

            if not session.thread_id and not dry_run:
                session.thread_id = thread_id
                session.save(update_fields=["thread_id"])

            traces = list(
                ExecutionTrace.objects.filter(thread_id=thread_id)
                .order_by("started_at")
                .only("trace_id", "started_at", "ended_at")
            )

            if not traces:
                self.stdout.write(f"[跳过] session={session.id} thread_id={thread_id} 无 trace")
                continue

            messages = list(
                ChatMessage.objects.filter(session=session).order_by("created_at", "id")
            )
            if not messages:
                self.stdout.write(f"[跳过] session={session.id} 无消息")
                continue

            user_indices = [i for i, m in enumerate(messages) if m.role == "user"]
            if not user_indices:
                self.stdout.write(f"[跳过] session={session.id} 无 user 消息")
                continue

            for idx, user_index in enumerate(user_indices):
                turn_start = messages[user_index].created_at
                turn_end = (
                    messages[user_indices[idx + 1]].created_at if idx + 1 < len(user_indices) else None
                )

                trace = self._select_trace(
                    traces,
                    turn_start,
                    turn_end,
                    pre_slack_seconds,
                    window_seconds,
                )

                turn_messages = messages[user_index : (user_indices[idx + 1] if idx + 1 < len(user_indices) else None)]
                total_messages += len(turn_messages)

                if not trace:
                    total_missing += len(turn_messages)
                    continue

                message_ids = [m.id for m in turn_messages if m.trace_id is None]
                if not message_ids:
                    continue

                if dry_run:
                    total_bound += len(message_ids)
                else:
                    with transaction.atomic():
                        ChatMessage.objects.filter(id__in=message_ids).update(trace_id=trace.trace_id)
                        total_bound += len(message_ids)

        self.stdout.write(
            f"完成: sessions={total_sessions}, messages={total_messages}, bound={total_bound}, missing={total_missing}"
        )

    @staticmethod
    def _select_trace(
        traces,
        turn_start,
        turn_end: Optional[timezone.datetime],
        pre_slack_seconds: int,
        window_seconds: int,
    ):
        if not traces:
            return None

        start_with_slack = turn_start - timedelta(seconds=pre_slack_seconds)
        candidates = [
            t
            for t in traces
            if t.started_at >= start_with_slack and (turn_end is None or t.started_at < turn_end)
        ]
        if candidates:
            return candidates[0]

        # fallback: 最近的 trace（在窗口内）
        nearest = None
        nearest_delta = None
        for trace in traces:
            delta = abs((trace.started_at - turn_start).total_seconds())
            if delta <= window_seconds and (nearest_delta is None or delta < nearest_delta):
                nearest = trace
                nearest_delta = delta
        return nearest
