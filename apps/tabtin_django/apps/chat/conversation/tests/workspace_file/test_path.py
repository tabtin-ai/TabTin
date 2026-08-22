from django.test import SimpleTestCase

from apps.chat.conversation.services.workspace_file import (
    basename_of,
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)


class WorkspaceFilePathTests(SimpleTestCase):
    def test_canonicalize_normalizes_dot_segments(self):
        self.assertEqual(
            canonicalize_artifact_relative_path("./artifacts/report.xlsx"),
            "artifacts/report.xlsx",
        )

    def test_canonicalize_rejects_absolute_and_scheme(self):
        self.assertIsNone(canonicalize_artifact_relative_path("/etc/passwd"))
        self.assertIsNone(canonicalize_artifact_relative_path("~/secret.txt"))
        self.assertIsNone(canonicalize_artifact_relative_path("C:\\Users\\a.txt"))
        self.assertIsNone(canonicalize_artifact_relative_path("tabtin://resource/file/a.txt"))
        self.assertIsNone(canonicalize_artifact_relative_path("../escape.txt"))

    def test_deliverable_filter(self):
        self.assertTrue(is_deliverable_relative_path("artifacts/a.xlsx"))
        self.assertFalse(is_deliverable_relative_path("tmp/a.xlsx"))
        self.assertFalse(is_deliverable_relative_path(".hidden/a.xlsx"))
        self.assertFalse(is_deliverable_relative_path("artifacts/README"))

    def test_basename(self):
        self.assertEqual(basename_of("artifacts/a.xlsx"), "a.xlsx")
