"""Skill 导入防重复：URL 规范化 + 同源/同内容幂等复用。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.db import IntegrityError, transaction
from django.test import TransactionTestCase

from apps.skills.models import Skill
from apps.skills.services.skill_service import SkillService


# ---------------------------------------------------------------------------
# URL 规范化（纯函数，不触 DB）
# ---------------------------------------------------------------------------


def test_normalize_github_blob_to_raw():
    blob = "https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md"
    raw = "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md"
    assert SkillService.normalize_import_source_url(blob) == raw


def test_normalize_raw_url_stable():
    raw = "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md"
    assert SkillService.normalize_import_source_url(raw) == raw


def test_normalize_strips_fragment_and_lowercases_host():
    url = "https://Example.COM/path/to/SKILL.md#section"
    assert SkillService.normalize_import_source_url(url) == "https://example.com/path/to/SKILL.md"


# ---------------------------------------------------------------------------
# 导入幂等（mock ORM / create，不依赖真实 PG 数据）
# ---------------------------------------------------------------------------


def _skill_md(name: str = "frontend-design", body: str = "# Frontend Design\n") -> dict:
    return {
        "path": "SKILL.md",
        "content": (
            f"---\nname: {name}\ndescription: Guidance for distinctive UI.\n---\n\n{body}"
        ),
    }


@pytest.fixture
def import_user_ids():
    # ：Skill 导入 signature 换成 (user_id, organization_id, agent_id)；
    # 老的 space_id 已下线。这里只保留 user_id 匿名 ID，organization/agent 按需在
    # 各测试中显式传入。
    return {
        "user_id": uuid.UUID("22222222-2222-2222-2222-222222222222"),
    }


def test_import_from_files_reuses_by_source_url(monkeypatch, import_user_ids):
    existing = SimpleNamespace(
        skill_id=uuid.uuid4(),
        slug="frontend-design",
        import_source_url="https://raw.githubusercontent.com/o/r/main/SKILL.md",
        canonical_key="user:frontend-design",
        owner_user_id=str(import_user_ids["user_id"]),
        organization_id=None,
        visibility="private",
    )
    created = {"count": 0}

    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: existing),
    )
    monkeypatch.setattr(
        SkillService,
        "_reuse_existing_import_skill",
        classmethod(lambda cls, **kwargs: existing),
    )

    def _should_not_create(**kwargs):
        created["count"] += 1
        raise AssertionError("should not create when source URL already imported")

    monkeypatch.setattr(
        SkillService,
        "create_user_skill",
        staticmethod(_should_not_create),
    )

    skill, _nf, already = SkillService._import_from_files(
        **import_user_ids,
        files=[_skill_md()],
        import_source_url="https://raw.githubusercontent.com/o/r/main/SKILL.md",
    )
    assert already is True
    assert skill is existing
    assert created["count"] == 0


def test_import_from_files_reuses_by_content_hash(monkeypatch, import_user_ids, tmp_path):
    existing = SimpleNamespace(
        skill_id=uuid.uuid4(),
        slug="frontend-design",
        import_source_url="",
        canonical_key="user:frontend-design",
        owner_user_id=str(import_user_ids["user_id"]),
        organization_id=None,
        visibility="private",
    )
    created = {"count": 0}

    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: None),
    )
    monkeypatch.setattr(
        SkillService,
        "_compute_import_content_hash",
        classmethod(lambda cls, files: "abc" * 21 + "ab"),
    )
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_content_hash",
        classmethod(lambda cls, **kwargs: existing),
    )
    monkeypatch.setattr(
        SkillService,
        "_reuse_existing_import_skill",
        classmethod(lambda cls, **kwargs: existing),
    )

    def _should_not_create(**kwargs):
        created["count"] += 1
        raise AssertionError("should not create when content hash already imported")

    monkeypatch.setattr(
        SkillService,
        "create_user_skill",
        staticmethod(_should_not_create),
    )

    skill, _nf, already = SkillService._import_from_files(
        **import_user_ids,
        files=[_skill_md()],
    )
    assert already is True
    assert skill is existing
    assert created["count"] == 0


def test_import_from_url_skips_download_when_source_exists(monkeypatch, import_user_ids):
    existing = SimpleNamespace(
        skill_id=uuid.uuid4(),
        slug="frontend-design",
        import_source_url=(
            "https://raw.githubusercontent.com/anthropics/skills/main/"
            "skills/frontend-design/SKILL.md"
        ),
        canonical_key="user:frontend-design",
        owner_user_id=str(import_user_ids["user_id"]),
        organization_id=None,
        visibility="private",
    )
    downloaded = {"called": False}

    monkeypatch.setattr(SkillService, "_validate_import_url", staticmethod(lambda url: None))
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: existing),
    )
    monkeypatch.setattr(
        SkillService,
        "_reuse_existing_import_skill",
        classmethod(lambda cls, **kwargs: existing),
    )
    monkeypatch.setattr(
        SkillService,
        "_read_sandbox_files",
        staticmethod(lambda _skill: [("SKILL.md", b"---\nname: x\n---\n")]),
    )

    import urllib.request as _urllib_request

    def _should_not_download(*args, **kwargs):
        downloaded["called"] = True
        raise AssertionError("should not download when source URL already imported")

    monkeypatch.setattr(_urllib_request, "urlopen", _should_not_download)

    blob = (
        "https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md"
    )
    skill, files, already = SkillService._import_from_url(
        **import_user_ids, url=blob,
    )
    assert already is True
    assert skill is existing
    assert downloaded["called"] is False
    assert any(f.get("path") == "SKILL.md" for f in files)


def test_import_from_files_creates_when_same_slug_different_content(
    monkeypatch, import_user_ids, tmp_path,
):
    """同 slug、不同内容 → 不按 slug 拦截，仍走新建（-2 由 create 层处理）。"""
    created = {}
    owner_user_id = str(import_user_ids["user_id"])

    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
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
    monkeypatch.setattr(
        SkillService,
        "create_user_skill",
        staticmethod(
            lambda **kwargs: created.update(kwargs)
            or SimpleNamespace(
                slug="frontend-design-2",
                skill_id="sk-new",
                owner_user_id=owner_user_id,
                organization_id=None,
                visibility="private",
            ),
        ),
    )
    monkeypatch.setattr(
        SkillService,
        "_publish_initial_skill_files",
        classmethod(lambda cls, **kwargs: None),
    )

    skill, _nf, already = SkillService._import_from_files(
        **import_user_ids,
        files=[_skill_md(body="# Different body\n")],
    )
    assert already is False
    assert skill.slug == "frontend-design-2"
    assert created.get("import_source_url") == ""


def test_import_from_url_passes_normalized_source_url(monkeypatch, import_user_ids):
    captured = {}

    class _Resp:
        headers = {"Content-Type": "text/plain"}

        def read(self, _n):
            return (
                b"---\nname: frontend-design\ndescription: Guidance for distinctive UI.\n"
                b"---\n\n# Frontend Design\n"
            )

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(SkillService, "_validate_import_url", staticmethod(lambda url: None))
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: None),
    )

    import urllib.request as _urllib_request

    monkeypatch.setattr(_urllib_request, "urlopen", lambda *a, **k: _Resp())

    def _fake_import_from_files(cls, **kwargs):
        captured.update(kwargs)
        skill = SimpleNamespace(slug="frontend-design", skill_id="sk-1")
        return skill, [], False

    monkeypatch.setattr(
        SkillService,
        "_import_from_files",
        classmethod(_fake_import_from_files),
    )
    monkeypatch.setattr(
        SkillService,
        "_read_sandbox_files",
        staticmethod(lambda _skill: []),
    )

    blob = (
        "https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md"
    )
    skill, _files, already = SkillService._import_from_url(
        **import_user_ids, url=blob,
    )
    assert already is False
    assert skill.slug == "frontend-design"
    assert captured["import_source_url"] == (
        "https://raw.githubusercontent.com/anthropics/skills/main/"
        "skills/frontend-design/SKILL.md"
    )


class TestImportDedupVisibility(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner_id = uuid.uuid4()
        self.organization_id = uuid.uuid4()
        self.content_hash = "a" * 64

    def test_organization_snapshot_does_not_count_as_personal_content_import(self):
        """组织已有同内容快照、我的无原件时，URL 导入仍应创建个人 Skill。"""
        Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="brainstorming-org-snapshot",
            name="brainstorming",
            source=Skill.SOURCE_USER,
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_id,
            install_content_hash=self.content_hash,
        )

        found = SkillService._find_skill_by_content_hash(
            owner_user_id=self.owner_id,
            content_hash=self.content_hash,
        )

        self.assertIsNone(found)

    def test_organization_snapshot_does_not_count_as_personal_source_url_import(self):
        source_url = "https://example.com/brainstorming/SKILL.md"
        Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="brainstorming-org-url-snapshot",
            name="brainstorming",
            source=Skill.SOURCE_USER,
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_id,
            import_source_url=source_url,
        )

        found = SkillService._find_skill_by_import_source_url(
            owner_user_id=self.owner_id,
            import_source_url=source_url,
        )

        self.assertIsNone(found)

    def test_import_creates_private_original_when_organization_snapshot_has_same_url(self):
        source_url = "https://example.com/brainstorming/SKILL.md"
        organization_snapshot = Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="brainstorming-org-url-snapshot",
            name="brainstorming",
            source=Skill.SOURCE_USER,
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_id,
            import_source_url=source_url,
        )

        with (
            patch.object(
                SkillService,
                "_write_import_files_and_publish",
                side_effect=lambda **kwargs: kwargs["skill"],
            ),
            patch.object(SkillService, "_read_sandbox_files", return_value=[]),
        ):
            imported_skill, _files, already_exists = SkillService._import_from_files(
                user_id=self.owner_id,
                files=[_skill_md(name="brainstorming")],
                import_source_url=source_url,
            )

        self.assertFalse(already_exists)
        self.assertNotEqual(imported_skill.skill_id, organization_snapshot.skill_id)
        self.assertEqual(imported_skill.visibility, Skill.VISIBILITY_PRIVATE)
        self.assertEqual(imported_skill.import_source_url, source_url)

    def test_personal_source_url_remains_unique(self):
        source_url = "https://example.com/brainstorming/SKILL.md"
        Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="brainstorming",
            name="brainstorming",
            source=Skill.SOURCE_USER,
            visibility=Skill.VISIBILITY_PRIVATE,
            import_source_url=source_url,
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            Skill.objects.create(
                owner_user_id=self.owner_id,
                slug="brainstorming-public",
                name="brainstorming public",
                source=Skill.SOURCE_USER,
                visibility=Skill.VISIBILITY_PUBLIC,
                import_source_url=source_url,
            )

    def test_private_original_still_counts_as_personal_content_import(self):
        private_skill = Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="brainstorming",
            name="brainstorming",
            source=Skill.SOURCE_USER,
            visibility=Skill.VISIBILITY_PRIVATE,
            install_content_hash=self.content_hash,
        )

        found = SkillService._find_skill_by_content_hash(
            owner_user_id=self.owner_id,
            content_hash=self.content_hash,
        )

        self.assertEqual(found, private_skill)
