"""Pure unit coverage for binary (base64) skill file handling.

覆盖「多文件 Skill 原样带二进制资源」全链路的后端落盘层：
- ``_decode_publish_file_bytes``：base64 解码 / 文本默认 / 非法输入；
- ``_entries_from_publish_files``（publish 路径）：文本+二进制混合往返、防 ``..``、20MB 预算；
- ``_import_from_files``（import 路径，用户实际命中场景）：base64 解码后字节落盘一致。
"""

import base64
import os
from types import SimpleNamespace

import pytest

from apps.skills.services.skill_service import SkillService, SkillServiceError


# 含 NUL / 高位字节的「真二进制」样本：UTF-8 文本通道必然损坏，base64 才能原样带。
RAW_BINARY = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x10])
ALL_BYTES = bytes(range(256))


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# _decode_publish_file_bytes — 共享解码原语
# ---------------------------------------------------------------------------


def test_decode_defaults_to_utf8_text():
    out = SkillService._decode_publish_file_bytes({"content": "héllo 世界"}, "a.md")
    assert out == "héllo 世界".encode("utf-8")


def test_decode_explicit_text_encoding():
    out = SkillService._decode_publish_file_bytes(
        {"content": "plain", "encoding": "text"}, "a.md",
    )
    assert out == b"plain"


def test_decode_base64_roundtrip_exact_bytes():
    out = SkillService._decode_publish_file_bytes(
        {"content": _b64(ALL_BYTES), "encoding": "base64"}, "logo.png",
    )
    assert out == ALL_BYTES


def test_decode_base64_invalid_raises():
    with pytest.raises(SkillServiceError):
        SkillService._decode_publish_file_bytes(
            {"content": "!!!not base64!!!", "encoding": "base64"}, "x.bin",
        )


def test_decode_base64_non_string_raises():
    with pytest.raises(SkillServiceError):
        SkillService._decode_publish_file_bytes(
            {"content": 123, "encoding": "base64"}, "x.bin",
        )


def test_decode_text_non_string_raises():
    with pytest.raises(SkillServiceError):
        SkillService._decode_publish_file_bytes({"content": None}, "x.md")


# ---------------------------------------------------------------------------
# _entries_from_publish_files — publish 路径
# ---------------------------------------------------------------------------


def test_publish_entries_mix_text_and_binary_roundtrip():
    skill_md = "---\nname: demo\ndescription: x\n---\n\n# Demo\n"
    entries = SkillService._entries_from_publish_files([
        {"path": "SKILL.md", "content": skill_md},
        {"path": "assets/logo.png", "content": _b64(RAW_BINARY), "encoding": "base64"},
        {"path": "references/style.md", "content": "# Style"},
    ])
    by_path = dict(entries)
    # 二进制字节与原文件严格一致（base64 往返无损）。
    assert by_path["assets/logo.png"] == RAW_BINARY
    # 文本仍按 UTF-8。
    assert by_path["SKILL.md"] == skill_md.encode("utf-8")
    assert by_path["references/style.md"] == b"# Style"


def test_publish_entries_reject_path_traversal_for_binary():
    with pytest.raises(SkillServiceError):
        SkillService._entries_from_publish_files([
            {"path": "SKILL.md", "content": "# ok"},
            {"path": "../evil.png", "content": _b64(RAW_BINARY), "encoding": "base64"},
        ])


def test_publish_entries_budget_counts_decoded_bytes(monkeypatch):
    # 把预算压到很小：base64 字符串虽然更长，但预算按「解码后真实字节」计入。
    monkeypatch.setattr(SkillService, "_MAX_EXTRACTED_TOTAL", 8)
    big = bytes(range(32))  # 32 字节 > 8
    with pytest.raises(SkillServiceError):
        SkillService._entries_from_publish_files([
            {"path": "SKILL.md", "content": "# ok"},
            {"path": "a.bin", "content": _b64(big), "encoding": "base64"},
        ])


def test_publish_entries_within_budget_passes(monkeypatch):
    monkeypatch.setattr(SkillService, "_MAX_EXTRACTED_TOTAL", 1024)
    entries = SkillService._entries_from_publish_files([
        {"path": "SKILL.md", "content": "# ok"},
        {"path": "a.bin", "content": _b64(RAW_BINARY), "encoding": "base64"},
    ])
    assert dict(entries)["a.bin"] == RAW_BINARY


# ---------------------------------------------------------------------------
# _import_from_files — import 路径（用户实际命中：导入含 assets 的文件夹）
# ---------------------------------------------------------------------------


def _patch_create_user_skill(
    monkeypatch,
    slug: str = "demo-skill",
    owner_user_id: str = "22222222-2222-2222-2222-222222222222",
):
    monkeypatch.setattr(
        SkillService,
        "create_user_skill",
        staticmethod(
            lambda **kwargs: SimpleNamespace(
                slug=slug,
                skill_id="sk-1",
                owner_user_id=owner_user_id,
                organization_id=None,
                visibility="private",
            )
        ),
    )
    monkeypatch.setattr(
        SkillService,
        "_publish_initial_skill_files",
        classmethod(lambda cls, **kwargs: None),
    )
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: None),
    )
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_content_hash",
        classmethod(lambda cls, **kwargs: None),
    )


def test_import_from_files_writes_binary_bytes_exactly(tmp_path, monkeypatch):
    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
    owner_user_id = "22222222-2222-2222-2222-222222222222"
    _patch_create_user_skill(monkeypatch, owner_user_id=owner_user_id)

    SkillService._import_from_files(
        user_id=owner_user_id,
        files=[
            {"path": "SKILL.md", "content": "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n"},
            {"path": "assets/logo.png", "content": _b64(ALL_BYTES), "encoding": "base64"},
        ],
        name="Demo",
    )

    # ：sandbox 双层布局 = users/{owner}/skills/{slug}。
    # 用 realpath 还原落盘路径（macOS /var → /private/var 符号链接）。
    skill_dir = os.path.realpath(
        os.path.join(str(tmp_path), "users", owner_user_id, "skills", "demo-skill"),
    )
    with open(os.path.join(skill_dir, "assets", "logo.png"), "rb") as fh:
        assert fh.read() == ALL_BYTES
    with open(os.path.join(skill_dir, "SKILL.md"), "r", encoding="utf-8") as fh:
        assert "# Demo" in fh.read()


def test_import_from_files_budget_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(SkillService, "_MAX_EXTRACTED_TOTAL", 8)
    _patch_create_user_skill(monkeypatch)

    with pytest.raises(SkillServiceError):
        SkillService._import_from_files(
            user_id="22222222-2222-2222-2222-222222222222",
            files=[
                {"path": "SKILL.md", "content": "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n"},
                {"path": "a.bin", "content": _b64(bytes(range(64))), "encoding": "base64"},
            ],
            name="Demo",
        )
