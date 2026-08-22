from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from unittest.mock import patch

from apps.agent.models import Agent
from apps.tabtinspace.models import (
    ContextItem,
    Device,
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    ProjectTask,
    ProjectTaskDeliverable,
    ProjectTaskEvent,
    ProjectTaskRun,
    SpaceActivityEvent,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_execution import resolve_project_execution_workspace
from apps.tabtinspace.services.project_task_service import ProjectTaskService
from apps.tabtinspace.services.project_task_runtime import (
    _safe_failure_message,
    evaluate_project_task_chat_send_gate,
    execute_project_task_run,
)
from apps.tabtinspace.services.project_task_results import collect_run_result_items

User = get_user_model()


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectTaskServiceTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='task-owner',
            email='task-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='task-member',
            email='task-member@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Task Team',
            owner=self.owner,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role='owner',
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor',
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name='Launch',
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.owner,
            role='owner',
            status=ProjectMembership.Status.ACTIVE,
            is_active=True,
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.member,
            role='editor',
            status=ProjectMembership.Status.ACTIVE,
            is_active=True,
        )
        self.owner_workspace = self._workspace(self.owner, 'owner-device', '/tmp/launch-owner')
        self.member_workspace = self._workspace(self.member, 'member-device', '/tmp/launch-member')
        self.owner_link = ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.owner,
            workspace=self.owner_workspace,
        )
        self.member_link = ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.member,
            workspace=self.member_workspace,
        )
        self.owner_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name='Owner Agent',
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name='Member Agent',
        )

    def _workspace(self, user, fingerprint: str, path: str) -> Workspace:
        device = Device.objects.create(
            organization=self.organization,
            user=user,
            name=fingerprint,
            device_type='electron',
            role='control',
            fingerprint=fingerprint,
            status='online',
        )
        return Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=user,
            name='Project Workspace',
            working_dir=path,
            normalized_working_dir=path,
        )

    def test_self_assignment_is_immediately_accepted(self):
        payload = ProjectTaskService(user=self.owner).create_task(
            project_id=self.project.id,
            title='Prepare launch',
            responsible_user_id=self.owner.id,
        )

        self.assertEqual(payload['assignment_status'], ProjectTask.AssignmentStatus.ACCEPTED)
        self.assertFalse(payload['execution_ready'])
        detail = ProjectTaskService(user=self.owner).get_task(
            project_id=self.project.id,
            task_id=payload['id'],
        )
        self.assertEqual(detail['events'][0]['event_type'], 'created')

    def test_other_member_accepts_then_configures_only_their_execution(self):
        created = ProjectTaskService(user=self.owner).create_task(
            project_id=self.project.id,
            title='Review release',
            responsible_user_id=self.member.id,
        )
        accepted = ProjectTaskService(user=self.member).respond_assignment(
            project_id=self.project.id,
            task_id=created['id'],
            accept=True,
        )
        configured = ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )

        self.assertEqual(accepted['assignment_status'], ProjectTask.AssignmentStatus.ACCEPTED)
        self.assertTrue(configured['execution_ready'])
        self.assertEqual(configured['selected_agent']['id'], str(self.member_agent.id))
        self.assertEqual(configured['project_workspace']['id'], str(self.member_workspace.id))

    def test_creator_cannot_choose_execution_for_other_responsible_member(self):
        created = ProjectTaskService(user=self.owner).create_task(
            project_id=self.project.id,
            title='Review release',
            responsible_user_id=self.member.id,
        )

        with self.assertRaises(ServiceError) as context:
            ProjectTaskService(user=self.owner).configure_execution(
                project_id=self.project.id,
                task_id=created['id'],
                agent_id=self.owner_agent.id,
                workspace_id=self.owner_workspace.id,
            )

        self.assertEqual(context.exception.code, 'TASK_RESPONSIBLE_ONLY')

    def test_non_responsible_member_reads_results_but_not_private_details(self):
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Private execution',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )
        run = ProjectTaskRun.objects.create(
            task_id=created['id'],
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='Unreviewed private output',
            result_items=[{
                'id': 'item-private-1',
                'title': 'Private doc',
                'resource_type': 'tabdoc',
                'resource_id': 'doc-private-1',
            }],
            binding_snapshot={'workspace_name': 'Secret Workspace'},
            safe_failure_reason='raw stack for responsible only',
        )
        task = ProjectTask.objects.get(id=created['id'])
        ProjectTaskService._event(task, self.member, 'run_started', {
            'run_id': str(run.id),
            'chat_session_id': 'private-session-id',
        })

        visible = ProjectTaskService(user=self.owner).get_task(
            project_id=self.project.id,
            task_id=created['id'],
        )

        self.assertIsNone(visible['project_workspace'])
        self.assertTrue(visible['workspace_confirmed'])
        self.assertEqual(visible['result_visibility'], ProjectTask.ResultVisibility.PRIVATE)
        # ：未完成任务上，非责任成员默认可读结果摘要与候选产物……
        self.assertEqual(
            visible['latest_run']['result_summary'], 'Unreviewed private output',
        )
        self.assertEqual(len(visible['latest_run']['result_items']), 1)
        self.assertEqual(
            visible['latest_run']['result_items'][0]['resource_id'], 'doc-private-1',
        )
        # ……但会话 / 绑定快照 / 原始失败原因等 private 字段仍对非责任人隔离。
        self.assertIsNone(visible['latest_run']['chat_session_id'])
        self.assertEqual(visible['latest_run']['safe_failure_reason'], '')
        self.assertEqual(visible['latest_run']['binding'], {})
        self.assertEqual(str(run.id), visible['latest_run']['id'])
        self.assertEqual(len(visible['conversations']), 1)
        self.assertIsNone(visible['conversations'][0]['session_id'])
        self.assertEqual(visible['conversations'][0]['run_id'], str(run.id))
        run_started = next(
            event for event in visible['events']
            if event['event_type'] == 'run_started'
        )
        self.assertNotIn('chat_session_id', run_started['payload'])

        private = ProjectTaskService(user=self.member).get_task(
            project_id=self.project.id,
            task_id=created['id'],
        )
        private_run_started = next(
            event for event in private['events']
            if event['event_type'] == 'run_started'
        )
        self.assertEqual(
            private_run_started['payload']['chat_session_id'],
            'private-session-id',
        )

    def test_member_reads_unfinished_results_regardless_of_visibility(self):
        """#7261：未完成任务上成员默认可读候选产物，result_visibility 开关不再是门槛。"""
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Previewable result',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )
        ProjectTask.objects.filter(id=created['id']).update(
            work_status=ProjectTask.WorkStatus.IN_REVIEW,
        )
        ProjectTaskRun.objects.create(
            task_id=created['id'],
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='Shared preview summary',
            result_items=[{
                'id': 'item-preview-1',
                'title': 'Candidate doc',
                'resource_type': 'tabdoc',
                'resource_id': 'doc-preview-1',
            }],
            binding_snapshot={'workspace_name': 'Secret Workspace'},
            safe_failure_reason='keep private',
        )

        def member_run_view() -> dict:
            return ProjectTaskService(user=self.owner).get_task(
                project_id=self.project.id,
                task_id=created['id'],
            )['latest_run']

        # 默认 result_visibility=private 时，非责任成员已能读结果摘要与候选产物，
        # 但会话 / 绑定 / 原始失败原因等 private 字段始终隔离。
        default_view = member_run_view()
        self.assertEqual(default_view['result_summary'], 'Shared preview summary')
        self.assertEqual(len(default_view['result_items']), 1)
        self.assertEqual(default_view['result_items'][0]['id'], 'item-preview-1')
        self.assertIsNone(default_view['chat_session_id'])
        self.assertEqual(default_view['binding'], {})
        self.assertEqual(default_view['safe_failure_reason'], '')

        # set_result_visibility 已降级：API 仍能改开关并记事件，但不影响成员可读性。
        with self.captureOnCommitCallbacks(execute=True):
            opened = ProjectTaskService(user=self.member).set_result_visibility(
                project_id=self.project.id,
                task_id=created['id'],
                result_visibility=ProjectTask.ResultVisibility.PROJECT_PREVIEW,
            )
        self.assertEqual(
            opened['result_visibility'],
            ProjectTask.ResultVisibility.PROJECT_PREVIEW,
        )
        self.assertTrue(
            any(
                event['event_type'] == 'result_visibility_changed'
                for event in opened['events']
            ),
        )
        self.assertTrue(
            SpaceActivityEvent.objects.filter(
                space_id=self.project.id,
                event_type=SpaceActivityEvent.EventType.TASK_RESULT_PREVIEW_CHANGED,
                target_type='task',
                target_id=str(created['id']),
            ).exists(),
        )
        self.assertEqual(member_run_view()['result_summary'], 'Shared preview summary')

        # 关键翻转：切回 private 后，未完成任务上成员仍可读候选产物（不再被隐藏）。
        with self.captureOnCommitCallbacks(execute=True):
            closed = ProjectTaskService(user=self.member).set_result_visibility(
                project_id=self.project.id,
                task_id=created['id'],
                result_visibility=ProjectTask.ResultVisibility.PRIVATE,
            )
        self.assertEqual(closed['result_visibility'], ProjectTask.ResultVisibility.PRIVATE)

        still_visible = member_run_view()
        self.assertEqual(still_visible['result_summary'], 'Shared preview summary')
        self.assertEqual(len(still_visible['result_items']), 1)
        self.assertIsNone(still_visible['chat_session_id'])
        self.assertEqual(still_visible['binding'], {})

    def test_non_responsible_cannot_set_result_visibility(self):
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Locked visibility',
            responsible_user_id=self.member.id,
        )

        with self.assertRaises(ServiceError) as context:
            ProjectTaskService(user=self.owner).set_result_visibility(
                project_id=self.project.id,
                task_id=created['id'],
                result_visibility=ProjectTask.ResultVisibility.PROJECT_PREVIEW,
            )

        self.assertEqual(context.exception.code, 'TASK_RESPONSIBLE_ONLY')

    def test_responsible_member_cannot_use_another_members_agent(self):
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Own task',
            responsible_user_id=self.member.id,
        )

        with self.assertRaises(ServiceError) as context:
            ProjectTaskService(user=self.member).configure_execution(
                project_id=self.project.id,
                task_id=created['id'],
                agent_id=self.owner_agent.id,
                workspace_id=self.member_workspace.id,
            )

        self.assertEqual(context.exception.code, 'TASK_AGENT_INVALID')

    def test_responsible_member_can_switch_to_another_owned_workspace(self):
        alt_workspace = self._workspace(self.member, 'member-device-alt', '/tmp/launch-member-alt')
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Switch workspace',
            responsible_user_id=self.member.id,
        )
        configured = ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=alt_workspace.id,
        )
        self.assertEqual(configured['project_workspace']['id'], str(alt_workspace.id))
        self.assertEqual(
            ProjectMemberWorkspace.objects.get(project=self.project, user=self.member).workspace_id,
            alt_workspace.id,
        )

    def test_explicit_project_workspace_link_is_execution_source(self):
        resolved = resolve_project_execution_workspace(project=self.project, user=self.member)
        self.assertEqual(resolved.id, self.member_workspace.id)

    @patch('apps.tabtinspace.tasks.execute_project_task_run.delay')
    def test_responsible_member_starts_run_with_immutable_binding(self, delay):
        task = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Ship release',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=task['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )

        with self.captureOnCommitCallbacks(execute=True):
            result = ProjectTaskService(user=self.member).start_run(
                project_id=self.project.id,
                task_id=task['id'],
            )

        run = ProjectTaskRun.objects.get(id=result['run']['id'])
        self.assertEqual(run.workspace_id, self.member_workspace.id)
        self.assertEqual(run.device_id, self.member_workspace.device_id)
        self.assertEqual(run.binding_snapshot['agent_id'], str(self.member_agent.id))
        self.assertEqual(result['task']['work_status'], ProjectTask.WorkStatus.IN_PROGRESS)
        self.assertFalse(
            SpaceActivityEvent.objects.filter(
                space_id=self.project.id,
                event_type=SpaceActivityEvent.EventType.AGENT_RUN_STARTED,
                target_type='task',
                target_id=str(task['id']),
            ).exists(),
            'Task service must not duplicate the runtime-owned Agent start activity',
        )
        delay.assert_called_once_with(str(run.id))

    @patch('apps.tabtinspace.tasks.execute_project_task_run.delay')
    def test_accept_result_publishes_project_asset_from_in_progress(self, _delay):
        task = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Ship release',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=task['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )
        with self.captureOnCommitCallbacks(execute=True):
            started = ProjectTaskService(user=self.member).start_run(
                project_id=self.project.id,
                task_id=task['id'],
            )
        run = ProjectTaskRun.objects.get(id=started['run']['id'])
        run.status = ProjectTaskRun.Status.COMPLETED
        run.result_summary = 'Release package and validation notes are ready.'
        run.save(update_fields=['status', 'result_summary', 'updated_at'])
        ProjectTask.objects.filter(id=task['id']).update(work_status=ProjectTask.WorkStatus.IN_PROGRESS)

        accepted = ProjectTaskService(user=self.member).accept_result(
            project_id=self.project.id,
            task_id=task['id'],
        )

        deliverable = ProjectTaskDeliverable.objects.select_related('context_item').get(task_id=task['id'])
        self.assertEqual(accepted['work_status'], ProjectTask.WorkStatus.DONE)
        self.assertEqual(deliverable.context_item.project_id, self.project.id)
        self.assertIsNone(deliverable.context_item.workspace_id)
        self.assertEqual(deliverable.context_item.metadata['asset_kind'], 'task_deliverable')
        self.assertNotIn('/tmp/launch-member', deliverable.context_item.preview)

    @patch('apps.tabtinspace.tasks.execute_project_task_run.delay')
    def test_prepare_run_allowed_while_in_progress_after_completed_run(self, _delay):
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Continue editing',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )
        ProjectTaskRun.objects.create(
            task_id=created['id'],
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='Draft ready',
        )
        ProjectTask.objects.filter(id=created['id']).update(
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
        )

        prepared = ProjectTaskService(user=self.member).prepare_run(
            project_id=self.project.id,
            task_id=created['id'],
        )

        self.assertEqual(prepared['task']['work_status'], ProjectTask.WorkStatus.IN_PROGRESS)
        self.assertEqual(prepared['run']['status'], ProjectTaskRun.Status.PREPARING)
        self.assertEqual(
            prepared['task']['latest_completed_run']['result_summary'],
            'Draft ready',
        )

    def test_collect_run_result_items_reads_workspace_fk(self):
        source = ContextItem.objects.create(
            workspace=self.member_workspace,
            item_type='tabdoc',
            title='Workspace deliverable',
            resource_id='doc-1',
            created_by=self.member,
            updated_by=self.member,
        )
        run = SimpleNamespace(chat_session_id=uuid4(), workspace_id=self.member_workspace.id)
        message = SimpleNamespace(content_blocks_json=[{
            'kind': 'resource_ref',
            'payload': {'resource_type': 'tabdoc', 'resource_id': 'doc-1'},
        }])

        class AssistantMessages(list):
            def only(self, *_fields):
                return self

            def order_by(self, *_fields):
                return self

        items = collect_run_result_items(run, assistant_messages=AssistantMessages([message]))

        self.assertEqual(items[0]['id'], str(source.id))
        self.assertEqual(items[0]['resource_space_id'], str(self.member_workspace.id))

    def test_collect_run_result_items_reads_org_only_tabdoc(self):
        """#6603：TabDoc ContextItem 挂 Organization 时仍应进入候选交付物。"""
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title='Org-only deliverable',
            resource_id='doc-org-1',
            created_by=self.member,
            updated_by=self.member,
        )
        run = SimpleNamespace(chat_session_id=uuid4(), workspace_id=self.member_workspace.id)
        message = SimpleNamespace(content_blocks_json=[{
            'type': 'tabtin_rich_content',
            'kind': 'resource_ref',
            'payload': {'resource_type': 'doc', 'resource_id': 'doc-org-1'},
        }])

        class AssistantMessages(list):
            def only(self, *_fields):
                return self

            def order_by(self, *_fields):
                return self

        items = collect_run_result_items(run, assistant_messages=AssistantMessages([message]))

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], str(source.id))
        self.assertEqual(items[0]['title'], 'Org-only deliverable')
        # org-only 无 space_id，打开预览回退到执行 Workspace
        self.assertEqual(items[0]['resource_space_id'], str(self.member_workspace.id))

    def test_collect_run_result_items_reads_markdown_resource_links(self):
        """CLI 建文档后常见 markdown 链接，无 resource_ref 块也应入库候选。"""
        source = ContextItem.objects.create(
            workspace=self.member_workspace,
            item_type='tabdoc',
            title='Markdown linked doc',
            resource_id='02eda024-5f11-4d4a-85c2-9a1b3c5d7e90',
            created_by=self.member,
            updated_by=self.member,
        )
        run = SimpleNamespace(chat_session_id=uuid4(), workspace_id=self.member_workspace.id)
        message = SimpleNamespace(content_blocks_json=[{
            'type': 'text',
            'text': (
                '已创建 [Markdown linked doc]'
                '(tabtin://resource/document/02eda024-5f11-4d4a-85c2-9a1b3c5d7e90?hint=tabdoc)'
            ),
        }])

        class AssistantMessages(list):
            def only(self, *_fields):
                return self

            def order_by(self, *_fields):
                return self

        items = collect_run_result_items(run, assistant_messages=AssistantMessages([message]))

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], str(source.id))
        self.assertEqual(items[0]['resource_type'], 'tabdoc')
        self.assertEqual(
            items[0]['resource_id'],
            '02eda024-5f11-4d4a-85c2-9a1b3c5d7e90',
        )

    def test_collect_run_result_items_reads_cli_doc_create_json(self):
        """dogfood：`tabtin doc create --format json` 工具结果无 markdown 链接。"""
        import json

        doc_id = 'a7adaa70-825c-4d04-9155-0f83acc850db'
        source = ContextItem.objects.create(
            workspace=self.member_workspace,
            item_type='tabdoc',
            title='随手记',
            resource_id=doc_id,
            created_by=self.member,
            updated_by=self.member,
        )
        run = SimpleNamespace(chat_session_id=uuid4(), workspace_id=self.member_workspace.id)
        stdout = json.dumps({
            'ok': True,
            'data': {
                'document': {
                    'id': doc_id,
                    'title': '随手记',
                },
            },
        })
        message = SimpleNamespace(content_blocks_json=[{
            'type': 'tool_result',
            'tool_use_id': 'tu-doc-create',
            'content': json.dumps({
                'status': 'completed',
                'exit_code': 0,
                'stdout': stdout,
            }),
        }])

        class AssistantMessages(list):
            def only(self, *_fields):
                return self

            def order_by(self, *_fields):
                return self

        items = collect_run_result_items(run, assistant_messages=AssistantMessages([message]))

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], str(source.id))
        self.assertEqual(items[0]['resource_id'], doc_id)
        self.assertEqual(items[0]['title'], '随手记')

    def test_accept_result_promotes_tabdoc_and_replaces_private_grants(self):
        from apps.tabdoc.models import Document, DocumentPermission, DocumentShare

        task = ProjectTask.objects.create(
            project=self.project,
            title='Publish private document',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_REVIEW,
        )
        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.member_workspace.id,
            owner_id=self.member.id,
            title='Private draft',
            description_json={'type': 'doc', 'content': []},
            description_markdown='# Private draft',
            description_plaintext='Private draft',
            latest_version=1,
            created_by=self.member,
            updated_by=self.member,
        )
        source = ContextItem.objects.create(
            workspace=self.member_workspace,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        DocumentShare.objects.create(
            document=document,
            share_type='public',
            is_active=True,
            created_by=self.member,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type='user',
            subject_id=str(self.owner.id),
            permission='viewer',
            is_active=True,
            created_by=self.member,
            granted_by=str(self.member.id),
        )
        run = ProjectTaskRun.objects.create(
            task=task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='Document ready for review.',
            result_items=[{'id': str(source.id)}],
        )

        ProjectTaskService(user=self.member).accept_result(
            project_id=self.project.id,
            task_id=task.id,
            result_item_ids=[source.id],
        )

        source.refresh_from_db()
        document.refresh_from_db()
        self.assertIsNone(source.workspace_id)
        self.assertEqual(source.project_id, self.project.id)
        self.assertEqual(document.space_id, self.project.id)
        self.assertIsNone(document.owner_id)
        self.assertFalse(DocumentShare.objects.get(document=document).is_active)
        self.assertFalse(DocumentPermission.objects.get(
            document=document,
            subject_type='user',
            subject_id=str(self.owner.id),
        ).is_active)
        self.assertEqual(
            set(DocumentPermission.objects.filter(document=document, is_active=True).values_list('subject_id', flat=True)),
            {'owner', 'admin', 'editor', 'viewer'},
        )
        self.assertEqual(ProjectTaskDeliverable.objects.filter(task=task, task_run=run).count(), 2)

    def test_accept_result_rejects_org_only_tabdoc_without_admin_permission(self):
        from apps.tabdoc.models import Document

        task = ProjectTask.objects.create(
            project=self.project,
            title='Do not publish another member document',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
        )
        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            is_private=True,
            title='Owner private draft',
            description_json={'type': 'doc', 'content': []},
            description_markdown='# Owner private draft',
            description_plaintext='Owner private draft',
            latest_version=1,
            created_by=self.owner,
            updated_by=self.owner,
        )
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.owner,
            updated_by=self.owner,
        )
        ProjectTaskRun.objects.create(
            task=task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='Attempted delivery.',
            result_items=[{'id': str(source.id)}],
        )

        with self.assertRaises(ServiceError) as context:
            ProjectTaskService(user=self.member).accept_result(
                project_id=self.project.id,
                task_id=task.id,
                result_item_ids=[source.id],
            )

        self.assertEqual(context.exception.code, 'TASK_RESULT_DOCUMENT_FORBIDDEN')
        source.refresh_from_db()
        document.refresh_from_db()
        self.assertEqual(source.organization_id, self.organization.id)
        self.assertIsNone(source.project_id)
        self.assertIsNone(document.space_id)
        self.assertEqual(str(document.owner_id), str(self.owner.id))

    def test_safe_failure_message_maps_organization_insufficient_credits(self):
        message = _safe_failure_message(result={
            'error_category': 'organization_insufficient_credits',
            'error_message': (
                '[organization_insufficient_credits] 本月 LLM 点券已用完，'
                '请联系组织管理员充值或开启点券自动补充'
            ),
        })
        self.assertEqual(
            message,
            '组织 LLM 点券已用完，请充值或开启自动补充后重新运行。',
        )
        self.assertNotIn('本月 LLM 点券已用完，请联系组织管理员', message)

    def test_safe_failure_message_parses_bracket_code_when_runtime_failed(self):
        message = _safe_failure_message(result={
            'error_category': 'runtime_failed',
            'reply': (
                '[organization_insufficient_credits] 本月 LLM 点券已用完，'
                '请联系组织管理员充值或开启点券自动补充'
            ),
            'content': '',
        })
        self.assertEqual(
            message,
            '组织 LLM 点券已用完，请充值或开启自动补充后重新运行。',
        )

    @patch('apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync')
    @patch('apps.services.agent_execution.model_resolver.resolve_model')
    def test_runtime_dispatch_keeps_completed_run_in_progress(self, resolve_model, send_message):
        resolve_model.return_value = SimpleNamespace(instance=SimpleNamespace(id=uuid4()))
        send_message.return_value = {
            'reply': 'Release package is ready for human review.',
            'error_category': None,
        }
        task = ProjectTask.objects.create(
            project=self.project,
            title='Runtime bridge',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
            selected_agent=self.member_agent,
            project_member_workspace=self.member_link,
        )
        run = ProjectTaskRun.objects.create(
            task=task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            binding_snapshot={'agent_id': str(self.member_agent.id)},
        )

        execute_project_task_run(str(run.id))

        run.refresh_from_db()
        task.refresh_from_db()
        self.assertEqual(run.status, ProjectTaskRun.Status.COMPLETED)
        self.assertIsNotNone(run.chat_session_id)
        self.assertEqual(run.result_summary, 'Release package is ready for human review.')
        self.assertEqual(task.work_status, ProjectTask.WorkStatus.IN_PROGRESS)
        send_message.assert_called_once()
        app_context = send_message.call_args.kwargs['app_context']
        self.assertEqual(app_context['appType'], 'project_task')
        self.assertEqual(app_context['appMeta'], {
            'project_id': str(self.project.id),
            'task_id': str(task.id),
            'task_run_id': str(run.id),
        })
        self.assertEqual(app_context['spaceId'], str(self.member_workspace.id))

    @patch('apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync')
    @patch('apps.services.agent_execution.model_resolver.resolve_model')
    def test_runtime_credits_failure_keeps_actionable_reason(self, resolve_model, send_message):
        resolve_model.return_value = SimpleNamespace(instance=SimpleNamespace(id=uuid4()))
        send_message.return_value = {
            'reply': (
                '[organization_insufficient_credits] 本月 LLM 点券已用完，'
                '请联系组织管理员充值或开启点券自动补充'
            ),
            'error_category': 'organization_insufficient_credits',
            'error_code': 'organization_insufficient_credits',
        }
        task = ProjectTask.objects.create(
            project=self.project,
            title='Credits failure',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
            selected_agent=self.member_agent,
            project_member_workspace=self.member_link,
        )
        run = ProjectTaskRun.objects.create(
            task=task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            binding_snapshot={'agent_id': str(self.member_agent.id)},
        )

        execute_project_task_run(str(run.id))

        run.refresh_from_db()
        task.refresh_from_db()
        self.assertEqual(run.status, ProjectTaskRun.Status.FAILED)
        self.assertEqual(task.work_status, ProjectTask.WorkStatus.BLOCKED)
        self.assertEqual(
            run.safe_failure_reason,
            '组织 LLM 点券已用完，请充值或开启自动补充后重新运行。',
        )
        self.assertTrue(
            ProjectTaskEvent.objects.filter(
                task=task,
                event_type='run_failed',
                payload__run_id=str(run.id),
            ).exists(),
        )

    @patch('apps.tabtinspace.tasks.execute_project_task_run.delay')
    def test_retry_after_failed_run_creates_new_run_with_rerun_of(self, delay):
        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Retry after credits',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )
        with self.captureOnCommitCallbacks(execute=True):
            first = ProjectTaskService(user=self.member).start_run(
                project_id=self.project.id,
                task_id=created['id'],
            )
        failed_run = ProjectTaskRun.objects.get(id=first['run']['id'])
        failed_run.status = ProjectTaskRun.Status.FAILED
        failed_run.safe_failure_reason = (
            '组织 LLM 点券已用完，请充值或开启自动补充后重新运行。'
        )
        failed_run.save(update_fields=['status', 'safe_failure_reason', 'updated_at'])
        ProjectTask.objects.filter(id=created['id']).update(
            work_status=ProjectTask.WorkStatus.BLOCKED,
        )
        ProjectTaskEvent.objects.create(
            task_id=created['id'],
            actor=self.member,
            actor_name='member',
            event_type='run_failed',
            payload={'run_id': str(failed_run.id)},
        )

        failed_session_id = str(failed_run.chat_session_id)
        gate = evaluate_project_task_chat_send_gate(failed_session_id)
        self.assertIsNotNone(gate)
        self.assertEqual(gate['error_code'], 'project_task_run_required')

        with self.captureOnCommitCallbacks(execute=True):
            second = ProjectTaskService(user=self.member).start_run(
                project_id=self.project.id,
                task_id=created['id'],
            )

        new_run = ProjectTaskRun.objects.get(id=second['run']['id'])
        failed_run.refresh_from_db()
        self.assertEqual(failed_run.status, ProjectTaskRun.Status.FAILED)
        self.assertNotEqual(str(new_run.id), str(failed_run.id))
        self.assertEqual(new_run.rerun_of_id, failed_run.id)
        self.assertEqual(new_run.status, ProjectTaskRun.Status.PENDING)
        self.assertEqual(second['task']['work_status'], ProjectTask.WorkStatus.IN_PROGRESS)
        self.assertNotEqual(str(new_run.chat_session_id), failed_session_id)
        self.assertIsNone(evaluate_project_task_chat_send_gate(str(new_run.chat_session_id)))
        event_types = list(
            ProjectTaskEvent.objects.filter(task_id=created['id'])
            .order_by('created_at', 'id')
            .values_list('event_type', flat=True)
        )
        self.assertIn('run_started', event_types)
        self.assertIn('run_failed', event_types)
        self.assertEqual(event_types.count('run_started'), 2)
        delay.assert_called()

    def test_chat_send_gate_allows_completed_project_task_session(self):
        from apps.chat.conversation.models import ChatContext, ChatSession

        task = ProjectTask.objects.create(
            project=self.project,
            title='Completed continue',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
            selected_agent=self.member_agent,
            project_member_workspace=self.member_link,
        )
        session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='执行',
        )
        run = ProjectTaskRun.objects.create(
            task=task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            chat_session=session,
            result_summary='draft ready',
            binding_snapshot={'agent_id': str(self.member_agent.id)},
        )
        ChatContext.objects.create(
            session=session,
            current_space_id=str(self.project.id),
            context_data={
                '_origin_source': 'project_task',
                '_project_task_id': str(task.id),
                '_project_task_run_id': str(run.id),
            },
        )
        self.assertIsNone(evaluate_project_task_chat_send_gate(str(session.id)))

    def test_chat_send_gate_ignores_normal_chat_sessions(self):
        from apps.chat.conversation.models import ChatContext, ChatSession

        session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='普通聊天',
        )
        ChatContext.objects.create(
            session=session,
            current_space_id=str(self.member_workspace.id),
            context_data={'current_app_type': 'tabdoc'},
        )
        self.assertIsNone(evaluate_project_task_chat_send_gate(str(session.id)))

    def test_serialize_task_lists_all_run_conversations(self):
        from apps.chat.conversation.models import ChatSession

        created = ProjectTaskService(user=self.member).create_task(
            project_id=self.project.id,
            title='Multi conversation task',
            responsible_user_id=self.member.id,
        )
        ProjectTaskService(user=self.member).configure_execution(
            project_id=self.project.id,
            task_id=created['id'],
            agent_id=self.member_agent.id,
            workspace_id=self.member_workspace.id,
        )

        older_session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='[Task] Multi conversation task · run 1',
        )
        older_run = ProjectTaskRun.objects.create(
            task_id=created['id'],
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            chat_session=older_session,
            result_summary='first attempt',
            binding_snapshot={'agent_name': 'Member Agent'},
        )
        newer_session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='[Task] Multi conversation task · run 2',
        )
        newer_run = ProjectTaskRun.objects.create(
            task_id=created['id'],
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.PREPARING,
            rerun_of=older_run,
            chat_session=newer_session,
            binding_snapshot={'agent_name': 'Member Agent'},
        )

        detail = ProjectTaskService(user=self.member).get_task(
            project_id=self.project.id,
            task_id=created['id'],
        )
        listed = ProjectTaskService(user=self.member).list_tasks(project_id=self.project.id)
        listed_task = next(item for item in listed if item['id'] == created['id'])

        self.assertEqual(detail['latest_run']['id'], str(newer_run.id))
        self.assertEqual(len(detail['conversations']), 2)
        self.assertEqual(detail['conversations'][0]['run_id'], str(newer_run.id))
        self.assertEqual(detail['conversations'][0]['kind'], 'preparation')
        self.assertEqual(detail['conversations'][0]['run_status'], 'preparing')
        self.assertTrue(detail['conversations'][0]['is_active'])
        self.assertEqual(detail['conversations'][0]['session_id'], str(newer_session.id))
        self.assertEqual(detail['conversations'][0]['title'], newer_session.title)
        self.assertEqual(detail['conversations'][0]['rerun_of_id'], str(older_run.id))
        self.assertEqual(detail['conversations'][1]['run_id'], str(older_run.id))
        self.assertEqual(detail['conversations'][1]['kind'], 'execution')
        self.assertFalse(detail['conversations'][1]['is_active'])
        self.assertEqual(detail['conversations'][1]['session_id'], str(older_session.id))
        self.assertEqual(len(listed_task['conversations']), 2)

        outsider = ProjectTaskService(user=self.owner).get_task(
            project_id=self.project.id,
            task_id=created['id'],
        )
        self.assertEqual(len(outsider['conversations']), 2)
        self.assertIsNone(outsider['conversations'][0]['session_id'])
        self.assertIsNone(outsider['conversations'][1]['session_id'])
        self.assertEqual(outsider['conversations'][0]['run_id'], str(newer_run.id))
