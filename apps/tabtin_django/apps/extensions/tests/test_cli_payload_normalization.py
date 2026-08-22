import ast
import json
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.core.management.base import OutputWrapper
from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase

from apps.capabilities.management.commands.create_tool import (
    Command,
    T_BACKEND_TOOL,
    T_EXTENSION_TOOL,
    T_SKILL_MD,
)
from apps.extensions.api import _normalize_cli_payload, execute_extension_cli_command, extension_cli_commands
from apps.services.tools.error_envelope import build_tool_error, json_tool_error


def _generated_tool_error_calls(template) -> dict[str, ast.Call]:
    source = template(
        "demo.search",
        "search",
        "demo",
        "查询示例数据并返回结构化结果，适用于验证工具脚手架。",
        "safe",
    )
    tree = ast.parse(source)
    imported_names = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and node.module == "apps.services.tools.error_envelope"
        for alias in node.names
    }
    assert "build_tool_error" in imported_names

    calls: dict[str, ast.Call] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id != "build_tool_error":
            continue
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        error_kind = keywords.get("error_kind")
        if isinstance(error_kind, ast.Constant) and isinstance(error_kind.value, str):
            calls[error_kind.value] = node
    return calls


class ExtensionCliPayloadNormalizationTests(SimpleTestCase):
    def test_normalizes_kebab_and_camel_case_keys(self):
        payload = {
            "agent-space-id": "space-1",
            "pageSize": "20",
            "dryRun": True,
            "already_snake": "ok",
        }

        self.assertEqual(
            _normalize_cli_payload(payload),
            {
                "space_id": "space-1",
                "page_size": "20",
                "dry_run": True,
                "already_snake": "ok",
            },
        )

    def test_execute_extension_cli_command_validates_space_ownership(self):
        request = RequestFactory().post(
            "/api/extensions/demo/cli/send/",
            data=json.dumps({"agentSpaceId": "space-1"}),
            content_type="application/json",
        )
        tool = Mock()
        ownership_error = JsonResponse({"ok": False, "error": "forbidden"}, status=403)

        with (
            patch("apps.extensions.api._require_auth", return_value=(None, SimpleNamespace(id="user-1"), "organization-1")),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=ownership_error) as validate,
        ):
            response = execute_extension_cli_command(request, "demo", "send")

        self.assertEqual(response.status_code, 403)
        validate.assert_called_once_with("organization-1", "space-1")
        tool.run.assert_not_called()

    def test_extension_cli_commands_only_returns_bound_tools(self):
        request = RequestFactory().get("/api/extensions/cli-commands/")
        commands = [
            {"extension_id": "demo", "name": "send", "api_endpoint": "/api/extensions/demo/cli/send/"},
            {"extension_id": "demo", "name": "ghost", "api_endpoint": "/api/extensions/demo/cli/ghost/"},
        ]

        with (
            patch("apps.extensions.registry.ExtensionRegistry.get_all_cli_commands", return_value=commands),
            patch(
                "apps.extensions.api._find_extension_tool",
                side_effect=lambda extension_id, command_name: object() if command_name == "send" else None,
            ),
        ):
            response = extension_cli_commands(request)

        payload = json.loads(response.content)
        self.assertEqual(payload["data"]["commands"], [commands[0]])

    def test_execute_extension_cli_maps_dict_standard_envelope_to_http_error(self):
        request = RequestFactory().post(
            "/api/extensions/tabmemo/cli/create_memo/",
            data=json.dumps({}),
            content_type="application/json",
        )
        tool = Mock()
        tool.run.return_value = build_tool_error(
            "user not found",
            error_kind="runtime_misconfig",
            hint="Ensure the Agent session injects user_id before calling tabmemo tools.",
            retryable=False,
        )

        with (
            patch(
                "apps.extensions.api._require_auth",
                return_value=(None, SimpleNamespace(id="user-1"), "organization-1"),
            ),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=None),
        ):
            response = execute_extension_cli_command(request, "tabmemo", "create_memo")

        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.content)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["code"], "EXTENSION_CLI_TOOL_ERROR")
        self.assertEqual(payload["error"]["error_kind"], "runtime_misconfig")
        self.assertIn("user_id", payload["error"]["hint"])
        self.assertNotIn("status", payload.get("data", {}) or {})

    def test_execute_extension_cli_maps_json_string_standard_envelope_to_http_error(self):
        request = RequestFactory().post(
            "/api/extensions/tabmail/cli/send_email/",
            data=json.dumps({"to": "a@b.com", "subject": "s", "body": "b"}),
            content_type="application/json",
        )
        tool = Mock()
        tool.run.return_value = json_tool_error(
            "organization_id is required",
            error_kind="runtime_misconfig",
            hint="Start the Agent inside a Space so organization_id is injected.",
            retryable=False,
        )

        with (
            patch(
                "apps.extensions.api._require_auth",
                return_value=(None, SimpleNamespace(id="user-1"), "organization-1"),
            ),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=None),
        ):
            response = execute_extension_cli_command(request, "tabmail", "send_email")

        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.content)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["error_kind"], "runtime_misconfig")
        self.assertIsInstance(payload["data"], dict)
        self.assertTrue(payload["data"]["success"] is False)

    def test_execute_extension_cli_maps_legacy_status_error_to_http_error(self):
        request = RequestFactory().post(
            "/api/extensions/demo/cli/search/",
            data=json.dumps({"query": "example"}),
            content_type="application/json",
        )
        tool = Mock()
        tool.run.return_value = {
            "status": "error",
            "error": "query is invalid",
            "hint": "Provide a non-empty query.",
        }

        with (
            patch(
                "apps.extensions.api._require_auth",
                return_value=(None, SimpleNamespace(id="user-1"), "organization-1"),
            ),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=None),
        ):
            response = execute_extension_cli_command(request, "demo", "search")

        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.content)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["code"], "EXTENSION_CLI_TOOL_ERROR")
        self.assertEqual(payload["error"]["message"], "query is invalid")
        self.assertEqual(payload["error"]["hint"], "Provide a non-empty query.")
        self.assertEqual(payload["data"], tool.run.return_value)

    def test_execute_extension_cli_hides_unexpected_exception_details(self):
        request = RequestFactory().post(
            "/api/extensions/demo/cli/search/",
            data=json.dumps({"query": "example"}),
            content_type="application/json",
        )
        tool = Mock()
        tool.run.side_effect = RuntimeError("secret-token=do-not-leak")

        with (
            patch(
                "apps.extensions.api._require_auth",
                return_value=(None, SimpleNamespace(id="user-1"), "organization-1"),
            ),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=None),
            patch("apps.extensions.api._", return_value="Localized internal error"),
            patch("apps.extensions.api.logger.exception") as log_exception,
        ):
            response = execute_extension_cli_command(request, "demo", "search")

        self.assertEqual(response.status_code, 500)
        payload = json.loads(response.content)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["code"], "EXTENSION_CLI_EXEC_FAILED")
        self.assertEqual(payload["error"]["message"], "Localized internal error")
        self.assertNotIn("secret-token", response.content.decode())
        log_exception.assert_called_once()

    def test_execute_extension_cli_preserves_successful_json_tool_result(self):
        request = RequestFactory().post(
            "/api/extensions/tabmail/cli/send_email/",
            data=json.dumps({"to": "a@b.com", "subject": "s", "body": "b"}),
            content_type="application/json",
        )
        tool = Mock()
        tool.run.return_value = json.dumps(
            {"ok": True, "message": "发送成功", "message_id": "m-1"},
            ensure_ascii=False,
        )

        with (
            patch(
                "apps.extensions.api._require_auth",
                return_value=(None, SimpleNamespace(id="user-1"), "organization-1"),
            ),
            patch("apps.extensions.api._find_cli_command", return_value={"method": "POST"}),
            patch("apps.extensions.api._find_extension_tool", return_value=tool),
            patch("apps.extensions.api._validate_space_ownership", return_value=None),
        ):
            response = execute_extension_cli_command(request, "tabmail", "send_email")

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.content)
        self.assertTrue(payload["success"])
        self.assertEqual(
            json.loads(payload["data"]),
            {"ok": True, "message": "发送成功", "message_id": "m-1"},
        )


