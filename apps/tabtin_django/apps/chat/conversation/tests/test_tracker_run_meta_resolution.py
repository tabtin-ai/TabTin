"""
Wave 5 (charter v1.8 §6.7): _resolve_tracker_run_meta 单测

⚠️ ⚠️ ⚠️  CI / Reviewer / Agent 必读  ⚠️ ⚠️ ⚠️
═══════════════════════════════════════════════════════════════════════
本文件下方 5 个 TransactionTestCase **真 ORM 路径用例**守
`TABTIN_REAL_DB_TEST=1` 环境变量。**默认不启用 → 默认全部 skip**。

后果:如果跑测试时未显式 export `TABTIN_REAL_DB_TEST=1`,
**反思 9 防线（"代码改对了反而单测红"）形同虚设** —
真路径根本没跑过,跟没写一样。

正确启用方式(本地 / CI):
  TABTIN_REAL_DB_TEST=1 python manage.py test \
    apps.chat.conversation.tests.test_tracker_run_meta_resolution

CI 待办(Wave 5 二次续作 P1(新)-B,Harness 评估):
  仓库 .github/workflows/ 当前**没有任何 workflow 跑 Django test** —
  pytest / manage.py test 在 .github/workflows/*.yml 里 grep 0 命中。
  新增 Django test workflow 时**必须**:
    env:
      TABTIN_REAL_DB_TEST: "1"
  否则 CI 即使跑也会全部 skip,等于没跑。

文档参考:apps/tabtin_django/README.md §测试
═══════════════════════════════════════════════════════════════════════

验证(P0-7 续作修订):
  1. 纯函数契约层 — SimpleTestCase 速度优先,只覆盖 schema / 静默回退路径
  2. 真实 ORM 路径 — TransactionTestCase 走 mysql + postgresql 双库,验证:
     - run_index 计算正确(顺序号)
     - tracker_origin 默认值 = user_created
     - started_at / finished_at ISO 序列化
     - chat_session_id 反向 FK 路径不被 except 误吞
  3. 不许用 MagicMock 制造已删字段对象(总控反思 9 教训)

避免 Wave 4 P0 教训(MagicMock 让"看起来工作"通过测试):
  - 真路径用真实 Django ORM 存数据
  - SimpleTestCase 走 ORM 异常被 except 吞 → 已升级为 TransactionTestCase
"""

import os
import uuid
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase
from django.utils import timezone

# P0-7 续作 (Wave 5 续作 Agent 注): 本地 sqlite test runner 跑 chat 模块全套 migration 时
# RawSQL CREATE INDEX 语法不兼容(预存在环境问题),会导致 setup_databases 整体失败。
# TransactionTestCase 真路径需要真实 PG / MySQL test DB,通过环境变量 TABTIN_REAL_DB_TEST=1
# 显式启用 — CI / 本地有真库时跑;dev 环境默认 skip 避免阻塞所有测试启动。
# 守护原则: 测试不应"代码改对了反而单测红"(任务底线第二条)。
#
# Wave 5 二次续作 P1(新)-B 警告: 该 env var **CI 默认未启用**(见文件头红框)。
# 任何执行环境(CI / 本地 / 远程 runner)若未显式 export `TABTIN_REAL_DB_TEST=1`,
# 5 个真 ORM 用例**全部 skip**,反思 9 防线形同虚设 —— 等于没测。
_REQUIRES_REAL_DB = os.getenv('TABTIN_REAL_DB_TEST') == '1'


class TrackerRunMetaResolutionContractTest(SimpleTestCase):
    """契约层快速测试 — 不写 ORM,只验证 schema + 静默回退。

    SimpleTestCase 不开 transaction,跨库 ORM 写入会失败 → 真路径用 TransactionTestCase 覆盖。
    """

    def test_resolver_returns_none_when_scheduler_unavailable(self):
        """scheduler import 异常时静默返回 None(charter §6.7 不让 chat API 因 scheduler 故障 500)"""
        from apps.chat.conversation.api import _common as common_mod

        class FakeSession:
            id = '00000000-0000-0000-0000-000000000002'

        original_import = __builtins__['__import__'] if isinstance(__builtins__, dict) else __builtins__.__import__

        def fake_import(name, *args, **kwargs):
            if name == 'apps.tracker.models':
                raise ImportError('forced')
            return original_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=fake_import):
            result = common_mod._resolve_tracker_run_meta(FakeSession())
        self.assertIsNone(result)

    def test_chat_session_schema_accepts_tracker_run_field(self):
        """ChatSessionSchema 接受 tracker_run 字段(契约钉死,前端依赖此字段)"""
        from apps.chat.conversation.schemas import ChatSessionSchema

        # 字段必须存在
        self.assertIn('tracker_run', ChatSessionSchema.model_fields)

        # 字段是 Optional[dict],允许 None / dict
        sample = ChatSessionSchema(
            id='00000000-0000-0000-0000-000000000003',
            title='t',
            status='active',
            organization_id='wt-1',
            created_at=timezone.now(),
            updated_at=timezone.now(),
            tracker_run={
                'run_id': 'r-1',
                'run_index': 5,
                'run_status': 'success',
                'tracker_id': 'tr-1',
                'tracker_name': 'PR 整理',
                'tracker_origin': 'user_created',
                'trigger_type': 'cron',
                'tracker_trigger_type': 'cron',
                'trigger_context': {'cron': '0 9 * * 1'},
                'started_at': None,
                'finished_at': None,
            },
        )
        self.assertEqual(sample.tracker_run['run_index'], 5)
        self.assertEqual(sample.tracker_run['tracker_origin'], 'user_created')
        self.assertEqual(sample.tracker_run['tracker_trigger_type'], 'cron')


