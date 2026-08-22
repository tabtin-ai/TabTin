"""tabdoc.0025–0030：HtmlArtifactShare 稳定 block_id 切分的 PG 场景。

0025：加可空 block_id
0026：仅回填显式、唯一、非 auto_* 的 blockId；orphan / 歧义 / 位置别名停用
0027：删 file_record、block_id NOT NULL、条件唯一约束
0028：幂等缩短索引名
0029：停用已落库的不稳定 active share（数据步）
0030：CheckConstraint htmlashare_active_stable_block（DDL 步， 拆分）

验证：
- 显式唯一 blockId 份额保留
- 缺失 blockId / auto_* / 重复 fileId / 重复 blockId 均停用
- description_json 不被迁移改写
- 0028→0030 修复已落库的位置别名并落约束
"""

from __future__ import annotations

import hashlib
from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


def _file_key_hash(file_key: str) -> str:
    return hashlib.sha256(file_key.encode("utf-8")).hexdigest()


def _create_file_record(FileRecord, *, file_id, org_id, name: str):
    file_key = f"tabdoc/html/{file_id.hex}.html"
    return FileRecord.objects.create(
        id=file_id,
        file_name=name,
        file_key=file_key,
        file_key_hash=_file_key_hash(file_key),
        file_path="/tabdoc/html/",
        file_size=16,
        file_type="document",
        mime_type="text/html",
        file_extension="html",
        file_hash=file_id.hex,
        bucket_name="test-bucket",
        status="completed",
        organization_id=str(org_id),
        is_public=False,
        access_url=f"https://cdn.example.com/{name}",
    )


