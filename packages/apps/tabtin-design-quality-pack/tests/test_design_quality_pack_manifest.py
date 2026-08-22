"""Design Quality Pack manifest and skill discovery smoke tests."""

import json
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_DIR.parents[2]
MANIFEST_PATH = PACKAGE_DIR / "app.json"
DJANGO_DIR = REPO_ROOT / "apps" / "tabtin_django"

if str(DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(DJANGO_DIR))


@pytest.fixture
def manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def test_manifest_identity(manifest):
    assert manifest["id"] == "tabtin-design-quality-pack"
    assert manifest["distribution"] == "marketplace"
    assert manifest["runtimeBindings"]["skillsProvider"] == "skills:local"
    assert manifest["runtimeBindings"]["toolProvider"] is None
    assert manifest["uiRuntime"] == "none"


def test_declared_skills_have_skill_md(manifest):
    skills = manifest["skills"]
    assert len(skills) == 4
    assert len(set(skills)) == len(skills)

    for rel in skills:
        assert (PACKAGE_DIR / rel / "SKILL.md").is_file(), rel


def test_skills_config_matches_declared_skills(manifest):
    declared_ids = {Path(rel).name for rel in manifest["skills"]}
    configured_ids = set(manifest["skillsConfig"]["entries"])
    assert configured_ids == declared_ids

    for cfg in manifest["skillsConfig"]["entries"].values():
        assert cfg["enabled"] is True


def test_discover_app_skills_smoke(manifest):
    from apps.skills.services.app_package_skills import discover_app_skills

    entries, index, errors = discover_app_skills(str(PACKAGE_DIR), manifest["skills"])

    assert errors == []
    assert len(entries) == 4
    assert len(index) == 4
    assert {item["skill_id"] for item in index} == {Path(rel).name for rel in manifest["skills"]}
    assert all(item.get("display_name") for item in index)
    assert all(item.get("version") == "0.1.0" for item in index)
