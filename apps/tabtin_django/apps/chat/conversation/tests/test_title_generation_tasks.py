"""
Celery 标题生成 task 的回归测试。

这些测试针对 review 中找出的几个根因级 bug 写的 smoke / 行为锚点：

- ``test_backfill_does_not_raise_fielderror``：
  最早一版 backfill 直接 ``filter(message_count__gt=0)`` 抛 FieldError——
  因为 ChatSession 模型里没这个字段（``message_count`` 是 list_sessions API 的
  annotate 别名）。这条 task 是 daemon thread 失败的兜底自愈机制，一旦抛错
  整个安全网就废了。此 test 一行就能拦住复发。

- ``test_backfill_excludes_done``：
  避免下次有人改 backfill 时把"已完成"也重复入队（浪费 LLM 配额）。

- ``test_backfill_failed_within_cooldown_skipped``：
  failed 状态 4 小时内不重试——防止永久错（譬如 SceneBinding 未配）每 30
  分钟重新入队、把 LLM 调用打成死循环。

- ``test_backfill_stale_in_progress_picked_up``：
  spawn_title_thread mark 了 in_progress 后 broker 失败/worker 崩溃的兜底——
  超过 15 分钟没完成视为僵死、backfill 重新捞起来。

- ``test_mark_failed_does_not_bump_updated_at``：
  ``_mark_title_generation_failed`` 不能 bump updated_at——否则一个一周前
  会话每次失败都跳到"今天"分组（跟前端 getSessionActivityTs 排序冲突）。
"""

from datetime import timedelta
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.chat.conversation.tasks import (
    backfill_session_titles,
    generate_session_title_task,
    archive_empty_sessions,
    _mark_title_generation_failed,
    _is_transient_exc,
)
from apps.chat.conversation.services.title_generator import (
    TitleGeneratorService,
    generate_session_title,
)
from apps.services.llm.scenes.exceptions import SceneCallError
from apps.services.agent_engine.services.persistence_pipeline import (
    spawn_title_thread,
    _enqueue_atomically,
    _AlreadyInProgress,
)


User = get_user_model()


def _make_session(*, user, title='新对话', status='pending', failed_at=None,
                  last_message_at=None, with_message=True):
    sess = ChatSession.objects.create(
        user=user,
        organization_id='wt-test',
        title=title,
        title_generation_status=status,
        title_generation_failed_at=failed_at,
        last_message_at=last_message_at or timezone.now(),
    )
    if with_message:
        ChatMessage.objects.create(
            session=sess,
            role='user',
            text_summary='帮我画一个流浪猫救助海报',
        )
    return sess


class TestGenerateSessionTitleTaskManualRename(SimpleTestCase):
    """不建测试库，直接守住 task 的手动重命名优先级。"""

    def test_title_task_does_not_overwrite_manual_rename(self):
        initial_session = MagicMock()
        initial_session.title = '新对话'
        initial_session.title_generation_status = 'in_progress'
        initial_session.user_id = 'u-1'

        current_session = MagicMock()
        current_session.title = '用户手动命名'
        current_session.title_generation_status = 'done'
        current_session.user_id = 'u-1'

        mock_manager = MagicMock()
        mock_manager.get.return_value = initial_session
        mock_manager.select_for_update.return_value.get.return_value = current_session

        with (
            patch('apps.chat.conversation.models.ChatSession.objects', mock_manager),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.should_auto_generate_title',
                return_value=True,
            ),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.generate_title',
                return_value='AI 生成标题',
            ),
            patch('django.db.close_old_connections'),
            patch('django.db.transaction.atomic', return_value=nullcontext()),
            patch(
                'apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_title_update',
            ) as mock_publish,
        ):
            generate_session_title_task.run(
                session_id='sess-1',
                thread_id='thread-abc',
                user_message='帮我做一个计划',
                force=False,
            )

        assert current_session.title == '用户手动命名'
        current_session.save.assert_not_called()
        mock_publish.assert_not_called()

    def test_title_task_skips_when_user_messages_withdrawn(self):
        """#6154：Unsend 后无 user 消息时，task 不得再调 LLM / 写标题。"""
        initial_session = MagicMock()
        initial_session.title = '新对话'
        initial_session.title_generation_status = 'in_progress'
        initial_session.user_id = 'u-1'
        initial_session.messages.filter.return_value.exists.return_value = False

        mock_manager = MagicMock()
        mock_manager.get.return_value = initial_session

        with (
            patch('apps.chat.conversation.models.ChatSession.objects', mock_manager),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.should_auto_generate_title',
                return_value=True,
            ),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.generate_title',
            ) as mock_generate,
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.cancel_title_generation_for_empty_session',
            ) as mock_cancel,
            patch('django.db.close_old_connections'),
        ):
            generate_session_title_task.run(
                session_id='sess-empty',
                thread_id='thread-abc',
                user_message='已被撤回的首条',
                force=False,
            )

        mock_cancel.assert_called_once_with(initial_session, publish=True)
        mock_generate.assert_not_called()


