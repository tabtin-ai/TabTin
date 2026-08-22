"""Pure unit coverage for import-time SKILL.md validation."""

import io
import os
import urllib.error
from types import SimpleNamespace

import pytest

from apps.skills.services.skill_service import SkillService, SkillServiceError


def _make_http_error(*, code, msg, body=b""):
    """构造一个最小可用的 urllib HTTPError（带响应体），不触网。"""
    return urllib.error.HTTPError(
        url="https://example.com/SKILL.md",
        code=code,
        msg=msg,
        hdrs=None,
        fp=io.BytesIO(body),
    )


def test_describe_http_error_429_surfaces_rate_limit():
    """#609：上游 429 必须翻成「被限流」人话，并带出响应体里的真实原因。"""
    exc = _make_http_error(
        code=429,
        msg="Too Many Requests",
        body=b'{"message": "API rate limit exceeded for 1.2.3.4"}',
    )
    msg = SkillService._describe_http_error(exc)
    assert "限流" in msg
    assert "API rate limit exceeded" in msg


def test_describe_http_error_403_rate_limit_body_classified_as_limited():
    """GitHub 匿名限流常以 403 + body 写明 rate limit；应识别为限流而非纯鉴权。"""
    exc = _make_http_error(
        code=403,
        msg="Forbidden",
        body=b'{"message": "API rate limit exceeded"}',
    )
    msg = SkillService._describe_http_error(exc)
    assert "限流" in msg


def test_describe_http_error_403_plain_is_access_denied():
    exc = _make_http_error(code=403, msg="Forbidden")
    msg = SkillService._describe_http_error(exc)
    assert "403" in msg
    assert "拒绝访问" in msg


def test_describe_http_error_404_hints_raw_link():
    exc = _make_http_error(code=404, msg="Not Found")
    msg = SkillService._describe_http_error(exc)
    assert "404" in msg
    assert "Raw" in msg


def test_import_from_url_routes_http_error_through_describer(monkeypatch):
    """#609 集成视角：urlopen 抛 HTTPError(429) 时，错误经 _describe_http_error
    转成限流人话，而不是被旧 URLError 分支吞成「URL 下载失败: Too Many Requests」。"""

    monkeypatch.setattr(SkillService, "_validate_import_url", staticmethod(lambda url: None))
    monkeypatch.setattr(
        SkillService,
        "_find_skill_by_import_source_url",
        classmethod(lambda cls, **kwargs: None),
    )

    def _raise_http_error(req, timeout=None):
        raise _make_http_error(
            code=429,
            msg="Too Many Requests",
            body=b'{"message": "API rate limit exceeded"}',
        )

    import urllib.request as _urllib_request

    monkeypatch.setattr(_urllib_request, "urlopen", _raise_http_error)

    with pytest.raises(SkillServiceError, match="限流"):
        SkillService._import_from_url(
            user_id="22222222-2222-2222-2222-222222222222",
            url="https://example.com/SKILL.md",
        )


def test_import_rejects_plain_markdown_without_skill_md():
    with pytest.raises(SkillServiceError, match="必须包含 SKILL.md"):
        SkillService._import_from_files(
            user_id="22222222-2222-2222-2222-222222222222",
            files=[{"path": "README.md", "content": "# Just readme"}],
        )


def test_import_rejects_skill_md_without_frontmatter():
    with pytest.raises(SkillServiceError, match="必须包含 frontmatter"):
        SkillService._import_from_files(
            user_id="22222222-2222-2222-2222-222222222222",
            files=[{"path": "SKILL.md", "content": "# Demo"}],
        )


@pytest.mark.parametrize(
    "content, expected_msg",
    [
        ("---\ndescription: demo\n---\n\n# Demo\n", "缺少 name"),
        ("---\nname: demo\n---\n\n# Demo\n", "缺少 description"),
    ],
)
def test_import_rejects_missing_required_frontmatter_fields(content, expected_msg):
    with pytest.raises(SkillServiceError, match=expected_msg):
        SkillService._import_from_files(
            user_id="22222222-2222-2222-2222-222222222222",
            files=[{"path": "SKILL.md", "content": content}],
        )


