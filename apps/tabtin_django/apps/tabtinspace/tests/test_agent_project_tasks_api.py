from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.agent.models import Agent
from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    ProjectTask,
)
from apps.tabtinspace.routers.project import list_agent_project_tasks
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_task_service import ProjectTaskService

User = get_user_model()


def _request(user, *, get: dict[str, str] | None = None):
    return SimpleNamespace(
        auth=user,
        method='GET',
        META={'REMOTE_ADDR': '127.0.0.1', 'HTTP_USER_AGENT': 'test'},
        GET=get or {},
    )


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class AgentProjectTasksApiTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='agent-task-owner',
            email='agent-task-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='agent-task-member',
            email='agent-task-member@example.com',
            password='pass',
        )
        self.outsider = User.objects.create_user(
            username='agent-task-outsider',
            email='agent-task-outsider@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Agent Task Team',
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
        self.other_org = Organization.objects.create(
            name='Other Org',
            owner=self.outsider,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.other_org,
            user=self.outsider,
            role='owner',
        )

        self.project_a = Project.objects.create(
            organization=self.organization,
            name='Alpha',
        )
        self.project_b = Project.objects.create(
            organization=self.organization,
            name='Beta',
        )
        self.hidden_project = Project.objects.create(
            organization=self.organization,
            name='Hidden',
        )
        for project, user, role in (
            (self.project_a, self.owner, 'owner'),
            (self.project_b, self.member, 'editor'),
        ):
            ProjectMembership.objects.create(
                project=project,
                user=user,
                role=role,
                status=ProjectMembership.Status.ACTIVE,
                is_active=True,
            )
        ProjectMembership.objects.create(
            project=self.hidden_project,
            user=self.owner,
            role='owner',
            status=ProjectMembership.Status.ACTIVE,
            is_active=True,
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
        self.other_org_agent = Agent.objects.create(
            organization=self.other_org,
            owner_user=self.outsider,
            name='Outsider Agent',
        )

        self.task_a = ProjectTask.objects.create(
            project=self.project_a,
            title='Owner task on Alpha',
            created_by=self.owner,
            responsible_user=self.owner,
            selected_agent=self.owner_agent,
        )
        self.task_b = ProjectTask.objects.create(
            project=self.project_b,
            title='Member task on Beta',
            created_by=self.member,
            responsible_user=self.member,
            selected_agent=self.member_agent,
        )
        self.hidden_task = ProjectTask.objects.create(
            project=self.hidden_project,
            title='Hidden project task',
            created_by=self.owner,
            responsible_user=self.owner,
            selected_agent=self.owner_agent,
        )

    def test_list_tasks_for_agent_returns_cross_project_tasks_with_metadata(self):
        result = ProjectTaskService(user=self.owner).list_tasks_for_agent(
            organization_id=self.organization.id,
            agent_id=self.owner_agent.id,
            limit=20,
        )

        self.assertFalse(result['has_more'])
        self.assertIsNone(result['next_cursor'])
        task_ids = {item['id'] for item in result['tasks']}
        self.assertEqual(task_ids, {str(self.task_a.id), str(self.hidden_task.id)})
        alpha = next(item for item in result['tasks'] if item['id'] == str(self.task_a.id))
        self.assertEqual(alpha['project'], {'id': str(self.project_a.id), 'name': 'Alpha'})
        self.assertEqual(alpha['selected_agent']['id'], str(self.owner_agent.id))
        self.assertIn('latest_run', alpha)

    def test_member_only_sees_tasks_in_joined_projects(self):
        result = ProjectTaskService(user=self.member).list_tasks_for_agent(
            organization_id=self.organization.id,
            agent_id=self.member_agent.id,
        )

        self.assertEqual(len(result['tasks']), 1)
        self.assertEqual(result['tasks'][0]['id'], str(self.task_b.id))
        self.assertEqual(result['tasks'][0]['project']['name'], 'Beta')

    def test_outsider_is_denied(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.outsider).list_tasks_for_agent(
                organization_id=self.organization.id,
                agent_id=self.owner_agent.id,
            )
        self.assertEqual(ctx.exception.code, 'PERMISSION_DENIED')
        self.assertEqual(ctx.exception.status, 403)

    def test_agent_from_other_org_returns_not_found(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.owner).list_tasks_for_agent(
                organization_id=self.organization.id,
                agent_id=self.other_org_agent.id,
            )
        self.assertEqual(ctx.exception.code, 'AGENT_NOT_FOUND')
        self.assertEqual(ctx.exception.status, 404)

    def test_cursor_pagination(self):
        service = ProjectTaskService(user=self.owner)
        first_page = service.list_tasks_for_agent(
            organization_id=self.organization.id,
            agent_id=self.owner_agent.id,
            limit=1,
        )
        self.assertTrue(first_page['has_more'])
        self.assertIsNotNone(first_page['next_cursor'])

        second_page = service.list_tasks_for_agent(
            organization_id=self.organization.id,
            agent_id=self.owner_agent.id,
            limit=1,
            cursor=first_page['next_cursor'],
        )
        self.assertFalse(second_page['has_more'])
        self.assertEqual(len(second_page['tasks']), 1)
        self.assertNotEqual(
            first_page['tasks'][0]['id'],
            second_page['tasks'][0]['id'],
        )

    def test_invalid_cursor_is_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.owner).list_tasks_for_agent(
                organization_id=self.organization.id,
                agent_id=self.owner_agent.id,
                cursor=str(uuid4()),
            )
        self.assertEqual(ctx.exception.code, 'TASK_CURSOR_INVALID')

    def test_route_returns_success_payload(self):
        response = list_agent_project_tasks(
            _request(self.owner, get={'limit': '20'}),
            organization_id=self.organization.id,
            agent_id=self.owner_agent.id,
        )

        self.assertTrue(response['success'])
        self.assertEqual(len(response['data']['tasks']), 2)

    def test_route_rejects_invalid_limit(self):
        response = list_agent_project_tasks(
            _request(self.owner, get={'limit': '0'}),
            organization_id=self.organization.id,
            agent_id=self.owner_agent.id,
        )

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content.decode('utf-8'))
        self.assertFalse(body['success'])
        self.assertEqual(body['code'], 'INVALID_LIMIT')