class TestTitleCleanRejectsSceneLabel(SimpleTestCase):
    """#6154：拒绝把 title_generation scene 名落成会话标题。"""

    def test_clean_title_rejects_scene_display_name(self):
        assert TitleGeneratorService._clean_title('会话标题生成') is None
        assert TitleGeneratorService._clean_title('对话标题生成') is None
        assert TitleGeneratorService._clean_title('正常标题') == '正常标题'


class TestGenerateSessionTitleUserOnly(SimpleTestCase):
    """#6742：同步标题路径只把 user 消息交给 LLM（无 DB）。"""

    def test_generate_session_title_passes_only_user_messages(self):
        session = MagicMock()
        session.title = '新任务'
        session.title_generation_status = 'pending'
        session.id = 'sess-user-only'

        values_list_qs = MagicMock()
        values_list_qs.first.return_value = '我想了解机器学习'
        ordered = MagicMock()
        ordered.values_list.return_value = values_list_qs
        excluded = MagicMock()
        excluded.order_by.return_value = ordered
        filtered = MagicMock()
        filtered.exclude.return_value = excluded
        session.messages.filter.return_value = filtered

        with (
            patch(
                'apps.chat.conversation.services.title_generator.close_old_connections',
            ),
            patch.object(
                TitleGeneratorService,
                'should_auto_generate_title',
                return_value=True,
            ),
            patch.object(
                TitleGeneratorService,
                'generate_title',
                return_value='机器学习入门',
            ) as mock_generate,
        ):
            assert generate_session_title(session) is True

        session.messages.filter.assert_called_once_with(role='user')
        filtered.exclude.assert_called_once()
        mock_generate.assert_called_once()
        messages = mock_generate.call_args.args[0]
        assert messages == [{'role': 'user', 'content': '我想了解机器学习'}]
        assert session.title == '机器学习入门'
        session.save.assert_called_once()


