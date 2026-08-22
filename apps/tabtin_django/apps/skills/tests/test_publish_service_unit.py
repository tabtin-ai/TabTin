import io
import zipfile
import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.skills.services.bundle_validator import BundleValidationError, PackageEntry
from apps.skills.services.publish_service import (
    SkillPublishError,
    SkillPublishService,
    _merge_display_name_preserving_suffix,
    _strip_skill_md_versions_from_entries,
)


def _build_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


def _mock_known_skill(*, name: str, description: str = "old desc") -> MagicMock:
    skill = MagicMock()
    skill.name = name
    skill.description = description
    skill.agents_json = []
    skill.latest_version_seq = 0
    skill.package_id = None
    skill.install_content_hash = ""
    skill.quick_use_json = []
    skill.skill_id = uuid.uuid4()
    skill.slug = "demo-skill"
    skill.canonical_key = f"user:{uuid.uuid4()}:demo-skill"
    skill.visibility = "private"
    return skill


class SkillPublishServiceUnitTest(SimpleTestCase):
    def test_publish_from_zip_wraps_bundle_validation_error(self):
        zip_bytes = _build_zip({
            "SKILL.md": b"---\nname: demo\n---\n\n# Demo\n",
            "assets/bad.exe": b"MZ",
        })

        with self.assertRaises(SkillPublishError) as ctx:
            SkillPublishService.publish_from_zip(zip_bytes)

        self.assertIs(type(ctx.exception), SkillPublishError)
        self.assertIsInstance(ctx.exception.__cause__, BundleValidationError)
        self.assertIn("不允许的文件类型 .exe", str(ctx.exception))

    def test_publish_from_zip_requires_explicit_version_label_even_with_skill_md_version(self):
        zip_bytes = _build_zip({
            "SKILL.md": (
                b"---\n"
                b"name: demo\n"
                b"description: demo\n"
                b"metadata:\n"
                b"  version: 9.9.9\n"
                b"---\n\n"
                b"# Demo\n"
            ),
        })

        with self.assertRaises(SkillPublishError) as ctx:
            SkillPublishService.publish_from_zip(zip_bytes)

        self.assertIn("缺少发布版本号 version_label", str(ctx.exception))

    def test_publish_entries_strip_skill_md_file_version(self):
        entries = _strip_skill_md_versions_from_entries([
            PackageEntry(
                file_path="SKILL.md",
                content=(
                    "---\n"
                    "name: demo\n"
                    "version: 0.1.0\n"
                    "metadata:\n"
                    "  version: 9.9.9\n"
                    "  tabtin:\n"
                    "    displayName: Demo\n"
                    "---\n\n"
                    "# Demo\n"
                ).encode("utf-8"),
                size=0,
            ),
        ])

        text = entries[0].content.decode("utf-8")
        self.assertNotIn("version:", text)
        self.assertIn("displayName: Demo", text)
        self.assertEqual(entries[0].size, len(entries[0].content))

    def test_republish_syncs_display_name_to_skill_name(self):
        """#5172：编辑 displayName 再发布后，Skill.name（列表展示名）必须更新。"""
        zip_bytes = _build_zip({
            "SKILL.md": (
                b"---\n"
                b"name: demo-skill\n"
                b"description: new desc\n"
                b"metadata:\n"
                b"  tabtin:\n"
                b"    displayName: Renamed Title\n"
                b"---\n\n"
                b"# Body\n"
            ),
        })
        known = _mock_known_skill(name="Old Title", description="old desc")
        package_id = uuid.uuid4()

        with patch(
            "apps.skills.services.publish_service._publish_to_package_registry",
            return_value=("sha256", package_id, 2, "0.0.2", "oss/key"),
        ), patch(
            "apps.skills.services.publish_service._trigger_side_effects",
        ), patch(
            "apps.skills.services.publish_service.SkillPublishedVersion.objects.update_or_create",
        ), patch(
            "apps.skills.services.publish_service._check_organization_membership",
        ):
            result = SkillPublishService.publish_from_zip(
                zip_bytes,
                known_skill=known,
                version_label="0.0.2",
                user_id=uuid.uuid4(),
                organization_id=uuid.uuid4(),
            )

        self.assertIs(result, known)
        self.assertEqual(known.name, "Renamed Title")
        self.assertEqual(known.description, "new desc")
        # 元数据同步会先 save 一次（name/description），发布收尾再 save 一次
        self.assertGreaterEqual(known.save.call_count, 1)
        first_save_kwargs = known.save.call_args_list[0].kwargs
        self.assertIn("name", first_save_kwargs.get("update_fields", []))
        self.assertIn("description", first_save_kwargs.get("update_fields", []))

    def test_republish_does_not_overwrite_name_with_kebab_slug(self):
        """无 displayName 时，不得用 frontmatter kebab name 冲掉已有展示名。"""
        zip_bytes = _build_zip({
            "SKILL.md": (
                b"---\n"
                b"name: demo-skill\n"
                b"description: still human\n"
                b"---\n\n"
                b"# Body\n"
            ),
        })
        known = _mock_known_skill(name="Human Title", description="old")
        package_id = uuid.uuid4()

        with patch(
            "apps.skills.services.publish_service._publish_to_package_registry",
            return_value=("sha256", package_id, 2, "0.0.2", "oss/key"),
        ), patch(
            "apps.skills.services.publish_service._trigger_side_effects",
        ), patch(
            "apps.skills.services.publish_service.SkillPublishedVersion.objects.update_or_create",
        ), patch(
            "apps.skills.services.publish_service._check_organization_membership",
        ):
            SkillPublishService.publish_from_zip(
                zip_bytes,
                known_skill=known,
                version_label="0.0.2",
                user_id=uuid.uuid4(),
                organization_id=uuid.uuid4(),
            )

        self.assertEqual(known.name, "Human Title")
        self.assertEqual(known.description, "still human")

    def test_merge_display_name_preserves_copy_suffix(self):
        self.assertEqual(
            _merge_display_name_preserving_suffix("旧名(我的副本)", "新名"),
            "新名(我的副本)",
        )
        self.assertEqual(
            _merge_display_name_preserving_suffix("旧名（组织共享）", "新名"),
            "新名（组织共享）",
        )
        self.assertEqual(
            _merge_display_name_preserving_suffix("旧名(我的副本)", "新名(我的副本)"),
            "新名(我的副本)",
        )
        self.assertEqual(
            _merge_display_name_preserving_suffix("普通名", "新名"),
            "新名",
        )

    def test_republish_preserves_copy_suffix_when_syncing_display_name(self):
        """fork 副本 DB 名带「(我的副本)」，再发布不得冲掉后缀。"""
        zip_bytes = _build_zip({
            "SKILL.md": (
                b"---\n"
                b"name: demo-skill\n"
                b"description: copy desc\n"
                b"metadata:\n"
                b"  tabtin:\n"
                b"    displayName: Renamed Copy\n"
                b"---\n\n"
                b"# Body\n"
            ),
        })
        known = _mock_known_skill(name="Old Title(我的副本)", description="old")
        package_id = uuid.uuid4()

        with patch(
            "apps.skills.services.publish_service._publish_to_package_registry",
            return_value=("sha256", package_id, 2, "0.0.2", "oss/key"),
        ), patch(
            "apps.skills.services.publish_service._trigger_side_effects",
        ), patch(
            "apps.skills.services.publish_service.SkillPublishedVersion.objects.update_or_create",
        ), patch(
            "apps.skills.services.publish_service._check_organization_membership",
        ):
            SkillPublishService.publish_from_zip(
                zip_bytes,
                known_skill=known,
                version_label="0.0.2",
                user_id=uuid.uuid4(),
                organization_id=uuid.uuid4(),
            )

        self.assertEqual(known.name, "Renamed Copy(我的副本)")