def test_import_accepts_missing_version_and_preserves_skill_md(tmp_path, monkeypatch):
    captured: dict = {}
    republished: dict = {}
    owner_user_id = "22222222-2222-2222-2222-222222222222"

    def _fake_create_user_skill(**kwargs):
        captured.update(kwargs)
        # : _primary_sandbox_dir_for_skill 读 owner_user_id / visibility /
        # organization_id / slug 决定沙盒目录（users/{owner}/skills/{slug}）。
        return SimpleNamespace(
            slug="demo-skill",
            skill_id="sk-1",
            owner_user_id=owner_user_id,
            organization_id=None,
            visibility="private",
        )

    def _fake_republish(**kwargs):
        republished.update(kwargs)

    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(SkillService, "create_user_skill", staticmethod(_fake_create_user_skill))
    monkeypatch.setattr(
        SkillService,
        "_publish_initial_skill_files",
        classmethod(lambda cls, **kwargs: _fake_republish(**kwargs)),
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

    skill, _nf, already_exists = SkillService._import_from_files(
        user_id=owner_user_id,
        files=[{
            "path": "SKILL.md",
            "content": "---\nname: demo-skill\ndescription: demo desc\n---\n\n# Demo\n",
        }],
    )

    assert already_exists is False
    assert skill.slug == "demo-skill"
    assert captured["name"] == "demo skill"
    assert captured["description"] == "demo desc"
    assert captured["category"] == ""
    assert captured.get("skip_initial_publish") is True
    assert republished["files"][0]["path"] == "SKILL.md"
    assert "# Demo" in republished["files"][0]["content"]

    # ：sandbox 双层布局 = users/{owner}/skills/{slug}
    skill_md_path = os.path.realpath(
        os.path.join(str(tmp_path), "users", owner_user_id, "skills", "demo-skill", "SKILL.md"),
    )
    with open(skill_md_path, "r", encoding="utf-8") as fh:
        written = fh.read()
    assert written == "---\nname: demo-skill\ndescription: demo desc\n---\n\n# Demo\n"


def test_import_preserves_valid_tabtin_category(tmp_path, monkeypatch):
    captured: dict = {}

    def _fake_create_user_skill(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            slug="categorized-skill",
            skill_id="sk-2",
            owner_user_id="22222222-2222-2222-2222-222222222222",
            organization_id=None,
            visibility="private",
        )

    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(SkillService, "create_user_skill", staticmethod(_fake_create_user_skill))
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

    SkillService._import_from_files(
        user_id="22222222-2222-2222-2222-222222222222",
        files=[{
            "path": "SKILL.md",
            "content": (
                "---\n"
                "name: categorized-skill\n"
                "description: demo desc\n"
                "metadata:\n"
                "  tabtin:\n"
                "    category: developer\n"
                "---\n\n"
                "# Demo\n"
            ),
        }],
    )

    assert captured["category"] == "developer"


def test_import_ignores_unknown_category(tmp_path, monkeypatch):
    captured: dict = {}

    def _fake_create_user_skill(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            slug="uncategorized-skill",
            skill_id="sk-3",
            owner_user_id="22222222-2222-2222-2222-222222222222",
            organization_id=None,
            visibility="private",
        )

    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(SkillService, "create_user_skill", staticmethod(_fake_create_user_skill))
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

    SkillService._import_from_files(
        user_id="22222222-2222-2222-2222-222222222222",
        files=[{
            "path": "SKILL.md",
            "content": (
                "---\n"
                "name: uncategorized-skill\n"
                "description: demo desc\n"
                "metadata:\n"
                "  tabtin:\n"
                "    category: third-party-special\n"
                "---\n\n"
                "# Demo\n"
            ),
        }],
    )

    assert captured["category"] == ""


def test_import_keeps_skill_when_republish_fails(tmp_path, monkeypatch):
    """sandbox 已写入后云端发布失败：保留 Skill，不 cleanup（对齐 create 初始发布）。"""
    monkeypatch.setenv("TABTIN_SANDBOX_ROOT", str(tmp_path))

    owner_user_id = "22222222-2222-2222-2222-222222222222"
    skill = SimpleNamespace(
        skill_id="sk-fail",
        slug="demo-skill",
        owner_user_id=owner_user_id,
        organization_id=None,
        visibility="private",
    )
    skill.refresh_from_db = lambda: None
    cleaned: dict = {}

    class _FakeSPVQS:
        def filter(self, **kwargs):
            return self

        def exclude(self, **kwargs):
            return self

        def values_list(self, *args, **kwargs):
            return []

    monkeypatch.setattr(
        "apps.skills.models.SkillPublishedVersion.objects",
        _FakeSPVQS(),
    )
    monkeypatch.setattr(
        SkillService,
        "create_user_skill",
        staticmethod(lambda **kwargs: skill),
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
    monkeypatch.setattr(
        "apps.skills.services.semver_utils.suggest_next_semver",
        lambda labels: "0.0.1",
    )
    monkeypatch.setattr(
        SkillService,
        "publish_skill",
        classmethod(lambda cls, **kwargs: (_ for _ in ()).throw(RuntimeError("publish boom"))),
    )
    monkeypatch.setattr(
        SkillService,
        "_cleanup_failed_import_skill",
        classmethod(lambda cls, **kwargs: cleaned.update(kwargs)),
    )

    out, _nf, already_exists = SkillService._import_from_files(
        user_id=owner_user_id,
        files=[{
            "path": "SKILL.md",
            "content": "---\nname: demo-skill\ndescription: demo desc\n---\n\n# Demo\n",
        }],
    )

    assert already_exists is False
    assert out is skill
    assert cleaned == {}
    # ：sandbox 双层布局 = users/{owner}/skills/{slug}
    skill_md = tmp_path / "users" / owner_user_id / "skills" / "demo-skill" / "SKILL.md"
    assert skill_md.is_file()


def test_publish_initial_skill_files_bumps_and_publishes(monkeypatch):
    """首发从 SkillPublishedVersion 收集 label，禁止读 skill.latest_version_label。"""
    published: dict = {}

    skill = SimpleNamespace(
        skill_id="sk-1",
        slug="demo-skill",
        organization_id=None,
    )
    skill.refresh_from_db = lambda: None

    class _FakeSPVQS:
        def filter(self, **kwargs):
            return self

        def exclude(self, **kwargs):
            return self

        def values_list(self, *args, **kwargs):
            return ["0.0.1"]

    monkeypatch.setattr(
        "apps.skills.models.SkillPublishedVersion.objects",
        _FakeSPVQS(),
    )
    monkeypatch.setattr(
        "apps.skills.services.semver_utils.suggest_next_semver",
        lambda labels: "0.0.2" if labels else "0.0.1",
    )
    monkeypatch.setattr(
        SkillService,
        "publish_skill",
        classmethod(lambda cls, **kwargs: published.update(kwargs) or {"ok": True}),
    )

    # 无 latest_version_label 属性的对象也能成功（回归 ）
    assert not hasattr(skill, "latest_version_label")

    SkillService._publish_initial_skill_files(
        skill=skill,
        user_id="u1",
        files=[{"path": "SKILL.md", "content": "# Real"}],
        change_note="import",
    )

    assert published["version_label"] == "0.0.2"
    assert published["skill_id"] == "sk-1"
    assert published["files"][0]["content"] == "# Real"
    assert published["change_note"] == "import"


def test_publish_initial_first_version_is_001(monkeypatch):
    published: dict = {}
    skill = SimpleNamespace(skill_id="sk-new", slug="new-skill", organization_id=None)
    skill.refresh_from_db = lambda: None

    class _EmptySPVQS:
        def filter(self, **kwargs):
            return self

        def exclude(self, **kwargs):
            return self

        def values_list(self, *args, **kwargs):
            return []

    monkeypatch.setattr(
        "apps.skills.models.SkillPublishedVersion.objects",
        _EmptySPVQS(),
    )
    monkeypatch.setattr(
        SkillService,
        "publish_skill",
        classmethod(lambda cls, **kwargs: published.update(kwargs) or {"ok": True}),
    )

    SkillService._publish_initial_skill_files(
        skill=skill,
        user_id="u1",
        files=[{"path": "SKILL.md", "content": "# New"}],
    )
    assert published["version_label"] == "0.0.1"


def test_import_skills_batch_partial_failure_and_enable(monkeypatch):
    """批量：一项成功一项失败；成功项可带 enable_agent_ids。"""
    calls: list = []

    def _fake_import_skill(**kwargs):
        calls.append(kwargs)
        name = (kwargs.get("name") or "")
        if name == "bad":
            raise SkillServiceError("frontmatter broken")
        skill = SimpleNamespace(
            skill_id=f"sk-{name}",
            slug=name or "ok",
            canonical_key=f"user:{name or 'ok'}",
            to_index_entry=lambda: {
                "skill_id": f"sk-{name}",
                "slug": name or "ok",
                "key": f"user:{name or 'ok'}",
                "latest_version_label": "0.0.1",
            },
        )
        return skill, [{"path": "SKILL.md", "content": "# ok"}], False, list(
            kwargs.get("enable_agent_ids") or [],
        )

    monkeypatch.setattr(SkillService, "import_skill", staticmethod(_fake_import_skill))
    monkeypatch.setattr(
        "apps.skills.services.registry_service.SkillsRegistryService.resolve_agent_skill_state",
        staticmethod(lambda _space_id, agent_id=None, user_id=None: {}),
    )

    agent_id = "11111111-1111-1111-1111-111111111111"
    batch = SkillService.import_skills_batch(
        user_id="22222222-2222-2222-2222-222222222222",
        agent_id=agent_id,
        items=[
            {
                "name": "ok-skill",
                "files": [{"path": "SKILL.md", "content": "x"}],
                "enable_agent_ids": [agent_id],
            },
            {"name": "bad", "files": [{"path": "SKILL.md", "content": "y"}]},
        ],
    )

    assert batch["summary"] == {"ok": 1, "failed": 1}
    assert batch["results"][0]["ok"] is True
    assert batch["results"][0]["enabled_agent_ids"] == [agent_id]
    assert batch["results"][0]["skill"]["latest_version_label"] == "0.0.1"
    assert batch["results"][1]["ok"] is False
    assert batch["results"][1]["error"]["code"] == "VALIDATION_ERROR"
    assert calls[0]["enable_agent_ids"] == [agent_id]


def test_import_skills_batch_rejects_over_limit():
    with pytest.raises(SkillServiceError, match="最多导入"):
        SkillService.import_skills_batch(
            user_id="22222222-2222-2222-2222-222222222222",
            items=[{"files": []}] * (SkillService._MAX_IMPORT_ITEMS + 1),
        )
