"""测试 app.json manifest 结构完整性。"""

import json
from pathlib import Path

import pytest

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "app.json"


@pytest.fixture
def manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def test_manifest_exists():
    assert MANIFEST_PATH.is_file()


def test_id(manifest):
    assert manifest["id"] == "tabtin-demo-app"


def test_distribution_marketplace(manifest):
    assert manifest["distribution"] == "marketplace"


def test_has_prompt_section(manifest):
    # 演示样板不进生产 Agent `<apps>`（ / Remote PromptForward 派生）。
    assert manifest["agentIntegration"]["hasPromptSection"] is False


def test_context_fields_empty(manifest):
    assert manifest["agentIntegration"]["contextFields"] == []


def test_embedded_web_null(manifest):
    assert manifest["embeddedWeb"] is None


def test_cli_binary(manifest):
    assert manifest["cli"]["binary"] == "tabtin-demo-app"


def test_cli_grammar_rules(manifest):
    rules = manifest["cliGrammar"]["rules"]
    patterns = {r["pattern"] for r in rules}
    assert "tabtin-demo-issue.create" in patterns
    assert "tabtin-demo-issue.list" in patterns

    for rule in rules:
        assert rule["risk_level"] in ("safe", "review", "strict")


def test_prompts_exist():
    prompts_dir = MANIFEST_PATH.parent / "prompts"
    assert (prompts_dir / "zh" / "system.md").is_file()
    assert (prompts_dir / "en" / "system.md").is_file()


def test_tool_cards_exist():
    tool_cards = MANIFEST_PATH.parent / "tool-cards.json"
    assert tool_cards.is_file()
    with tool_cards.open("r") as f:
        data = json.load(f)
    assert "demo_issue_create" in data
    assert "demo_issue_list" in data