@pytest.mark.django_db
class TestBackfillSessionTitles:
    """conversation.backfill_session_titles 周期任务的回归 + 行为锚点"""

    def setup_method(self):
        self.user = User.objects.create(username='tester', email='tester@example.com')

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_does_not_raise_fielderror(self, mock_delay):
        """smoke：backfill 能跑起来不抛 FieldError。

        历史 bug：filter(message_count__gt=0) 直接 FieldError——message_count 是
        list_sessions API 的 annotate 别名，模型本身没有这个字段。这条测试一行
        就能挡住"backfill 整个不能跑"的灾难。
        """
        _make_session(user=self.user, status='pending')
        result = backfill_session_titles(limit=10)
        assert isinstance(result, dict)
        assert 'enqueued' in result
        # 至少入队了那条 pending session
        assert mock_delay.called

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_skips_system_prompt_context_as_title_source(self, mock_delay):
        """#8667：首条 role=user 若是 system_prompt_context，应用后继真实 user 正文。"""
        sess = ChatSession.objects.create(
            user=self.user,
            organization_id='wt-test',
            title='新对话',
            title_generation_status='pending',
            last_message_at=timezone.now(),
        )
        ChatMessage.objects.create(
            session=sess,
            role='user',
            message_kind='system_prompt_context',
            text_summary='<identity>\n## 运行环境\n</identity>',
        )
        ChatMessage.objects.create(
            session=sess,
            role='user',
            message_kind='llm',
            text_summary='帮我画海报',
        )
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 1
        assert mock_delay.call_args.kwargs['user_message'] == '帮我画海报'

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_excludes_done(self, mock_delay):
        """status='done' 的 session 不应该被再次入队"""
        _make_session(user=self.user, status='done', title='已生成的标题')
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 0
        mock_delay.assert_not_called()

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_failed_within_cooldown_skipped(self, mock_delay):
        """failed 状态 4 小时内不重试——防永久错配额死循环"""
        recent_fail = timezone.now() - timedelta(hours=1)
        _make_session(user=self.user, status='failed', failed_at=recent_fail)
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 0
        mock_delay.assert_not_called()

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_failed_beyond_cooldown_retried(self, mock_delay):
        """failed 状态超过 4 小时后允许重试"""
        old_fail = timezone.now() - timedelta(hours=6)
        _make_session(user=self.user, status='failed', failed_at=old_fail)
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 1
        mock_delay.assert_called_once()

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_failed_without_timestamp_retried(self, mock_delay):
        """failed_at 为 NULL（边界数据）也应该重试，避免数据脏导致永久跳过"""
        _make_session(user=self.user, status='failed', failed_at=None)
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 1

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_stale_in_progress_picked_up(self, mock_delay):
        """in_progress 卡死超过 15 分钟视为僵死、重新入队。

        覆盖 spawn_title_thread mark in_progress 后 broker 失败 / worker 崩溃
        导致 session 永远卡 in_progress 的死局——backfill 必须能救。
        """
        sess = _make_session(user=self.user, status='in_progress')
        # 把 updated_at 拨到 20 分钟前模拟卡死
        old_ts = timezone.now() - timedelta(minutes=20)
        ChatSession.objects.filter(id=sess.id).update(updated_at=old_ts)

        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 1
        assert result['stale_in_progress_reset'] == 1
        mock_delay.assert_called_once()
        sess.refresh_from_db()
        assert sess.title_generation_status == 'pending'
        assert sess.title_generation_failed_at is None

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_recent_in_progress_skipped(self, mock_delay):
        """in_progress 不到 15 分钟说明 task 大概率还在跑，不应该重复入队"""
        _make_session(user=self.user, status='in_progress')
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 0
        mock_delay.assert_not_called()

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_session_without_messages_skipped(self, mock_delay):
        """无消息的 session 不应该生成标题（生成什么？）"""
        ChatSession.objects.create(
            user=self.user,
            organization_id='wt-test',
            title='新对话',
            title_generation_status='pending',
        )
        result = backfill_session_titles(limit=10)
        assert result['enqueued'] == 0
        mock_delay.assert_not_called()

    @patch('apps.chat.conversation.tasks.generate_session_title_task.delay')
    def test_backfill_fixes_status_for_already_titled_session(self, mock_delay):
        """历史遗留：title 已是真实值但 status 没维护到 done，backfill 顺手修对"""
        sess = _make_session(
            user=self.user,
            status='pending',
            title='真实有意义的标题',  # 不在默认值集合里
        )
        result = backfill_session_titles(limit=10)
        # 不入队，但修了 status
        assert result['enqueued'] == 0
        assert result['fixed_status'] == 1
        sess.refresh_from_db()
        assert sess.title_generation_status == 'done'


@pytest.mark.django_db
class TestMarkTitleGenerationFailed:
    """_mark_title_generation_failed 的行为锚点"""

    def setup_method(self):
        self.user = User.objects.create(username='tester', email='tester@example.com')

    def test_mark_failed_does_not_bump_updated_at(self):
        """标题生成失败是后台运维事件，不该把会话提到"今天"分组。

        前端 getSessionActivityTs 取 max(last_message_at, updated_at, created_at)
        决定时间分组。如果失败 mark 顺手 bump 了 updated_at，一个一周前会话
        每次失败都会跳到"今天"——视觉上诡异。
        """
        sess = _make_session(user=self.user, status='pending')

        # 把 updated_at 显式倒回去模拟"老 session"
        old_ts = timezone.now() - timedelta(days=7)
        ChatSession.objects.filter(id=sess.id).update(updated_at=old_ts)
        sess.refresh_from_db()
        assert (timezone.now() - sess.updated_at).days >= 6

        _mark_title_generation_failed(str(sess.id), reason='test')

        sess.refresh_from_db()
        # status 改了
        assert sess.title_generation_status == 'failed'
        assert sess.title_generation_failed_at is not None
        # 但 updated_at 没被 bump（仍然是一周前）
        assert (timezone.now() - sess.updated_at).days >= 6, (
            f"_mark_title_generation_failed 错误地 bump 了 updated_at（{sess.updated_at}），"
            f"会让老 session 跳到今天分组"
        )