# P0-7 续作: 真路径 TransactionTestCase 仅在 TABTIN_REAL_DB_TEST=1 下定义。
# Django test runner 在 setup_databases 阶段会扫描所有 TestCase 子类的 databases 属性,
# 即便 setUpClass 抛 SkipTest 也已经晚了 — 必须从源头不定义,sqlite 默认环境才不会
# 触发"创建 PG test DB"链路而失败。设了 TABTIN_REAL_DB_TEST=1 → 走 PG test DB,真路径生效。
if _REQUIRES_REAL_DB:
    class TrackerRunMetaResolutionRealOrmTest(TransactionTestCase):
        """P0-7 修复(总控反思 9 / 14 教训): 真实 ORM 路径走通跨库 conversation + scheduler。

        Wave 5 主体测试只用 SimpleTestCase,跨库 ORM 异常被 except 吞 → 测试"通过"
        但实际业务正确性未被验证。本测试用 TransactionTestCase 让 default + postgresql
        都进 transaction,真路径写入 ChatSession + Goal + GoalRun,验证:
          - run_index 计算正确(同 Goal 多 Run 顺序号)
          - tracker_origin = user_created(charter §7.1 origin 字段已移除,固定值)
          - started_at / finished_at ISO 序列化
          - chat_session_id 反向 FK 路径不被 except 误吞
        """
        databases = {"default", "postgresql"}

        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            # 防止 tabtinspace 自动创建 default organization 的 signal 干扰
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.disconnect(create_default_organization, sender=get_user_model())

        @classmethod
        def tearDownClass(cls):
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.connect(create_default_organization, sender=get_user_model())
            super().tearDownClass()

        def setUp(self):
            from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
            ctx = create_test_organization_with_agent(prefix='tr_meta')
            self.user = ctx['user']
            self.organization = ctx['organization']
            self.agent = ctx['agent']
            self.space = ctx['space']

        def tearDown(self):
            from apps.tabtinspace.tests.fixtures import cleanup_test_organization
            cleanup_test_organization(self.organization, delete_user=True)

        def _create_chat_session(self, title='session'):
            from apps.chat.conversation.models import ChatSession
            return ChatSession.objects.create(
                id=uuid.uuid4(),
                user=self.user,
                organization_id=str(self.organization.id),
                # v0.1 §5.1：space 是软引用 property 无 setter，必须用 _id 字段赋值
                space_id=self.space.id if self.space else None,
                title=title,
                status='active',
            )

        def _create_goal(self, name='Tracker A', trigger_type='manual'):
            from apps.tracker.models import Tracker
            return Tracker.objects.create(
                id=uuid.uuid4(),
                organization_id=self.organization.id,
                space_id=self.space.id if self.space else None,
                agent_id=self.agent.id,
                name=name,
                description='',
                skill_key='test_skill',
                trigger_type=trigger_type,
                trigger_config={},
                status='active',
                created_by_id=self.user.id,
            )

        def _create_run(self, goal, *, chat_session=None, status='success',
                         trigger_type='manual', trigger_context=None,
                         started_at=None, finished_at=None):
            from apps.tracker.models import TrackerRun
            return TrackerRun.objects.create(
                id=uuid.uuid4(),
                tracker=goal,
                chat_session_id=chat_session.id if chat_session else None,
                status=status,
                trigger_type=trigger_type,
                trigger_context=trigger_context or {},
                started_at=started_at,
                finished_at=finished_at,
            )

        def test_resolve_returns_none_when_no_run_linked(self):
            """ChatSession 没有任何 GoalRun 关联 → 返回 None(走真 ORM 路径)"""
            from apps.chat.conversation.api._common import _resolve_tracker_run_meta
            session = self._create_chat_session(title='no-tracker')
            result = _resolve_tracker_run_meta(session)
            self.assertIsNone(result)

        def test_resolve_full_meta_with_run_index_and_iso_timestamps(self):
            """Run 关联时返回正确字段集 + run_index 顺序号 + ISO 时间戳序列化"""
            from apps.chat.conversation.api._common import _resolve_tracker_run_meta

            # 同 Goal 创 3 个 Run,目标 session 关联第 2 个
            goal = self._create_goal(name='周报整理')

            session1 = self._create_chat_session(title='run-1')
            session2 = self._create_chat_session(title='run-2')
            session3 = self._create_chat_session(title='run-3')

            self._create_run(goal, chat_session=session1, status='success', trigger_type='manual')
            # 关键: started_at / finished_at 必须 ISO 序列化
            started = timezone.now()
            finished = timezone.now()
            run2 = self._create_run(
                goal,
                chat_session=session2,
                status='success',
                trigger_type='cron',
                trigger_context={'cron': '0 9 * * 1', 'agent_id': str(self.agent.id)},
                started_at=started,
                finished_at=finished,
            )
            self._create_run(goal, chat_session=session3, status='running', trigger_type='manual')

            result = _resolve_tracker_run_meta(session2)
            self.assertIsNotNone(result, 'tracker_run meta 不应为 None — 反向 FK 路径走通')
            self.assertEqual(result['run_id'], str(run2.id))
            # run_index 是按 created_at 升序计数(<=该 run 的总数),session2 是第 2 创建,index = 2
            self.assertEqual(result['run_index'], 2)
            self.assertEqual(result['run_status'], 'success')
            self.assertEqual(result['tracker_id'], str(goal.id))
            self.assertEqual(result['tracker_name'], '周报整理')
            # charter §7.1 origin 字段已移除,固定 user_created
            self.assertEqual(result['tracker_origin'], 'user_created')
            self.assertEqual(result['trigger_type'], 'cron')
            # Run 来源与原任务类型分开返回；该 fixture 的原任务是 manual。
            self.assertEqual(result['tracker_trigger_type'], 'manual')
            self.assertEqual(result['trigger_context']['cron'], '0 9 * * 1')
            # ISO 时间戳序列化(前端需 ISO 格式)
            self.assertIsNotNone(result['started_at'])
            self.assertIsNotNone(result['finished_at'])
            self.assertIn('T', result['started_at'])  # ISO 含 T 分隔符
            self.assertIn('T', result['finished_at'])

        def test_resolve_picks_latest_run_when_multiple(self):
            """同 ChatSession 关联多个 Run(罕见)时,取最新(charter §7.2 默认 per_run 但保护)"""
            from apps.chat.conversation.api._common import _resolve_tracker_run_meta
            goal = self._create_goal(name='多 Run')
            session = self._create_chat_session(title='multi-run')
            # 创 2 个关联同 session 的 Run,resolver 应取 created_at 最晚那条
            self._create_run(goal, chat_session=session, status='success')
            new_run = self._create_run(goal, chat_session=session, status='running')

            result = _resolve_tracker_run_meta(session)
            self.assertEqual(result['run_id'], str(new_run.id), '应取最新 Run')
            self.assertEqual(result['run_status'], 'running')

        def test_resolve_cross_db_fk_does_not_500(self):
            """charter §6.7: 反向 FK 跨库异常被吞,绝不让 chat API 因 scheduler 故障 500。

            本测试通过创建一个不在 GoalRun 中的 session.id,resolver 走 .filter(...).first()
            返 None,不抛异常 — 真实路径走通(不是 except 兜底)。
            """
            from apps.chat.conversation.api._common import _resolve_tracker_run_meta
            session = self._create_chat_session(title='unrelated')
            # session 没有 GoalRun 关联,直接 first() 返 None
            result = _resolve_tracker_run_meta(session)
            self.assertIsNone(result)

        def test_batch_meta_keeps_run_source_and_tracker_trigger_separate(self):
            """批量会话列表也应返回原任务类型，支持手动执行过的定时任务归档。"""
            from apps.chat.conversation.api._common import _batch_resolve_tracker_run_meta

            goal = self._create_goal(name='定时日报', trigger_type='cron')
            session = self._create_chat_session(title='manual-run')
            self._create_run(goal, chat_session=session, trigger_type='manual')

            result = _batch_resolve_tracker_run_meta([session])[str(session.id)]
            self.assertEqual(result['trigger_type'], 'manual')
            self.assertEqual(result['tracker_trigger_type'], 'cron')

        def test_session_to_schema_invokes_real_resolver(self):
            """_session_to_schema 调用 _resolve_tracker_run_meta 时,真实 ORM 路径返回 dict 而非 None"""
            from apps.chat.conversation.api import _common
            from apps.chat.conversation.api._common import _session_to_schema
            from apps.chat.conversation.models import ChatSession

            goal = self._create_goal(name='整理 PR')
            session = self._create_chat_session(title='real-path')
            self._create_run(goal, chat_session=session, status='success', trigger_type='manual')

            # 走真 _session_to_schema(不 patch resolver),验证字段穿透到 schema
            # 拉一次 ORM 拿到 session 对象(避免 setUp 时 cache)
            fresh = ChatSession.objects.get(pk=session.pk)
            with patch.object(_common, '_build_session_rollback_state', return_value=None):
                schema = _session_to_schema(fresh)

            self.assertIsNotNone(schema.tracker_run, '真 ORM 路径下 tracker_run 不应为 None')
            self.assertEqual(schema.tracker_run['tracker_name'], '整理 PR')
            self.assertEqual(schema.tracker_run['tracker_origin'], 'user_created')
            self.assertEqual(schema.tracker_run['tracker_trigger_type'], 'manual')
