from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.agent.models import Agent
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.document_service import DocumentService
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
from apps.tabtinspace.services.project_task_preview_access import (
    user_can_preview_project_task_document,
)

User = get_user_model()


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectTaskPreviewAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username='preview-owner',
            email='preview-owner@example.com',
            password='pass',
        )
        self.member = User.objects.create_user(
            username='preview-member',
            email='preview-member@example.com',
            password='pass',
        )
        self.outsider = User.objects.create_user(
            username='preview-outsider',
            email='preview-outsider@example.com',
            password='pass',
        )
        self.organization = Organization.objects.create(
            name='Preview Team',
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
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.outsider,
            role='editor',
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name='Preview Project',
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
        self.member_workspace = self._workspace(self.member, 'preview-device', '/tmp/preview-member')
        self.member_link = ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.member,
            workspace=self.member_workspace,
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name='Preview Member Agent',
        )
        self.document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.member_workspace.id,
            owner_id=self.member.id,
            created_by=self.member,
            updated_by=self.member,
            title='Candidate Handbook',
            description_markdown='body',
            description_plaintext='body',
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=self.document,
            subject_type='user',
            subject_id=str(self.member.id),
            permission='owner',
            is_active=True,
            granted_by=str(self.member.id),
            created_by=self.member,
        )
        self.task = ProjectTask.objects.create(
            project=self.project,
            title='Write handbook',
            created_by=self.member,
            responsible_user=self.member,
            assignment_status=ProjectTask.AssignmentStatus.ACCEPTED,
            work_status=ProjectTask.WorkStatus.IN_REVIEW,
            result_visibility=ProjectTask.ResultVisibility.PROJECT_PREVIEW,
            project_member_workspace=self.member_link,
        )
        ProjectTaskRun.objects.create(
            task=self.task,
            responsible_user=self.member,
            agent=self.member_agent,
            workspace=self.member_workspace,
            device=self.member_workspace.device,
            status=ProjectTaskRun.Status.COMPLETED,
            result_summary='ready for review',
            result_items=[{
                'id': 'item-1',
                'title': 'Candidate Handbook',
                'resource_type': 'tabdoc',
                'resource_id': str(self.document.id),
                'resource_space_id': str(self.member_workspace.id),
            }],
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

    def test_project_member_can_viewer_preview_candidate_document(self):
        self.assertTrue(
            user_can_preview_project_task_document(self.owner, self.document),
        )
        service = DocumentService(user=self.owner)
        self.assertTrue(service.check_document_permission(self.document, 'viewer'))
        self.assertFalse(service.check_document_permission(self.document, 'editor'))
        self.assertEqual(service.compute_user_document_role(self.document), 'viewer')

    def test_outsider_denied_preview(self):
        """非 Project 成员即便任务未完成也不得预览候选文档。"""
        self.assertFalse(
            user_can_preview_project_task_document(self.outsider, self.document),
        )
        self.assertFalse(
            DocumentService(user=self.outsider).check_document_permission(
                self.document,
                'viewer',
            ),
        )

    def test_private_visibility_still_allows_member_preview(self):
        """#7261：result_visibility=private 不再拦住成员读未完成任务的候选文档。"""
        self.task.result_visibility = ProjectTask.ResultVisibility.PRIVATE
        self.task.save(update_fields=['result_visibility', 'updated_at'])
        self.assertTrue(
            user_can_preview_project_task_document(self.owner, self.document),
        )
        service = DocumentService(user=self.owner)
        self.assertTrue(service.check_document_permission(self.document, 'viewer'))
        self.assertFalse(service.check_document_permission(self.document, 'editor'))
        self.assertEqual(service.compute_user_document_role(self.document), 'viewer')

    def test_done_task_does_not_use_preview_grant(self):
        self.task.work_status = ProjectTask.WorkStatus.DONE
        self.task.save(update_fields=['work_status', 'updated_at'])
        self.assertFalse(
            user_can_preview_project_task_document(self.owner, self.document),
        )
        self.assertFalse(
            DocumentService(user=self.owner).check_document_permission(
                self.document,
                'viewer',
            ),
        )