@pytest.mark.django_db
class TestSpawnTitleThread:
    """``spawn_title_thread`` 行为锚点（broker 失败 / in_progress 跳过 / updated_at bump）。"""

    def setup_method(self):
        self.user = User.objects.create(username='tester', email='tester@example.com')

    def test_enqueue_atomically_bumps_updated_at(self):
        """mark in_progress 时必须 bump updated_at，否则 backfill 15 分钟 stale 检测
        会立即把 old session 误判卡死、重复入队。"""
        sess = _make_session(user=self.user, status='pending')
        old_ts = timezone.now() - timedelta(days=5)
        ChatSession.objects.filter(id=sess.id).update(updated_at=old_ts)

        with patch.object(generate_session_title_task, 'delay'):
            _enqueue_atomically(
                str(sess.id),
                generate_session_title_task,
                thread_id='t',
                user_message='hi',
                force=False,
            )

        sess.refresh_from_db()
        assert sess.title_generation_status == 'in_progress'
        # updated_at 必须是新的 now（不再是 5 天前），否则 backfill 会立刻误判卡死
        assert (timezone.now() - sess.updated_at).total_seconds() < 60, (
            f"_enqueue_atomically 没有 bump updated_at（仍是 {sess.updated_at}），"
            f"backfill 15 分钟 stale 检测会立即把它误判为卡死、重复入队"
        )

    def test_already_in_progress_raises(self):
        """已经 in_progress 的 session 再次入队抛 _AlreadyInProgress——防 sendMessage+
        selectSession 兜底并发触发多次入队。"""
        sess = _make_session(user=self.user, status='in_progress')
        with pytest.raises(_AlreadyInProgress):
            _enqueue_atomically(
                str(sess.id),
                generate_session_title_task,
                thread_id='t',
                user_message='hi',
                force=False,
            )

    def test_broker_failure_marks_failed_not_stuck_in_progress(self):
        """broker / 任意异常导致 .delay() 失败时,session 不能永远卡 in_progress——
        必须 mark failed,让 backfill 4 小时退避 cooldown 路径接管,而不是依赖
        15 分钟 stale 检测(P1-1 bump updated_at 后会失效)。"""
        sess = _make_session(user=self.user, status='pending')

        # mock 让 _enqueue_atomically 内部的 task.delay() 在 transaction commit 之后才抛错
        with patch.object(
            generate_session_title_task, 'delay',
            side_effect=RuntimeError('broker down'),
        ):
            # spawn_title_thread 必须 swallow 异常,不能阻断主消息流
            spawn_title_thread(
                session_id=str(sess.id),
                thread_id='thread-abc',
                user_message='hi',
                force=False,
            )

        sess.refresh_from_db()
        # status 应该被推到 failed,这样 backfill 走 4 小时退避路径有判定可依
        # (不再永久卡 in_progress)
        assert sess.title_generation_status == 'failed', (
            f"broker 失败时 session status={sess.title_generation_status}，"
            f"应该被显式 mark failed 而不是永久卡 in_progress"
        )
        assert sess.title_generation_failed_at is not None


class TestIsTransientExc:
    """``_is_transient_exc`` 必须识别第三方 LLM 客户端的瞬时错——不光是 Python 内置。"""

    def test_builtin_connection_error_is_transient(self):
        assert _is_transient_exc(ConnectionError('reset'))

    def test_builtin_timeout_is_transient(self):
        assert _is_transient_exc(TimeoutError('timeout'))

    def test_value_error_is_not_transient(self):
        """SceneBinding 未配置等永久错应该 mark failed,不该 retry。"""
        assert not _is_transient_exc(ValueError('LLMSceneBinding not found'))

    def test_scene_rate_limit_is_transient(self):
        exc = SceneCallError('provider rejected request', scene_key='title_generation', error_code='RATE_LIMIT')
        assert _is_transient_exc(exc)

    def test_scene_provider_down_is_transient(self):
        exc = SceneCallError('provider down', scene_key='title_generation', error_code='PROVIDER_DOWN')
        assert _is_transient_exc(exc)

    def test_title_generator_reraises_retryable_scene_error(self):
        """RATE_LIMIT 必须交给 Celery retry，不能被吞成空标题后直接 mark failed。"""
        session = MagicMock(user_id='u-1', organization_id='wt-1')
        exc = SceneCallError('rate limited', scene_key='title_generation', error_code='RATE_LIMIT')
        with (
            patch.object(
                TitleGeneratorService,
                '_resolve_selected_model_id',
                return_value='model-byok',
            ),
            patch('apps.services.llm.services.chat.unified_llm_call', side_effect=exc),
        ):
            with pytest.raises(SceneCallError):
                TitleGeneratorService.generate_title(
                    [{'role': 'user', 'content': '帮我写一个计划'}],
                    session=session,
                )

    def test_task_retries_scene_rate_limit_without_marking_failed(self):
        """task 层必须把 RATE_LIMIT 交给 Celery retry，而不是直接把 session 标 failed。"""
        session = MagicMock()
        session.title = '新对话'
        session.title_generation_status = 'in_progress'
        session.user_id = 'u-1'

        mock_manager = MagicMock()
        mock_manager.get.return_value = session

        exc = SceneCallError('rate limited', scene_key='title_generation', error_code='RATE_LIMIT')
        retry_exc = RuntimeError('retry-called')
        with (
            patch('apps.chat.conversation.models.ChatSession.objects', mock_manager),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.should_auto_generate_title',
                return_value=True,
            ),
            patch(
                'apps.chat.conversation.services.title_generator.TitleGeneratorService.generate_title',
                side_effect=exc,
            ),
            patch('django.db.close_old_connections'),
            patch.object(generate_session_title_task, 'retry', side_effect=retry_exc) as mock_retry,
            patch('apps.chat.conversation.tasks._mark_title_generation_failed') as mock_mark_failed,
        ):
            with pytest.raises(RuntimeError, match='retry-called'):
                generate_session_title_task.run(
                    session_id='sess-1',
                    thread_id='thread-abc',
                    user_message='帮我做一个计划',
                    force=False,
                )

        mock_retry.assert_called_once()
        mock_mark_failed.assert_not_called()

    def test_httpx_timeout_recognized_when_installed(self):
        """httpx.TimeoutException 是最常见的 LLM HTTP 超时——必须被识别为瞬时错。

        老版本只看内置 TimeoutError,httpx 抛的 TimeoutException 会被识别为永久错、
        立即 mark failed → 用户标题 4 小时内不再重试。dogfood 现场 LLM 偶发慢响应
        会被这条吃掉。
        """
        try:
            import httpx
        except ImportError:
            pytest.skip('httpx not installed')
        exc = httpx.TimeoutException('llm slow')
        assert _is_transient_exc(exc), (
            'httpx.TimeoutException 应该被识别为瞬时错 → bubble retry,'
            '而非 mark failed 进 4 小时退避'
        )

    def test_httpx_connect_error_recognized_when_installed(self):
        try:
            import httpx
        except ImportError:
            pytest.skip('httpx not installed')
        exc = httpx.ConnectError('no route')
        assert _is_transient_exc(exc)


