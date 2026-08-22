"""
BRA-002 / BRA-003 / BRA-005 回归测试

验证 skill_doc_parser 对 agents/*.md 角色定义文件的解析能力：
- RICH_METADATA_KEYS 包含 agent 字段 (BRA-003)
- _extract_rich_metadata 正确提取 reply_mode / tool_domains / model (BRA-002)
- parse_agent_doc / is_agent_doc 正确识别 agent 文档 (BRA-005)
"""
import pytest

from apps.skills.services.skill_doc_parser import (
    RICH_METADATA_KEYS,
    VALID_TOOL_DOMAINS,
    _extract_rich_metadata,
    _parse_frontmatter,
    is_agent_doc,
    parse_agent_doc,
    parse_skill_doc,
)


# ── BRA-003: RICH_METADATA_KEYS 包含 agent 字段 ──


class TestRichMetadataKeysContainAgentFields:
    def test_reply_mode_in_keys(self):
        assert "reply_mode" in RICH_METADATA_KEYS

    def test_tool_domains_in_keys(self):
        assert "tool_domains" in RICH_METADATA_KEYS

    def test_model_in_keys(self):
        assert "model" in RICH_METADATA_KEYS


# ── BRA-002: _extract_rich_metadata 解析 agent 字段 ──


class TestExtractRichMetadataAgentFields:
    def test_reply_mode_extracted(self):
        fm = {"reply_mode": "autonomous"}
        meta = _extract_rich_metadata(fm)
        assert meta["reply_mode"] == "autonomous"

    def test_reply_mode_camelcase(self):
        fm = {"replyMode": "interactive"}
        meta = _extract_rich_metadata(fm)
        assert meta["reply_mode"] == "interactive"

    def test_reply_mode_stripped(self):
        fm = {"reply_mode": "  observe  "}
        meta = _extract_rich_metadata(fm)
        assert meta["reply_mode"] == "observe"

    def test_reply_mode_empty_is_none(self):
        fm = {"reply_mode": ""}
        meta = _extract_rich_metadata(fm)
        assert meta["reply_mode"] is None

    def test_reply_mode_missing_is_none(self):
        fm = {}
        meta = _extract_rich_metadata(fm)
        assert meta["reply_mode"] is None

    def test_tool_domains_list(self):
        fm = {"tool_domains": ["rag", "browser", "tabdata"]}
        meta = _extract_rich_metadata(fm)
        assert meta["tool_domains"] == ["rag", "browser", "tabdata"]

    def test_tool_domains_camelcase(self):
        fm = {"toolDomains": ["tabcode"]}
        meta = _extract_rich_metadata(fm)
        assert meta["tool_domains"] == ["tabcode"]

    def test_tool_domains_csv_string(self):
        fm = {"tool_domains": "rag, browser"}
        meta = _extract_rich_metadata(fm)
        assert meta["tool_domains"] == ["rag", "browser"]

    def test_tool_domains_empty_list_filtered(self):
        fm = {"tool_domains": ["", "  ", "rag"]}
        meta = _extract_rich_metadata(fm)
        assert meta["tool_domains"] == ["rag"]

    def test_tool_domains_missing_is_none(self):
        fm = {}
        meta = _extract_rich_metadata(fm)
        assert meta["tool_domains"] is None

    def test_model_extracted(self):
        fm = {"model": "sonnet-4.6"}
        meta = _extract_rich_metadata(fm)
        assert meta["model"] == "sonnet-4.6"

    def test_model_stripped(self):
        fm = {"model": "  gpt-4o  "}
        meta = _extract_rich_metadata(fm)
        assert meta["model"] == "gpt-4o"

    def test_model_empty_is_none(self):
        fm = {"model": ""}
        meta = _extract_rich_metadata(fm)
        assert meta["model"] is None

    def test_model_missing_is_none(self):
        fm = {}
        meta = _extract_rich_metadata(fm)
        assert meta["model"] is None


# ── BRA-005: is_agent_doc 身份识别 ──


