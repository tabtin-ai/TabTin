"""#6842 Project Task 用户级失效广播契约。

锁定：
1. create / assign 响应 / comment / visibility / done 等 commit 后向 active 成员
   ``publish_to_user``；
2. envelope type 为完整 ``agent.user.project_task_invalidated``；
3. payload 仅含 project_id / task_id / event_type / version（无私有正文）。
"""

from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.agent.models import Agent
from apps.services.common.agent_protocol.constants import AgentUserEvent
from apps.services.common.agent_protocol.namespace import user_event_type
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
from apps.tabtinspace.services.project_task_runtime import _finish_run
from apps.tabtinspace.services.project_task_service import ProjectTaskService

User = get_user_model()

ALLOWED_PAYLOAD_KEYS = frozenset({'project_id', 'task_id', 'event_type', 'version'})


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectTaskInvalidationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='inv-owner',
            email='inv-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='inv-member',
            email='inv-member@example.com',
            password='pass',
        )
        self.outsider = User.objects.create_user(
            username='inv-outsider',
            email='inv-outsider@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Inv Team',
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
            name='Realtime',
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
        self.member_workspace = self._workspace(self.member, 'inv-member-device', '/tmp/inv-member')
        ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.member,
            workspace=self.member_workspace,
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
            control_status='active',
        )
        return Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=user,
            name='Project Workspace',
            working_dir=path,
            normalized_working_dir=path,
        )

    def _assert_invalidation_calls(self, mock_pub, *, event_type: str, task_id: str, version: int):
        self.assertGreaterEqual(mock_pub.call_count, 2)
        recipients = {call.args[0] for call in mock_pub.call_args_list}
        self.assertEqual(recipients, {str(self.owner.id), str(self.member.id)})
        self.assertNotIn(str(self.outsider.id), recipients)

        for call in mock_pub.call_args_list:
            envelope = call.args[1]
            self.assertEqual(
                envelope['type'],
                user_event_type(AgentUserEvent.PROJECT_TASK_INVALIDATED),
            )
            payload = envelope['payload']
            self.assertEqual(set(payload.keys()), ALLOWED_PAYLOAD_KEYS)
            self.assertEqual(payload['project_id'], str(self.project.id))
            self.assertEqual(payload['task_id'], str(task_id))
            self.assertEqual(payload['event_type'], event_type)
            self.assertEqual(payload['version'], version)
            for forbidden in (
                'title', 'description', 'session_id', 'chat_session_id',
                'content', 'result_summary',
            ):
                self.assertNotIn(forbidden, payload)

    def test_create_task_broadcasts_to_active_members(self):
        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                payload = ProjectTaskService(user=self.owner).create_task(
                    project_id=self.project.id,
                    title='跨端同步',
                    description='私有正文不应进 payload',
                    responsible_user_id=self.member.id,
                )
            self._assert_invalidation_calls(
                bus_pub,
                event_type='created',
                task_id=payload['id'],
                version=payload['version'],
            )

    def test_accept_assignment_broadcasts(self):
        with self.captureOnCommitCallbacks(execute=True):
            created = ProjectTaskService(user=self.owner).create_task(
                project_id=self.project.id,
                title='待接单',
                responsible_user_id=self.member.id,
            )
        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                accepted = ProjectTaskService(user=self.member).respond_assignment(
                    project_id=self.project.id,
                    task_id=created['id'],
                    accept=True,
                )
            self._assert_invalidation_calls(
                bus_pub,
                event_type='assignment_accepted',
                task_id=accepted['id'],
                version=accepted['version'],
            )

    def test_comment_broadcasts_without_content(self):
        with self.captureOnCommitCallbacks(execute=True):
            created = ProjectTaskService(user=self.owner).create_task(
                project_id=self.project.id,
                title='评论同步',
                responsible_user_id=self.owner.id,
            )
        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                commented = ProjectTaskService(user=self.member).add_comment(
                    project_id=self.project.id,
                    task_id=created['id'],
                    content='这段私有评论不能进 WS payload',
                )
            self._assert_invalidation_calls(
                bus_pub,
                event_type='comment',
                task_id=commented['id'],
                version=commented['version'],
            )

    def test_result_visibility_and_done_broadcast(self):
        with self.captureOnCommitCallbacks(execute=True):
            created = ProjectTaskService(user=self.member).create_task(
                project_id=self.project.id,
                title='完成同步',
                responsible_user_id=self.member.id,
            )
            ProjectTaskService(user=self.member).configure_execution(
                project_id=self.project.id,
                task_id=created['id'],
                agent_id=self.member_agent.id,
                workspace_id=self.member_workspace.id,
            )
        task = ProjectTask.objects.get(id=created['id'])
        run = ProjectTaskRun.objects.create(
            task=task,
            status=ProjectTaskRun.Status.COMPLETED,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            result_summary='完成摘要',
            result_items=[],
        )
        task.work_status = ProjectTask.WorkStatus.IN_PROGRESS
        task.save(update_fields=['work_status', 'updated_at'])

        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                preview = ProjectTaskService(user=self.member).set_result_visibility(
                    project_id=self.project.id,
                    task_id=created['id'],
                    result_visibility=ProjectTask.ResultVisibility.PROJECT_PREVIEW,
                )
            self._assert_invalidation_calls(
                bus_pub,
                event_type='result_visibility_changed',
                task_id=preview['id'],
                version=preview['version'],
            )

        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                done = ProjectTaskService(user=self.member).accept_result(
                    project_id=self.project.id,
                    task_id=created['id'],
                    result_summary='对外交付摘要',
                )
            self._assert_invalidation_calls(
                bus_pub,
                event_type='result_accepted',
                task_id=done['id'],
                version=done['version'],
            )
        self.assertTrue(ProjectTaskRun.objects.filter(id=run.id).exists())

    def test_finish_run_broadcasts_completed(self):
        with self.captureOnCommitCallbacks(execute=True):
            created = ProjectTaskService(user=self.member).create_task(
                project_id=self.project.id,
                title='Run 完成',
                responsible_user_id=self.member.id,
            )
            ProjectTaskService(user=self.member).configure_execution(
                project_id=self.project.id,
                task_id=created['id'],
                agent_id=self.member_agent.id,
                workspace_id=self.member_workspace.id,
            )
        task = ProjectTask.objects.get(id=created['id'])
        task.work_status = ProjectTask.WorkStatus.IN_PROGRESS
        task.save(update_fields=['work_status', 'updated_at'])
        run = ProjectTaskRun.objects.create(
            task=task,
            status=ProjectTaskRun.Status.RUNNING,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
        )

        with patch('apps.services.common.ws.bus.publish_to_user') as bus_pub:
            with self.captureOnCommitCallbacks(execute=True):
                _finish_run(str(run.id), success=True, summary='ok')
            task.refresh_from_db()
            self._assert_invalidation_calls(
                bus_pub,
                event_type='run_completed',
                task_id=str(task.id),
                version=task.version,
            )
