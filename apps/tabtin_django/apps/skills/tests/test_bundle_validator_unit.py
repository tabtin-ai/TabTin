import io
import zipfile

from django.test import SimpleTestCase

from apps.skills.services.bundle_validator import SkillBundleValidator


def _build_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


class SkillBundleValidatorUnitTest(SimpleTestCase):
    def test_accepts_svg_and_png_assets(self):
        zip_bytes = _build_zip({
            "SKILL.md": b"---\nname: demo\n---\n\n# Demo\n",
            "assets/icon.svg": b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
            "assets/logo.png": b"\x89PNG\r\n\x1a\n",
        })

        entries = SkillBundleValidator.validate_and_extract(zip_bytes)
        paths = {entry.file_path for entry in entries}

        self.assertIn("SKILL.md", paths)
        self.assertIn("assets/icon.svg", paths)
        self.assertIn("assets/logo.png", paths)

    def test_skips_all_dot_entries_instead_of_failing(self):
        zip_bytes = _build_zip({
            "SKILL.md": b"---\nname: demo\n---\n\n# Demo\n",
            ".gitignore": b"node_modules/\n",
            ".eslintrc.js": b"module.exports = {}\n",
            ".env.example": b"KEY=\n",
            "references/notes.md": b"# notes\n",
            "references/.keep": b"",
            ".git/HEAD": b"ref: refs/heads/main\n",
            "node_modules/pkg/index.js": b"export {}\n",
        })

        entries = SkillBundleValidator.validate_and_extract(zip_bytes)
        paths = {entry.file_path for entry in entries}

        self.assertEqual(
            paths,
            {"SKILL.md", "references/notes.md"},
        )
