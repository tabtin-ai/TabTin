"""#8489 Task 1：get_task_workbench() 的 resources 投影契约。"""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession
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
    ProjectTaskRun,
    ResourceAccess,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_task_service import ProjectTaskService

User = get_user_model()


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectTaskWorkbenchResourcesTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='wb-owner',
            email='wb-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='wb-member',
            email='wb-member@example.com',
            password='pass',
        )
        self.outsider = User.objects.create_user(
            username='wb-outsider',
            email='wb-outsider@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Workbench Org',
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
        self.project = Project.objects.create(
            organization=self.organization,
            name='Workbench Project',
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
        self.other_project = Project.objects.create(
            organization=self.organization,
            name='Sibling Project',
        )
        ProjectMembership.objects.create(
            project=self.other_project,
            user=self.member,
            role='editor',
            status=ProjectMembership.Status.ACTIVE,
            is_active=True,
        )
        self.member_workspace = self._workspace(
            self.member, 'wb-member-device', '/tmp/wb-member',
        )
        self.member_link = ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.member,
            workspace=self.member_workspace,
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name='Member Agent',
        )

    def _workspace(self, user, fingerprint: str, path: str, *, organization=None) -> Workspace:
        organization = organization or self.organization
        device = Device.objects.create(
            organization=organization,
            user=user,
            name=fingerprint,
            device_type='electron',
            role='control',
            fingerprint=fingerprint,
            status='online',
        )
        return Workspace.objects.create(
            organization=organization,
            device=device,
            created_by=user,
            name='Project Workspace',
            working_dir=path,
            normalized_working_dir=path,
        )

    def _create_task(self, *, responsible=None, project=None, title='Task resources') -> ProjectTask:
        responsible = responsible or self.member
        project = project or self.project
        return ProjectTask.objects.create(
            project=project,
            title=title,
            created_by=responsible,
            responsible_user=responsible,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_PROGRESS,
            selected_agent=self.member_agent,
            project_member_workspace=(
                self.member_link if project.id == self.project.id else None
            ),
        )

    def _create_run(self, task: ProjectTask, *, result_items=None, chat_session=None) -> ProjectTaskRun:
        return ProjectTaskRun.objects.create(
            task=task,
            responsible_user=task.responsible_user,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='ready',
            result_items=result_items or [],
            chat_session=chat_session,
            binding_snapshot={'workspace_name': 'Project Workspace'},
        )

    def _create_document(self, *, owner, title='Doc', organization=None, space_id=None):
        from apps.tabdoc.models import Document

        return Document.objects.create(
            organization_id=(organization or self.organization).id,
            space_id=space_id,
            owner_id=owner.id,
            title=title,
            description_json={'type': 'doc', 'content': []},
            description_markdown=f'# {title}',
            description_plaintext=title,
            latest_version=1,
            created_by=owner,
            updated_by=owner,
        )

    def test_org_only_candidate_enters_resources_for_responsible(self):
        task = self._create_task()
        document = self._create_document(owner=self.member, title='Org only draft')
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            preview='draft preview',
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        run = self._create_run(task, result_items=[{
            'id': str(source.id),
            'context_item_id': str(source.id),
            'resource_type': 'tabdoc',
            'resource_id': str(document.id),
            'item_type': 'tabdoc',
            'title': source.title,
            'preview': source.preview,
            'resource_space_id': str(self.member_workspace.id),
        }])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )

        self.assertIn('resources', workbench)
        self.assertEqual(len(workbench['resources']), 1)
        resource = workbench['resources'][0]
        self.assertEqual(resource['context_item_id'], str(source.id))
        self.assertEqual(resource['resource_type'], 'tabdoc')
        self.assertEqual(resource['resource_id'], str(document.id))
        self.assertEqual(resource['source'], 'candidate')
        self.assertEqual(resource['task_run_id'], str(run.id))
        self.assertTrue(resource['is_primary'])
        self.assertTrue(resource['can_open'])
        self.assertEqual(resource['organization_id'], str(self.organization.id))
        self.assertEqual(resource['resource_space_id'], str(self.member_workspace.id))
        self.assertEqual(workbench['primary_artifact']['resource_id'], str(document.id))
        self.assertEqual(workbench['run']['artifacts'][0]['resource_id'], str(document.id))

    def test_candidate_without_resolvable_context_item_is_dropped(self):
        """无 ContextItem（缺 id 或库中不存在）的 candidate 不得进入 resources。"""
        from uuid import uuid4

        task = self._create_task()
        document = self._create_document(owner=self.member, title='Resolvable doc')
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            preview='ok',
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        orphan_resource_id = str(uuid4())
        missing_item_id = str(uuid4())
        self._create_run(task, result_items=[
            {
                # 有 resource 身份但无 context_item_id / id
                'resource_type': 'tabdoc',
                'resource_id': orphan_resource_id,
                'title': 'Orphan without ContextItem',
            },
            {
                # 指向库中不存在的 ContextItem
                'id': missing_item_id,
                'context_item_id': missing_item_id,
                'resource_type': 'tabdoc',
                'resource_id': str(uuid4()),
                'title': 'Missing ContextItem',
            },
            {
                'id': str(source.id),
                'context_item_id': str(source.id),
                'resource_type': 'tabdoc',
                'resource_id': str(document.id),
                'title': source.title,
            },
        ])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )

        resources = workbench['resources']
        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]['context_item_id'], str(source.id))
        self.assertEqual(resources[0]['resource_id'], str(document.id))
        resource_ids = {item['resource_id'] for item in resources}
        self.assertNotIn(orphan_resource_id, resource_ids)
        for resource in resources:
            self.assertIsNotNone(resource.get('context_item_id'))

    def test_other_task_and_other_org_resources_do_not_mix(self):
        task = self._create_task(title='Current task')
        document = self._create_document(owner=self.member, title='Current doc')
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(task, result_items=[{
            'id': str(source.id),
            'resource_type': 'tabdoc',
            'resource_id': str(document.id),
            'title': source.title,
        }])

        other_task = self._create_task(title='Other task', project=self.other_project)
        other_doc = self._create_document(owner=self.member, title='Other task doc')
        other_item = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=other_doc.title,
            resource_id=str(other_doc.id),
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(other_task, result_items=[{
            'id': str(other_item.id),
            'resource_type': 'tabdoc',
            'resource_id': str(other_doc.id),
            'title': other_item.title,
        }])
        ProjectTaskDeliverable.objects.create(
            task=other_task,
            task_run=ProjectTaskRun.objects.filter(task=other_task).first(),
            context_item=other_item,
            published_by=self.member,
        )

        foreign_doc = self._create_document(
            owner=self.outsider,
            title='Foreign org',
            organization=self.other_org,
        )
        foreign_item = ContextItem.objects.create(
            organization=self.other_org,
            item_type='tabdoc',
            title=foreign_doc.title,
            resource_id=str(foreign_doc.id),
            created_by=self.outsider,
            updated_by=self.outsider,
        )
        # 故意把外组织资源塞进 result_items 快照，投影不得因为标题/组织列表而采纳。
        run = ProjectTaskRun.objects.get(task=task)
        run.result_items = list(run.result_items) + [{
            'id': str(foreign_item.id),
            'resource_type': 'tabdoc',
            'resource_id': str(foreign_doc.id),
            'title': foreign_item.title,
        }]
        run.save(update_fields=['result_items', 'updated_at'])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        resource_ids = {item['resource_id'] for item in workbench['resources']}
        self.assertEqual(resource_ids, {str(document.id)})
        self.assertNotIn(str(other_doc.id), resource_ids)
        self.assertNotIn(str(foreign_doc.id), resource_ids)

    def test_candidate_hidden_from_non_responsible_member(self):
        task = self._create_task()
        document = self._create_document(owner=self.member, title='Private candidate')
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(task, result_items=[{
            'id': str(source.id),
            'resource_type': 'tabdoc',
            'resource_id': str(document.id),
            'title': source.title,
        }])

        as_owner = ProjectTaskService(user=self.owner).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        self.assertEqual(as_owner['resources'], [])
        self.assertNotIn('run', as_owner)
        self.assertNotIn('primary_artifact', as_owner)
        self.assertIn('deliverables', as_owner)

    def test_published_deliverable_visible_to_project_member(self):
        task = self._create_task()
        document = self._create_document(
            owner=self.member,
            title='Published doc',
            space_id=self.project.id,
        )
        document.owner_id = None
        document.is_private = False
        document.save(update_fields=['owner_id', 'is_private', 'updated_at'])
        from apps.tabdoc.models import DocumentPermission

        for role, permission in (
            ('owner', 'admin'),
            ('admin', 'admin'),
            ('editor', 'editor'),
            ('viewer', 'viewer'),
        ):
            DocumentPermission.objects.create(
                document=document,
                subject_type='role',
                subject_id=role,
                permission=permission,
                is_active=True,
                created_by=self.member,
                granted_by=str(self.member.id),
            )
        item = ContextItem.objects.create(
            project=self.project,
            item_type='tabdoc',
            title=document.title,
            preview='published preview',
            resource_id=str(document.id),
            metadata={'asset_kind': 'tabdoc'},
            created_by=self.member,
            updated_by=self.member,
        )
        run = self._create_run(task, result_items=[])
        ProjectTaskDeliverable.objects.create(
            task=task,
            task_run=run,
            context_item=item,
            published_by=self.member,
        )

        workbench = ProjectTaskService(user=self.owner).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        self.assertEqual(len(workbench['resources']), 1)
        resource = workbench['resources'][0]
        self.assertEqual(resource['source'], 'deliverable')
        self.assertEqual(resource['resource_id'], str(document.id))
        self.assertTrue(resource['can_open'])
        self.assertEqual(resource['preview'], 'published preview')

    def test_candidate_and_deliverable_dedupe_prefers_deliverable(self):
        task = self._create_task()
        document = self._create_document(
            owner=self.member,
            title='Same identity',
            space_id=self.project.id,
        )
        document.owner_id = None
        document.is_private = False
        document.save(update_fields=['owner_id', 'is_private', 'updated_at'])
        from apps.tabdoc.models import DocumentPermission

        DocumentPermission.objects.create(
            document=document,
            subject_type='role',
            subject_id='editor',
            permission='editor',
            is_active=True,
            created_by=self.member,
            granted_by=str(self.member.id),
        )
        item = ContextItem.objects.create(
            project=self.project,
            item_type='tabdoc',
            title=document.title,
            preview='deliverable preview',
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        run = self._create_run(task, result_items=[{
            'id': str(item.id),
            'resource_type': 'doc',
            'resource_id': str(document.id),
            'title': 'candidate title',
            'preview': 'candidate preview',
        }])
        ProjectTaskDeliverable.objects.create(
            task=task,
            task_run=run,
            context_item=item,
            published_by=self.member,
        )

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        self.assertEqual(len(workbench['resources']), 1)
        resource = workbench['resources'][0]
        self.assertEqual(resource['source'], 'deliverable')
        self.assertEqual(resource['resource_type'], 'tabdoc')
        self.assertEqual(resource['preview'], 'deliverable preview')
        self.assertTrue(resource['is_primary'])

    def test_last_visited_at_is_per_user(self):
        task = self._create_task()
        document = self._create_document(
            owner=self.member,
            title='Visited',
            space_id=self.project.id,
        )
        document.owner_id = None
        document.is_private = False
        document.save(update_fields=['owner_id', 'is_private', 'updated_at'])
        from apps.tabdoc.models import DocumentPermission

        for role in ('owner', 'editor'):
            DocumentPermission.objects.create(
                document=document,
                subject_type='role',
                subject_id=role,
                permission='editor',
                is_active=True,
                created_by=self.member,
                granted_by=str(self.member.id),
            )
        item = ContextItem.objects.create(
            project=self.project,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        run = self._create_run(task)
        ProjectTaskDeliverable.objects.create(
            task=task,
            task_run=run,
            context_item=item,
            published_by=self.member,
        )
        member_visited = timezone.now() - timedelta(hours=1)
        owner_visited = timezone.now() - timedelta(hours=2)
        ResourceAccess.objects.create(
            user=self.member,
            context_item=item,
            last_visited_at=member_visited,
        )
        ResourceAccess.objects.create(
            user=self.owner,
            context_item=item,
            last_visited_at=owner_visited,
        )

        as_member = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        as_owner = ProjectTaskService(user=self.owner).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        self.assertEqual(
            as_member['resources'][0]['last_visited_at'],
            member_visited.isoformat(),
        )
        self.assertEqual(
            as_owner['resources'][0]['last_visited_at'],
            owner_visited.isoformat(),
        )

    def test_archived_and_trashed_resources_are_not_openable(self):
        task = self._create_task()
        live_doc = self._create_document(owner=self.member, title='Live')
        archived_doc = self._create_document(owner=self.member, title='Archived')
        trashed_doc = self._create_document(owner=self.member, title='Trashed')
        live = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=live_doc.title,
            resource_id=str(live_doc.id),
            created_by=self.member,
            updated_by=self.member,
        )
        archived = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=archived_doc.title,
            resource_id=str(archived_doc.id),
            is_archived=True,
            created_by=self.member,
            updated_by=self.member,
        )
        trashed = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=trashed_doc.title,
            resource_id=str(trashed_doc.id),
            trashed_at=timezone.now(),
            status='trashed',
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(task, result_items=[
            {
                'id': str(live.id),
                'resource_type': 'tabdoc',
                'resource_id': str(live_doc.id),
                'title': live.title,
            },
            {
                'id': str(archived.id),
                'resource_type': 'tabdoc',
                'resource_id': str(archived_doc.id),
                'title': archived.title,
            },
            {
                'id': str(trashed.id),
                'resource_type': 'tabdoc',
                'resource_id': str(trashed_doc.id),
                'title': trashed.title,
            },
        ])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        by_id = {item['resource_id']: item for item in workbench['resources']}
        self.assertTrue(by_id[str(live_doc.id)]['can_open'])
        self.assertFalse(by_id[str(archived_doc.id)]['can_open'])
        self.assertFalse(by_id[str(trashed_doc.id)]['can_open'])

    def test_tabdata_summary_is_whitelisted(self):
        task = self._create_task()
        table_id = str(uuid4())
        item = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdata',
            title='Sales',
            preview='table preview',
            resource_id=table_id,
            metadata={
                'record_count': 12,
                'field_count': 3,
                'field_names': ['Name', 'Amount', 'Status'],
                'visibility': 'private',
                'secret_token': 'must-not-leak',
            },
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(task, result_items=[{
            'id': str(item.id),
            'resource_type': 'table',
            'resource_id': table_id,
            'title': item.title,
            'preview': item.preview,
        }])

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        resource = workbench['resources'][0]
        self.assertEqual(resource['resource_type'], 'tabdata')
        self.assertEqual(resource['summary'], {
            'record_count': 12,
            'field_count': 3,
            'field_names': ['Name', 'Amount', 'Status'],
        })
        self.assertNotIn('secret_token', resource['summary'])
        self.assertNotIn('visibility', resource['summary'])

    def test_current_session_cannot_read_other_member_task(self):
        task = self._create_task()
        session = ChatSession.objects.create(
            user=self.member,
            organization_id=str(self.organization.id),
            workspace=self.member_workspace,
            agent=self.member_agent,
            title='Member task session',
        )
        self._create_run(task, chat_session=session, result_items=[])

        with self.assertRaises(ServiceError) as ctx:
            ProjectTaskService(user=self.owner).get_current_task_workbench(
                session_id=str(session.id),
            )
        self.assertEqual(ctx.exception.code, 'PERMISSION_DENIED')

        own = ProjectTaskService(user=self.member).get_current_task_workbench(
            session_id=str(session.id),
        )
        self.assertIn('resources', own)
        self.assertEqual(own['task']['id'], str(task.id))
        self.assertIn('deliverables', own)
        self.assertIn('run', own)

    def test_cli_workbench_fields_remain_intact(self):
        task = self._create_task()
        document = self._create_document(owner=self.member, title='CLI intact')
        source = ContextItem.objects.create(
            organization=self.organization,
            item_type='tabdoc',
            title=document.title,
            resource_id=str(document.id),
            created_by=self.member,
            updated_by=self.member,
        )
        self._create_run(task, result_items=[{
            'id': str(source.id),
            'resource_type': 'tabdoc',
            'resource_id': str(document.id),
            'title': source.title,
            'item_type': 'tabdoc',
            'preview': 'x',
            'resource_space_id': str(self.member_workspace.id),
        }])
        envelope = ContextItem.objects.create(
            project=self.project,
            item_type='team_asset',
            title='Delivery envelope',
            resource_id=f'project_task_run:{uuid4()}',
            created_by=self.member,
            updated_by=self.member,
        )
        ProjectTaskDeliverable.objects.create(
            task=task,
            task_run=ProjectTaskRun.objects.get(task=task),
            context_item=envelope,
            published_by=self.member,
        )

        workbench = ProjectTaskService(user=self.member).get_task_workbench(
            project_id=self.project.id,
            task_id=task.id,
        )
        self.assertEqual(workbench['run']['artifacts'][0]['resource_id'], str(document.id))
        self.assertEqual(workbench['primary_artifact']['resource_id'], str(document.id))
        self.assertEqual(len(workbench['deliverables']), 1)
        self.assertEqual(workbench['deliverables'][0]['title'], 'Delivery envelope')
        self.assertGreaterEqual(len(workbench['resources']), 2)
