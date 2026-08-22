"""Pure unit coverage for Mine publish payload file handling."""

import io
import zipfile

import pytest

from apps.skills.services.skill_service import SkillService, SkillServiceError


def test_publish_payload_files_require_skill_md_and_strip_file_version():
    entries = SkillService._entries_from_publish_files([
        {
            "path": "SKILL.md",
            "content": (
                "---\n"
                "name: Demo\n"
                "description: Draft\n"
                "version: 0.0.1-draft\n"
                "---\n\n"
                "# Body\n"
            ),
        },
    ])

    assert entries[0][0] == "SKILL.md"
    text = entries[0][1].decode("utf-8")
    assert "version:" not in text
    assert "# Body" in text


def test_publish_version_label_requires_semver_core():
    from apps.skills.services.semver_utils import normalize_semver_label

    assert normalize_semver_label("1.2.3") == "1.2.3"
    assert normalize_semver_label("v1.2.3") == "1.2.3"  # v 前缀规范化为三段

    for invalid in ["1.2", "01.2.3", "0.0.1-draft", "not-a-version"]:
        with pytest.raises(ValueError):
            normalize_semver_label(invalid)


def test_publish_payload_files_reject_path_traversal():
    with pytest.raises(SkillServiceError):
        SkillService._entries_from_publish_files([
            {"path": "../SKILL.md", "content": "# nope"},
        ])


def test_publish_payload_files_reject_missing_skill_md():
    with pytest.raises(SkillServiceError):
        SkillService._entries_from_publish_files([
            {"path": "README.md", "content": "# nope"},
        ])


def test_publish_payload_files_skip_all_dot_entries():
    entries = SkillService._entries_from_publish_files([
        {"path": "SKILL.md", "content": "---\nname: demo\n---\n\n# Demo\n"},
        {"path": ".gitignore", "content": "node_modules/\n"},
        {"path": ".eslintrc.js", "content": "module.exports = {}\n"},
        {"path": "references/.keep", "content": ""},
        {"path": "references/a.md", "content": "# A\n"},
    ])
    assert [path for path, _ in entries] == ["SKILL.md", "references/a.md"]


def _skill_md_entry(version_line: str):
    body = "---\nname: demo\ndescription: x\n"
    if version_line:
        body += f"{version_line}\n"
    body += "---\n\n# Body\n"
    return [("SKILL.md", body.encode("utf-8"))]


def test_version_label_from_skill_md_entries_prefers_frontmatter():
    entries = _skill_md_entry("version: 2.1.0")
    assert SkillService._version_label_from_skill_md_entries(entries) == "2.1.0"


def test_version_label_from_skill_md_entries_normalizes_v_prefix():
    entries = _skill_md_entry("version: v1.0.0")
    assert SkillService._version_label_from_skill_md_entries(entries) == "1.0.0"


def test_version_label_from_skill_md_entries_returns_none_for_legacy_or_invalid():
    # 旧骨架预发布标签 / 两段 / 完全非法 / 缺失 → None，交由上层回退或显式报错
    assert SkillService._version_label_from_skill_md_entries(
        _skill_md_entry("version: 0.0.1-draft")
    ) is None
    assert SkillService._version_label_from_skill_md_entries(
        _skill_md_entry("version: 1.0")
    ) is None
    assert SkillService._version_label_from_skill_md_entries(
        _skill_md_entry("version: not-a-version")
    ) is None
    assert SkillService._version_label_from_skill_md_entries(
        _skill_md_entry("")
    ) is None


def test_publish_zip_keeps_paths_relative_to_skill_root():
    zip_bytes = SkillService._build_zip(
        [("SKILL.md", b"# body")],
        "demo",
    )

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        assert zf.namelist() == ["SKILL.md"]
