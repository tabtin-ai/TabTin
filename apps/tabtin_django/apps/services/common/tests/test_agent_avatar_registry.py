from unittest import TestCase

from apps.services.common.agent_avatar_registry import (
    BUILTIN_AGENT_AVATAR_KEYS,
    FUNCTION_AGENT_AVATAR_KEYS,
    LEGACY_AGENT_AVATAR_KEYS,
    is_builtin_agent_avatar_key,
)
from apps.services.common.agent_template_registry import list_agent_templates


class AgentAvatarRegistryTest(TestCase):
    def test_existing_keys_remain_stable_and_function_keys_are_additive(self):
        self.assertEqual(
            LEGACY_AGENT_AVATAR_KEYS,
            (
                "general-assistant",
                "code-engineer",
                "doc-writer",
                "data-analyst",
                "web-researcher",
                "slide-designer",
                "office-secretary",
            ),
        )
        self.assertEqual(
            FUNCTION_AGENT_AVATAR_KEYS,
            (
                "function-general-assistant",
                "function-code-engineer",
                "function-doc-writer",
                "function-data-analyst",
                "function-web-researcher",
                "function-slide-designer",
                "function-office-secretary",
            ),
        )
        self.assertEqual(len(BUILTIN_AGENT_AVATAR_KEYS), 14)
        self.assertEqual(len(set(BUILTIN_AGENT_AVATAR_KEYS)), 14)

    def test_registry_accepts_bundled_presets_and_rejects_unknown_keys(self):
        template_avatar_keys = {
            template.avatar_key
            for template in list_agent_templates()
            if template.avatar_key
        }

        self.assertTrue(template_avatar_keys.issubset(BUILTIN_AGENT_AVATAR_KEYS))
        self.assertTrue(is_builtin_agent_avatar_key("function-web-researcher"))
        self.assertFalse(is_builtin_agent_avatar_key("not-a-real-avatar"))
