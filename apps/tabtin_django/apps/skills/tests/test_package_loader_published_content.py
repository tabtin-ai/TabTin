"""Skill 详情读取已发布 SKILL.md 快照的回归测试。"""

from unittest.mock import patch
from uuid import uuid4

from django.test import TestCase

from apps.services.package_registry.models import Package, PackageFile, PackageVersion
from apps.skills.models import Skill
from apps.skills.services.package_loader import SkillPackageLoader


class SkillPackageLoaderPublishedContentTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.owner_id = uuid4()
        self.member_id = uuid4()
        self.organization_id = uuid4()
        self.package = Package.objects.create(
            namespace=f"user-{self.owner_id}",
            name="snapshot-skill",
            organization_id=self.organization_id,
            created_by=self.owner_id,
            latest_version_seq=1,
        )
        self.version = PackageVersion.objects.create(
            package=self.package,
            version_seq=1,
            version_label="1.0.0",
            status=PackageVersion.Status.PUBLISHED,
            created_by=self.owner_id,
        )
        self.skill = Skill.objects.create(
            owner_user_id=self.owner_id,
            slug="snapshot-skill",
            name="Snapshot Skill",
            description="Published description",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=self.organization_id,
            package_id=self.package.id,
            latest_version_seq=1,
        )

    @patch(
        "apps.services.package_registry.services.read_skill_md_content",
        return_value="---\nname: snapshot-skill\n---\n\n# Published body",
    )
    def test_loads_published_skill_md_for_visible_organization_skill(self, read_content):
        package = SkillPackageLoader.load(
            "user:snapshot-skill",
            organization_id=str(self.organization_id),
            requesting_user_id=str(self.member_id),
            database_skill_id=str(self.skill.skill_id),
        )

        self.assertIsNotNone(package)
        self.assertEqual(package.doc_content, "---\nname: snapshot-skill\n---\n\n# Published body")
        read_content.assert_called_once_with(self.package.id, self.version)

    def test_rejects_same_skill_outside_its_organization(self):
        package = SkillPackageLoader.load(
            "user:snapshot-skill",
            organization_id=str(uuid4()),
            requesting_user_id=str(self.member_id),
            database_skill_id=str(self.skill.skill_id),
        )

        self.assertIsNone(package)

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_missing_oss_object_returns_package_without_doc(self, get_oss_service):
        PackageFile.objects.create(
            version=self.version,
            path="SKILL.md",
            file_record_id=uuid4(),
            oss_object_key="package_registry/missing/SKILL.md",
            content_type="text/markdown",
            file_size=12,
            sha256="a" * 64,
        )
        get_oss_service.return_value.download_file.return_value = {
            "success": False,
            "error_code": "FILE_NOT_FOUND",
            "message": "NoSuchKey: The specified key does not exist.",
        }

        package = SkillPackageLoader.load(
            "user:snapshot-skill",
            organization_id=str(self.organization_id),
            requesting_user_id=str(self.member_id),
            database_skill_id=str(self.skill.skill_id),
        )

        self.assertIsNotNone(package)
        self.assertEqual(package.name, "Snapshot Skill")
        self.assertEqual(package.doc_content, "")
