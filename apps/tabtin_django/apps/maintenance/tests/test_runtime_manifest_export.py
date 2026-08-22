from __future__ import annotations

from tempfile import TemporaryDirectory
from pathlib import Path

from django.test import SimpleTestCase

from tabtin.runtime.exporters import export_runtime_manifest_markdown


class RuntimeManifestExportTests(SimpleTestCase):
    def test_export_runtime_manifest_generates_markdown(self):
        with TemporaryDirectory() as tmp:
            path = export_runtime_manifest_markdown(output_path=Path(tmp) / "runtime.md")
            text = path.read_text(encoding="utf-8")

        self.assertIn("# Runtime Task / Worker Registry", text)
        self.assertIn("## 2. Queue Registry", text)
        self.assertIn("worker-data-ai", text)