class HtmlArtifactShareBlockIdentityScenario(PostgresMigrationScenarioTestCase):
    """0024 → 0030 全链路：含 orphan / 歧义 / 重复 blockId。"""

    __test__ = True

    app_label = "tabdoc"
    migrate_from = "0024_html_artifact_share"
    migrate_to = "0030_html_artifact_share_active_stable_block_constraint"

    def test_block_identity_cutover(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Document = old_apps.get_model("tabdoc", "Document")
        HtmlArtifactShare = old_apps.get_model("tabdoc", "HtmlArtifactShare")
        FileRecord = old_apps.get_model("oss", "FileRecord")

        self.user_id = uuid4()
        self.org_id = uuid4()
        self.space_id = uuid4()
        self.doc_id = uuid4()
        self.file_ok_id = uuid4()
        self.file_ambiguous_id = uuid4()
        self.file_orphan_id = uuid4()
        self.file_dup_block_id = uuid4()
        self.share_ok_id = uuid4()
        self.share_ambiguous_id = uuid4()
        self.share_orphan_id = uuid4()
        self.share_dup_block_id = uuid4()
        self.block_id = f"html-block-{self.doc_id.hex[:8]}"
        self.dup_block_id = f"dup-block-{self.doc_id.hex[:8]}"

        User.objects.create(
            id=self.user_id,
            username=f"html-mig-{self.user_id.hex[:8]}",
            email=f"html-mig-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )

        file_ok = _create_file_record(
            FileRecord, file_id=self.file_ok_id, org_id=self.org_id, name="ok.html"
        )
        file_ambiguous = _create_file_record(
            FileRecord,
            file_id=self.file_ambiguous_id,
            org_id=self.org_id,
            name="ambiguous.html",
        )
        file_orphan = _create_file_record(
            FileRecord,
            file_id=self.file_orphan_id,
            org_id=self.org_id,
            name="orphan.html",
        )
        file_dup = _create_file_record(
            FileRecord,
            file_id=self.file_dup_block_id,
            org_id=self.org_id,
            name="dup.html",
        )

        self.seed_pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": self.block_id,
                        "fileId": str(self.file_ok_id),
                        "title": "ok",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": "block-a",
                        "fileId": str(self.file_ambiguous_id),
                        "title": "a",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": "block-b",
                        "fileId": str(self.file_ambiguous_id),
                        "title": "b",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        # Missing blockId — must never become auto_0 on a share.
                        "fileId": str(self.file_orphan_id),
                        "title": "orphan",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": self.dup_block_id,
                        "fileId": str(self.file_dup_block_id),
                        "title": "dup-1",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": self.dup_block_id,
                        "fileId": str(uuid4()),
                        "title": "dup-2",
                    },
                },
            ],
        }

        doc = Document.objects.create(
            id=self.doc_id,
            organization_id=self.org_id,
            space_id=self.space_id,
            owner_id=self.user_id,
            title="html artifact share migration doc",
            description_json=self.seed_pm_json,
        )

        HtmlArtifactShare.objects.create(
            id=self.share_ok_id,
            document=doc,
            file_record=file_ok,
            share_id=f"ok{self.share_ok_id.hex[:8]}",
            visibility="public",
            is_active=True,
            created_by_id=self.user_id,
        )
        HtmlArtifactShare.objects.create(
            id=self.share_ambiguous_id,
            document=doc,
            file_record=file_ambiguous,
            share_id=f"amb{self.share_ambiguous_id.hex[:8]}",
            visibility="organization",
            organization_id=str(self.org_id),
            is_active=True,
            created_by_id=self.user_id,
        )
        HtmlArtifactShare.objects.create(
            id=self.share_orphan_id,
            document=doc,
            file_record=file_orphan,
            share_id=f"orp{self.share_orphan_id.hex[:8]}",
            visibility="public",
            is_active=True,
            created_by_id=self.user_id,
        )
        HtmlArtifactShare.objects.create(
            id=self.share_dup_block_id,
            document=doc,
            file_record=file_dup,
            share_id=f"dup{self.share_dup_block_id.hex[:8]}",
            visibility="public",
            is_active=True,
            created_by_id=self.user_id,
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        HtmlArtifactShare = new_apps.get_model("tabdoc", "HtmlArtifactShare")
        Document = new_apps.get_model("tabdoc", "Document")

        self.assertFalse(
            any(f.name == "file_record" for f in HtmlArtifactShare._meta.fields),
            "0027 后应删除 file_record 身份字段",
        )

        ok = HtmlArtifactShare.objects.get(id=self.share_ok_id)
        self.assertTrue(ok.is_active)
        self.assertEqual(ok.block_id, self.block_id)

        for share_id in (
            self.share_ambiguous_id,
            self.share_orphan_id,
            self.share_dup_block_id,
        ):
            row = HtmlArtifactShare.objects.get(id=share_id)
            self.assertFalse(row.is_active, f"share {share_id} should be deactivated")

        # Migration must not rewrite document PM JSON (collab binary remains SoT).
        doc = Document.objects.get(id=self.doc_id)
        self.assertEqual(doc.description_json, self.seed_pm_json)
        orphan_attrs = doc.description_json["content"][3]["attrs"]
        self.assertNotIn("blockId", orphan_attrs)

        # No active share may carry a position alias.
        auto_active = HtmlArtifactShare.objects.filter(
            is_active=True,
            block_id__startswith="auto_",
        ).count()
        self.assertEqual(auto_active, 0)

        row = self.fetchone(
            """
            SELECT 1
            FROM pg_indexes
            WHERE indexname = %s
            """,
            ["htmlashare_one_active_per_block"],
        )
        self.assertIsNotNone(row, "条件唯一约束 htmlashare_one_active_per_block 应已落库")

        constraint = self.fetchone(
            """
            SELECT 1
            FROM pg_constraint
            WHERE conname = %s
            """,
            ["htmlashare_active_stable_block"],
        )
        self.assertIsNotNone(
            constraint,
            "CheckConstraint htmlashare_active_stable_block 应已落库",
        )

        null_ok = self.fetchone(
            """
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_name = 'tabdoc_html_artifact_share'
              AND column_name = 'block_id'
            """,
        )
        self.assertIsNotNone(null_ok)
        self.assertEqual(null_ok[0], "NO")


class HtmlArtifactShareAutoAliasRepairScenario(PostgresMigrationScenarioTestCase):
    """0028 → 0030：修复旧 0026 已写入的 auto_* active share 并落约束。"""

    __test__ = True

    app_label = "tabdoc"
    migrate_from = "0028_html_artifact_share_rename_block_index"
    migrate_to = "0030_html_artifact_share_active_stable_block_constraint"

    def test_auto_alias_shares_deactivated(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Document = old_apps.get_model("tabdoc", "Document")
        HtmlArtifactShare = old_apps.get_model("tabdoc", "HtmlArtifactShare")

        self.user_id = uuid4()
        self.org_id = uuid4()
        self.space_id = uuid4()
        self.doc_id = uuid4()
        self.share_auto_id = uuid4()
        self.share_stable_id = uuid4()
        self.stable_block = f"stable-{self.doc_id.hex[:8]}"
        self.file_id = uuid4()

        User.objects.create(
            id=self.user_id,
            username=f"html-auto-{self.user_id.hex[:8]}",
            email=f"html-auto-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )

        doc = Document.objects.create(
            id=self.doc_id,
            organization_id=self.org_id,
            space_id=self.space_id,
            owner_id=self.user_id,
            title="auto alias repair doc",
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            "blockId": self.stable_block,
                            "fileId": str(self.file_id),
                            "title": "stable",
                        },
                    },
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            # Still missing — simulates pre-heal historical block.
                            "fileId": str(uuid4()),
                            "title": "orphan",
                        },
                    },
                ],
            },
        )

        # Legacy bad state: old 0026 persisted a position alias.
        HtmlArtifactShare.objects.create(
            id=self.share_auto_id,
            document=doc,
            block_id="auto_0",
            share_id=f"aut{self.share_auto_id.hex[:8]}",
            visibility="public",
            is_active=True,
            created_by_id=self.user_id,
        )
        HtmlArtifactShare.objects.create(
            id=self.share_stable_id,
            document=doc,
            block_id=self.stable_block,
            share_id=f"stb{self.share_stable_id.hex[:8]}",
            visibility="public",
            is_active=True,
            created_by_id=self.user_id,
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        HtmlArtifactShare = new_apps.get_model("tabdoc", "HtmlArtifactShare")

        auto_share = HtmlArtifactShare.objects.get(id=self.share_auto_id)
        self.assertFalse(auto_share.is_active)
        # Keep original value for audit.
        self.assertEqual(auto_share.block_id, "auto_0")

        stable = HtmlArtifactShare.objects.get(id=self.share_stable_id)
        self.assertTrue(stable.is_active)
        self.assertEqual(stable.block_id, self.stable_block)

        constraint = self.fetchone(
            """
            SELECT 1
            FROM pg_constraint
            WHERE conname = %s
            """,
            ["htmlashare_active_stable_block"],
        )
        self.assertIsNotNone(constraint)
