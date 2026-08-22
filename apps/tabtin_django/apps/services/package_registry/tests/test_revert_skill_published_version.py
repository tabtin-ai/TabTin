"""#5160：revert 后必须补写 SkillPublishedVersion，否则详情页版本号/历史入口消失。"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.services.package_registry import services
from apps.services.package_registry.models import PackageVersion
from apps.services.package_registry.tests.conftest import (
    apply_eventbus_mock,
    apply_oss_mocks,
    apply_using_db_mock,
    compute_bundle,
    uid,
)
from apps.skills.models import Skill, SkillPublishedVersion
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.models import User


def _ensure_user(user_id: str) -> User:
    user, _ = User.objects.get_or_create(
        id=user_id,
        defaults={
            "email": f"{user_id[:8]}@example.test",
            "nickname": f"u-{user_id[:8]}",
        },
    )
    return user


def _create_org(owner_id: str) -> str:
    _ensure_user(owner_id)
    org = Organization.objects.create(
        name=f"test-wt-{uuid.uuid4().hex[:8]}",
        owner_id=owner_id,
    )
    OrganizationMember.objects.create(
        organization=org, user_id=owner_id, role="owner",
    )
    return str(org.id)


class RevertCreatesSkillPublishedVersionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_org(self.user_id)
        self.pkg = services.create_package(
            namespace=f"rv-spv-{uuid.uuid4().hex[:6]}",
            name="skill-probe",
            organization_id=self.wt_id,
            created_by=self.user_id,
        )
        for char, size, label in (("a", 10, "0.1.0"), ("b", 20, "0.1.1")):
            sha = char * 64
            init = services.init_version(
                package=self.pkg,
                files=[{"path": "SKILL.md", "sha256": sha, "size": size}],
                manifest={"type": "skill", "name": "skill-probe"},
                version_label=label,
                user_id=self.user_id,
            )
            v = PackageVersion.objects.get(id=init["version_id"])
            # Force label onto version row (init may store it)
            if not v.version_label:
                v.version_label = label
                v.save(update_fields=["version_label"])
            bundle = compute_bundle([("SKILL.md", sha)])
            with patch.object(
                services,
                "_upsert_managed_skill_from_finalize",
                return_value={"upserted": False, "reason": "skipped_in_test"},
            ):
                services.finalize_version(
                    package=self.pkg,
                    version=v,
                    bundle_sha256=bundle,
                    init_files=[{"path": "SKILL.md", "sha256": sha, "size": size}],
                    user_id=self.user_id,
                )

        self.skill = Skill.objects.create(
            owner_user_id=self.user_id,
            slug=f"skill-probe-{uuid.uuid4().hex[:6]}",
            name="skill-probe",
            package_id=self.pkg.id,
            latest_version_seq=2,
            visibility=Skill.VISIBILITY_PRIVATE,
        )
        SkillPublishedVersion.objects.create(
            skill=self.skill,
            version_seq=1,
            version_label="0.1.0",
            bundle_sha256="a" * 64,
            published_by=uuid.UUID(self.user_id),
            review_status=SkillPublishedVersion.REVIEW_NOT_REQUIRED,
            quick_use_json=[{"id": "demo", "label": "Demo", "promptTemplate": "hi"}],
            local_content_hash="local-a",
        )
        SkillPublishedVersion.objects.create(
            skill=self.skill,
            version_seq=2,
            version_label="0.1.1",
            bundle_sha256="b" * 64,
            published_by=uuid.UUID(self.user_id),
            review_status=SkillPublishedVersion.REVIEW_NOT_REQUIRED,
            quick_use_json=[{"id": "demo2", "label": "Demo2", "promptTemplate": "yo"}],
            local_content_hash="local-b",
        )

    def test_revert_creates_spv_and_keeps_index_label(self):
        """用户症状：回滚成功后 latest_version_label 变空 → 版本信息/入口消失。"""
        result = services.revert_to_version(
            package=self.pkg,
            target_version_seq=1,
            user_id=self.user_id,
        )
        self.assertEqual(result["new_version_seq"], 3)
        self.assertGreaterEqual(result["synced_skills"], 1)

        self.skill.refresh_from_db()
        self.assertEqual(self.skill.latest_version_seq, 3)

        spv3 = SkillPublishedVersion.objects.filter(
            skill=self.skill, version_seq=3,
        ).first()
        self.assertIsNotNone(spv3, "revert 必须为新 version_seq 创建 SkillPublishedVersion")
        self.assertEqual(spv3.version_label, "0.1.0")
        self.assertEqual(spv3.local_content_hash, "local-a")
        self.assertEqual(spv3.quick_use_json[0]["id"], "demo")

        entry = self.skill.to_index_entry()
        self.assertEqual(entry["latest_version_label"], "0.1.0")
        self.assertTrue(entry["has_published"])
        self.assertEqual(entry["latest_version_seq"], 3)