class TestIsAgentDoc:
    def test_with_reply_mode(self):
        assert is_agent_doc({"reply_mode": "autonomous"}) is True

    def test_with_camelcase_reply_mode(self):
        assert is_agent_doc({"replyMode": "interactive"}) is True

    def test_with_tool_domains(self):
        assert is_agent_doc({"tool_domains": ["rag"]}) is True

    def test_with_camelcase_tool_domains(self):
        assert is_agent_doc({"toolDomains": ["rag"]}) is True

    def test_skill_doc_not_agent(self):
        assert is_agent_doc({"name": "GitHub", "version": "1.0"}) is False

    def test_empty_dict(self):
        assert is_agent_doc({}) is False

    def test_none_input(self):
        assert is_agent_doc(None) is False

    def test_non_dict(self):
        assert is_agent_doc("not a dict") is False


# ── BRA-005: parse_agent_doc 完整解析 ──


SAMPLE_AGENT_MD = """\
---
name: 研究员
model: sonnet-4.6
description: 负责信息收集和分析
reply_mode: autonomous
tool_domains:
  - rag
  - browser
---

# 研究员

你是一个专注于信息收集和分析的研究员角色。
"""

SAMPLE_AGENT_MD_MINIMAL = """\
---
name: 执行者
reply_mode: selective
---

执行具体任务的角色。
"""

SAMPLE_AGENT_MD_NO_FRONTMATTER = """\
# 观察者

只观察不执行的角色。
"""


class TestParseAgentDoc:
    def test_full_agent_doc(self):
        result = parse_agent_doc(SAMPLE_AGENT_MD)
        assert result["doc_type"] == "agent"
        assert result["name"] == "研究员"
        assert result["model"] == "sonnet-4.6"
        assert result["description"] == "负责信息收集和分析"
        assert result["reply_mode"] == "autonomous"
        assert result["tool_domains"] == ["rag", "browser"]
        assert result["has_frontmatter"] is True

    def test_minimal_agent_doc(self):
        result = parse_agent_doc(SAMPLE_AGENT_MD_MINIMAL)
        assert result["doc_type"] == "agent"
        assert result["name"] == "执行者"
        assert result["reply_mode"] == "selective"
        assert result["model"] is None
        assert result["tool_domains"] is None

    def test_no_frontmatter_fallback(self):
        result = parse_agent_doc(SAMPLE_AGENT_MD_NO_FRONTMATTER)
        assert result["doc_type"] == "agent"
        assert result["name"] == "观察者"
        assert result["description"] == "只观察不执行的角色。"
        assert result["has_frontmatter"] is False
        assert result["model"] is None

    def test_empty_content(self):
        result = parse_agent_doc("")
        assert result["doc_type"] == "agent"
        assert result["name"] == ""
        assert result["has_frontmatter"] is False

    def test_invalid_tool_domain_logged(self):
        from unittest.mock import patch
        content = """\
---
name: test
reply_mode: autonomous
tool_domains:
  - rag
  - invalid_domain
---
"""
        with patch("apps.skills.services.skill_doc_parser.logger") as mock_logger:
            result = parse_agent_doc(content)
        assert result["tool_domains"] == ["rag", "invalid_domain"]
        mock_logger.warning.assert_called_once()
        call_args = mock_logger.warning.call_args[0]
        assert "unknown tool_domains" in call_args[0]


# ── 确保 parse_skill_doc 也能传播新字段 ──


class TestParseSkillDocPropagatesAgentFields:
    """parse_skill_doc 在处理含 agent 字段的 SKILL.md 时也应传播这些字段。"""

    def test_skill_doc_with_reply_mode(self):
        content = """\
---
name: TestSkill
version: "1.0"
reply_mode: autonomous
tool_domains:
  - tabdata
model: sonnet-4.6
---
"""
        result = parse_skill_doc(content)
        assert result["reply_mode"] == "autonomous"
        assert result["tool_domains"] == ["tabdata"]
        assert result["model"] == "sonnet-4.6"

    def test_skill_doc_without_agent_fields(self):
        content = """\
---
name: PlainSkill
version: "1.0"
---
"""
        result = parse_skill_doc(content)
        assert result["reply_mode"] is None
        assert result["tool_domains"] is None
        assert result["model"] is None


# ── VALID_TOOL_DOMAINS 值域校验 ──


class TestValidToolDomains:
    def test_contains_expected_domains(self):
        expected = {"rag", "browser", "tabdata", "tabcode", "tabdoc",
                    "tabslide", "tabwhiteboard", "tabvideo"}
        assert VALID_TOOL_DOMAINS == expected

    def test_is_frozenset(self):
        assert isinstance(VALID_TOOL_DOMAINS, frozenset)
