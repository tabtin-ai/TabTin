"""#6903：Workspace 自有规则，以及模板长人设与简短出厂规则的边界。"""

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.common.agent_governance_resolver import (
    compact_execution_limits,
    resolve_execution_limits,
)
from apps.services.common.agent_template_registry import (
    get_agent_template,
    list_agent_templates,
)
from apps.tabtinspace.models import Device, Organization, OrganizationMember, Workspace
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.services.workspace_service import WorkspaceService, serialize_workspace
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class WorkspaceRulesAndLimitsTests(TestCase):
    databases = {'default'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(receiver=create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(receiver=create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username='ws_rules_owner',
            email='ws-rules@test.com',
            password='testpass123',
        )
        self.org = Organization.objects.create(
            name='Rules Org', owner_id=self.user.id, is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.org, user=self.user, role='owner',
        )
        self.device = Device.objects.create(
            organization=self.org,
            user=self.user,
            name='Mac',
            device_type='electron',
            role='control',
            fingerprint='ws-rules-fp-001',
            status='online',
        )
        self.ws_svc = WorkspaceService(user=self.user)
        self.agent_svc = AgentService(user=self.user)

    def test_update_and_serialize_workspace_rules_and_limits(self):
        workspace = self.ws_svc.create_workspace(
            organization_id=self.org.id,
            device_id=self.device.id,
            working_dir='/Users/me/proj-rules',
            working_dir_type='code',
            name='Rules WS',
        )
        updated = self.ws_svc.update_workspace(
            workspace.id,
            custom_rules='本仓库禁止 force push',
            execution_limits={
                'max_iterations_per_run': 88,
                'max_credits_per_run': '12.5',
            },
            execution_limits_provided=True,
        )
        self.assertEqual(updated.custom_rules, '本仓库禁止 force push')
        self.assertEqual(updated.execution_limits['max_iterations_per_run'], 88)
        payload = serialize_workspace(updated)
        self.assertEqual(payload['custom_rules'], '本仓库禁止 force push')
        self.assertEqual(payload['execution_limits']['max_iterations_per_run'], 88)

    def test_update_and_serialize_workspace_description(self):
        workspace = self.ws_svc.create_workspace(
            organization_id=self.org.id,
            device_id=self.device.id,
            working_dir='/Users/me/proj-description',
            working_dir_type='code',
            name='Description WS',
        )

        updated = self.ws_svc.update_workspace(
            workspace.id,
            description='用于整理发布材料',
        )

        self.assertEqual(updated.description, '用于整理发布材料')
        self.assertEqual(
            serialize_workspace(updated)['description'],
            '用于整理发布材料',
        )

        cleared = self.ws_svc.update_workspace(workspace.id, description='')
        self.assertEqual(cleared.description, '')
        self.assertEqual(serialize_workspace(cleared)['description'], '')

    def test_template_seeds_short_initial_rules_instead_of_long_persona(self):
        prepared = self.agent_svc._prepare_agent_creation(
            self.org.id,
            '',
            'bot',
            template_id='code-engineer',
            raise_on_error=True,
        )
        template = get_agent_template('code-engineer')
        self.assertIsNotNone(template)
        self.assertEqual(prepared['custom_rules'], template.initial_rules)
        self.assertNotEqual(prepared['custom_rules'], template.persona)
        self.assertLessEqual(len(prepared['custom_rules']), 80)
        self.assertTrue(prepared['name'])

    def test_all_bundled_templates_have_concise_initial_rules(self):
        templates = list_agent_templates()
        self.assertEqual(len(templates), 7)
        for template in templates:
            self.assertTrue(template.initial_rules.strip())
            self.assertLessEqual(len(template.initial_rules), 80)

    def test_explicit_custom_rules_override_template_initial_rules(self):
        prepared = self.agent_svc._prepare_agent_creation(
            self.org.id,
            '',
            'bot',
            template_id='code-engineer',
            custom_rules='按我的团队规范执行',
            raise_on_error=True,
        )
        self.assertEqual(prepared['custom_rules'], '按我的团队规范执行')

    def test_resolve_execution_limits_prefers_workspace(self):
        resolved = resolve_execution_limits(
            {
                'schema_version': 2,
                'capabilities': {
                    'overrides': {
                        'cost': {
                            'execution_limits': {
                                'max_iterations_per_run': 11,
                                'max_credits_per_run': '1',
                            },
                        },
                    },
                },
            },
            workspace_execution_limits={
                'max_iterations_per_run': 99,
                'max_credits_per_run': '9',
            },
        )
        compact = compact_execution_limits(resolved)
        self.assertEqual(compact['max_iterations_per_run'], 99)
        self.assertEqual(compact['max_credits_per_run'], '9')

    def test_resolve_execution_limits_merges_per_key(self):
        """现场只设 iterations 时，credits 仍回落 Agent。"""
        resolved = resolve_execution_limits(
            {
                'schema_version': 2,
                'capabilities': {
                    'overrides': {
                        'cost': {
                            'execution_limits': {
                                'max_iterations_per_run': 11,
                                'max_credits_per_run': '3.5',
                            },
                        },
                    },
                },
            },
            workspace_execution_limits={
                'max_iterations_per_run': 42,
            },
        )
        compact = compact_execution_limits(resolved)
        self.assertEqual(compact['max_iterations_per_run'], 42)
        self.assertEqual(compact['max_credits_per_run'], '3.5')

    def test_resolve_execution_limits_empty_workspace_does_not_fallback_agent(self):
        """#8910：Workspace 空配置 = 未启用，不回落 Agent。"""
        resolved = resolve_execution_limits(
            {
                'schema_version': 2,
                'capabilities': {
                    'overrides': {
                        'cost': {
                            'execution_limits': {
                                'max_iterations_per_run': 11,
                                'max_credits_per_run': '1',
                            },
                        },
                    },
                },
            },
            workspace_execution_limits={},
        )
        self.assertIsNone(compact_execution_limits(resolved))

    def test_resolve_execution_limits_enabled_false_ignores_numeric_draft(self):
        """#8910：显式关闭时即使残留数值也不生效。"""
        resolved = resolve_execution_limits(
            {
                'schema_version': 2,
                'capabilities': {
                    'overrides': {
                        'cost': {
                            'execution_limits': {
                                'max_iterations_per_run': 11,
                            },
                        },
                    },
                },
            },
            workspace_execution_limits={
                'enabled': False,
                'max_iterations_per_run': 99,
                'max_credits_per_run': '9',
            },
        )
        self.assertIsNone(compact_execution_limits(resolved))