@pytest.mark.django_db
class TestArchiveEmptySessions:
    """``archive_empty_sessions`` 运维兜底（ 起不再挂 beat；客户端放弃即清）。"""

    def setup_method(self):
        self.user = User.objects.create(username='tester', email='tester@example.com')

    def _empty_session(self, created_at=None, status='active', thread_id=None):
        sess = ChatSession.objects.create(
            user=self.user,
            organization_id='wt-test',
            title='新对话',
            status=status,
            thread_id=thread_id,
        )
        if created_at:
            ChatSession.objects.filter(id=sess.id).update(created_at=created_at)
        return sess

    def test_archives_old_empty_session(self):
        """无消息 + 创建超过 2h 的 active session 应该被归档"""
        old_ts = timezone.now() - timedelta(hours=3)
        sess = self._empty_session(created_at=old_ts)

        result = archive_empty_sessions()
        assert result['archived'] == 1
        sess.refresh_from_db()
        assert sess.status == 'archived'

    def test_does_not_archive_recent_empty_session(self):
        """1 小时前刚点 + 还没发消息——可能用户正在思考，别动它"""
        recent_ts = timezone.now() - timedelta(hours=1)
        sess = self._empty_session(created_at=recent_ts)

        result = archive_empty_sessions()
        assert result['archived'] == 0
        sess.refresh_from_db()
        assert sess.status == 'active'

    def test_does_not_archive_session_with_messages(self):
        """有消息的 session 永远不应该被这个 GC 误删——这是数据安全锚点"""
        old_ts = timezone.now() - timedelta(days=30)
        sess = self._empty_session(created_at=old_ts)
        ChatMessage.objects.create(session=sess, role='user', text_summary='hi')

        result = archive_empty_sessions()
        assert result['archived'] == 0
        sess.refresh_from_db()
        assert sess.status == 'active'

    def test_does_not_touch_archived_session(self):
        """已经归档的 session 不重复处理（status 是 'archived' 不在 'active' 范围）"""
        old_ts = timezone.now() - timedelta(days=30)
        sess = self._empty_session(created_at=old_ts, status='archived')

        result = archive_empty_sessions()
        assert result['archived'] == 0

    def test_does_not_touch_subagent_session(self):
        """子 agent session 由父 agent 生命周期管理，本 GC 不动它们"""
        old_ts = timezone.now() - timedelta(hours=3)
        sess = self._empty_session(
            created_at=old_ts,
            thread_id=f'chat-session-{sess_uuid()}-sub-abc',
        )

        result = archive_empty_sessions()
        assert result['archived'] == 0
        sess.refresh_from_db()
        assert sess.status == 'active'


def sess_uuid():
    """工具：随便生成一个 uuid 字符串给 thread_id 用"""
    import uuid as _uuid
    return str(_uuid.uuid4())