class CreateToolTemplateErrorEnvelopeTests(SimpleTestCase):
    def assert_uses_standard_failure_envelopes(self, template):
        calls = _generated_tool_error_calls(template)

        self.assertEqual(
            set(calls),
            {"missing_required_param", "permission_denied", "internal_error"},
        )
        expected_retryability = {
            "missing_required_param": False,
            "permission_denied": False,
            "internal_error": True,
        }
        for error_kind, retryable in expected_retryability.items():
            keywords = {keyword.arg: keyword.value for keyword in calls[error_kind].keywords}
            self.assertIsInstance(keywords.get("retryable"), ast.Constant)
            self.assertIs(keywords["retryable"].value, retryable)

        unexpected_message = calls["internal_error"].args[0]
        self.assertIsInstance(unexpected_message, ast.Constant)
        self.assertEqual(unexpected_message.value, "操作失败，请稍后重试")

    def test_backend_template_uses_standard_failure_envelopes(self):
        self.assert_uses_standard_failure_envelopes(T_BACKEND_TOOL)

    def test_extension_template_uses_standard_failure_envelopes(self):
        self.assert_uses_standard_failure_envelopes(T_EXTENSION_TOOL)

    def test_base_tool_skills_document_standard_failure_envelopes(self):
        for tool_type in ("backend", "extension"):
            with self.subTest(tool_type=tool_type):
                content = T_SKILL_MD(
                    "demo-operator",
                    "demo",
                    "查询示例数据并返回结构化结果。",
                    ["search"],
                    ["fc"],
                    tool_type=tool_type,
                )

                self.assertIn('"status": "ok"', content)
                self.assertIn("build_tool_error(...)", content)
                self.assertIn('"success": false', content)
                self.assertIn('"error_kind"', content)
                self.assertNotIn('{"status": "error"', content)

    def test_cli_skill_uses_http_failure_guidance(self):
        content = T_SKILL_MD(
            "demo-operator",
            "demo",
            "查询示例数据并返回结构化结果。",
            [],
            ["cli"],
            tool_type="cli",
        )

        self.assertIn("非 2xx", content)
        self.assertNotIn("build_tool_error", content)
        self.assertNotIn('{"status": "error"', content)

    def test_command_completion_guidance_varies_by_tool_type(self):
        for tool_type in ("backend", "extension"):
            with self.subTest(tool_type=tool_type):
                output = self._render_completion_guidance(tool_type)
                self.assertIn("build_tool_error(...)", output)
                self.assertIn("success: false", output)
                self.assertIn("error_kind", output)
                self.assertIn("status: 'ok'", output)
                self.assertNotIn("status: 'error'", output)

        frontend_output = self._render_completion_guidance("frontend")
        self.assertIn("Action Tool", frontend_output)
        self.assertIn("status: 'error'", frontend_output)
        self.assertNotIn("build_tool_error", frontend_output)

        cli_output = self._render_completion_guidance("cli")
        self.assertIn("handleCommandError", cli_output)
        self.assertNotIn("status: 'error'", cli_output)

    @staticmethod
    def _render_completion_guidance(tool_type: str) -> str:
        command = Command()
        stream = StringIO()
        command.stdout = OutputWrapper(stream)
        command._summary([], dry=False, name="demo.search", tool_type=tool_type)
        return stream.getvalue()
