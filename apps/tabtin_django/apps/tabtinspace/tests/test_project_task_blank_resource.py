"""#8489 Task 6：空白直建 TabDoc/TabData 并挂到当前 Run.result_items。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    ProjectTask,
    ProjectTaskRun,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_task_results import (
    USER_BLANK_ORIGIN,
    merge_result_items_preserving_user_blanks,
)
from apps.tabtinspace.services.project_task_service import ProjectTaskService

User = get_user_model()

_DOC_LIMIT_PATCH = patch(
    'apps.services.billing.services.entitlement_limits_service.'
    'EntitlementLimitsService.check_document_limit',
    return_value={'allowed': True},
)
_QUOTA_PATCH = patch(
    'apps.tabdata.services.table_service.QuotaService',
    MagicMock(return_value=MagicMock(check_quota=MagicMock())),
)
_NATIVE_ENSURE_TABLE_PATCH = patch(
    'apps.tabdata.services.table_service.TableService._native_ensure_table',
    return_value=None,
)


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectTaskBlankResourceTests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        for p in (_DOC_LIMIT_PATCH, _QUOTA_PATCH, _NATIVE_ENSURE_TABLE_PATCH):
            p.start()
            self.addCleanup(p.stop)

        self.owner = User.objects.create_user(
            username='blank-owner',
            email='blank-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='blank-member',
            email='blank-member@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Blank Resource Org',
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
            name='Blank Resource Project',
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
        device = Device.objects.create(
            organization=self.organization,
            user=self.member,
            name='blank-member-device',
            device_type='electron',
            role='control',
            fingerprint='blank-member-device',
            status='online',
        )
        self.member_workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.member,
            name='Project Workspace',
            working_dir='/tmp/blank-member',
            normalized_working_dir='/tmp/blank-member',
        )
        self.member_link = ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.member,
            workspace=self.member_workspace,
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name='Blank Member Agent',
        )
        self.task = ProjectTask.objects.create(
            project=self.project,
            title='Blank resource task',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
            selected_agent=self.member_agent,
            project_member_workspace=self.member_link,
        )
        self.session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='Blank task session',
        )
        self.run = ProjectTaskRun.objects.create(
            task=self.task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='ready',
            result_items=[],
            chat_session=self.session,
            binding_snapshot={'workspace_name': 'Project Workspace'},
        )

    def test_create_blank_tabdoc_appears_in_workbench_resources(self):
        resource = ProjectTaskService(user=self.member).create_blank_task_resource(
            session_id=str(self.session.id),
            resource_type='tabdoc',
            title='Blank Doc',
        )
        self.assertEqual(resource['resource_type'], 'tabdoc')
        self.assertEqual(resource['title'], 'Blank Doc')
        self.assertEqual(resource['source'], 'candidate')
        self.assertTrue(resource['can_open'])
        self.assertTrue(resource['context_item_id'])
        self.assertTrue(resource['resource_id'])

        self.run.refresh_from_db()
        self.assertEqual(len(self.run.result_items), 1)
        self.assertEqual(self.run.result_items[0]['origin'], USER_BLANK_ORIGIN)
        self.assertEqual(self.run.result_items[0]['resource_id'], resource['resource_id'])

        workbench = ProjectTaskService(user=self.member).get_current_task_workbench(
            session_id=str(self.session.id),
        )
        match = next(
            (
                row for row in workbench['resources']
                if row['resource_id'] == resource['resource_id']
            ),
            None,
        )
        self.assertIsNotNone(match)
        self.assertEqual(match['source'], 'candidate')
        self.assertTrue(match['can_open'])

    def test_create_blank_tabdata_appears_in_workbench_resources(self):
        resource = ProjectTaskService(user=self.member).create_blank_task_resource(
            session_id=str(self.session.id),
            resource_type='tabdata',
            title='',
        )
        self.assertEqual(resource['resource_type'], 'tabdata')
        self.assertEqual(resource['source'], 'candidate')
        self.assertTrue(resource['can_open'])
        self.assertIn('未命名', resource['title'])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=self.task.id,
        )
        match = next(
            (
                row for row in workbench['resources']
                if row['resource_id'] == resource['resource_id']
            ),
            None,
        )
        self.assertIsNotNone(match)
        self.assertEqual(match['resource_type'], 'tabdata')

    def test_non_responsible_cannot_create_blank_resource(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.owner).create_blank_task_resource(
                session_id=str(self.session.id),
                resource_type='tabdoc',
            )
        self.assertEqual(ctx.exception.code, 'PERMISSION_DENIED')
        self.assertEqual(ctx.exception.status, 403)

    def test_missing_session_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.member).create_blank_task_resource(
                session_id='',
                resource_type='tabdoc',
            )
        self.assertEqual(ctx.exception.code, 'PROJECT_TASK_SESSION_REQUIRED')
        self.assertEqual(ctx.exception.status, 400)

    def test_non_task_session_rejected(self):
        plain = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='Plain chat',
        )
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.member).create_blank_task_resource(
                session_id=str(plain.id),
                resource_type='tabdoc',
            )
        self.assertEqual(ctx.exception.code, 'PROJECT_TASK_SESSION_REQUIRED')
        self.assertEqual(ctx.exception.status, 400)

    def test_done_task_rejects_blank_create(self):
        self.task.work_status = ProjectTask.WorkStatus.DONE
        self.task.save(update_fields=['work_status', 'updated_at'])
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.member).create_blank_task_resource(
                session_id=str(self.session.id),
                resource_type='tabdoc',
            )
        self.assertEqual(ctx.exception.code, 'TASK_NOT_EDITABLE')
        self.assertEqual(ctx.exception.status, 409)

    def test_merge_preserves_user_blank_when_collect_overwrites(self):
        blank = {
            'id': 'ci-blank',
            'context_item_id': 'ci-blank',
            'resource_type': 'tabdoc',
            'resource_id': 'doc-blank',
            'item_type': 'tabdoc',
            'title': 'User blank',
            'preview': '',
            'resource_space_id': str(self.member_workspace.id),
            'origin': USER_BLANK_ORIGIN,
        }
        agent_item = {
            'id': 'ci-agent',
            'context_item_id': 'ci-agent',
            'resource_type': 'tabdoc',
            'resource_id': 'doc-agent',
            'item_type': 'tabdoc',
            'title': 'Agent delivery',
            'preview': 'from agent',
            'resource_space_id': str(self.member_workspace.id),
        }
        merged = merge_result_items_preserving_user_blanks(
            [blank, {'resource_type': 'tabdoc', 'resource_id': 'old'}],
            [agent_item],
        )
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]['resource_id'], 'doc-agent')
        self.assertEqual(merged[1]['resource_id'], 'doc-blank')
        self.assertEqual(merged[1]['origin'], USER_BLANK_ORIGIN)

        failed = merge_result_items_preserving_user_blanks([blank], [])
        self.assertEqual(failed, [blank])

        # 同 ID 已被 Agent 采集时不再重复保留 blank。
        same = {
            **blank,
            'resource_id': 'doc-agent',
            'id': 'ci-same',
            'context_item_id': 'ci-same',
        }
        deduped = merge_result_items_preserving_user_blanks([same], [agent_item])
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]['resource_id'], 'doc-agent')
        self.assertNotIn('origin', deduped[0])
