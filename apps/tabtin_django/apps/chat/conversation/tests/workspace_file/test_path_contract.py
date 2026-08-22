"""跨端路径契约：与前端 ``turnArtifactPathOps`` 对齐（ / 方案 B）。

用例表须与 Electron
``shared-view/preview/__tests__/pathContract.test.ts`` 保持同构；
改一侧必须改另一侧。
"""

from django.test import SimpleTestCase

from apps.chat.conversation.services.workspace_file import (
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)

# (input, expected_canonical_or_None)
CANONICALIZE_CASES = [
    ("./artifacts/report.xlsx", "artifacts/report.xlsx"),
    ("artifacts/../artifacts/a.md", "artifacts/a.md"),
    ("foo\\bar.txt", "foo/bar.txt"),
    ("/etc/passwd", None),
    ("~/secret.txt", None),
    ("C:\\Users\\a.txt", None),
    ("tabtin://resource/file/a.txt", None),
    ("../escape.txt", None),
    ("", None),
]

# (input, expected_deliverable)
DELIVERABLE_CASES = [
    ("artifacts/a.xlsx", True),
    ("tmp/a.xlsx", False),
    (".hidden/a.xlsx", False),
    ("artifacts/README", False),
    ("artifacts/.env", False),
]


class WorkspaceFilePathContractTests(SimpleTestCase):
    def test_canonicalize_cases_match_frontend_contract(self):
        for raw, expected in CANONICALIZE_CASES:
            with self.subTest(raw=raw):
                self.assertEqual(
                    canonicalize_artifact_relative_path(raw),
                    expected,
                )

    def test_deliverable_cases_match_frontend_contract(self):
        for raw, expected in DELIVERABLE_CASES:
            with self.subTest(raw=raw):
                self.assertEqual(is_deliverable_relative_path(raw), expected)
