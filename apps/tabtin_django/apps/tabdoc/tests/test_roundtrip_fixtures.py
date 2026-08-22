"""Round-trip stability tests: TS fixture ⇄ Python markdown_exchange.

Loads the 23 shared fixtures from packages/doc-editor and verifies that the
Python backend's pm_json_to_markdown / markdown_to_pm_json pair is
**round-trip stable** — converting once may lose features the backend doesn't
support (e.g. textStyle, emoji, colspan), but a second pass must produce
identical Markdown.

Fixture schema (JSON):
    name: str
    description: str
    pmJson: dict           — ProseMirror JSON document
    expectedMarkdown: str  — (optional) canonical Markdown from TS frontend
    invalidMarkdown: list  — (optional) Markdown rejected by both TS and Python
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from typing import Any

from apps.tabdoc.services.markdown_exchange import (
    markdown_to_pm_json,
    pm_json_to_markdown,
)

FIXTURES_DIR = (
    Path(__file__).resolve().parents[5]
    / "packages"
    / "doc-editor"
    / "src"
    / "converters"
    / "__tests__"
    / "fixtures"
)


def _load_fixtures() -> list[dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []
    if not FIXTURES_DIR.is_dir():
        return fixtures
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data["_file"] = path.name
        fixtures.append(data)
    return fixtures


_ALL_FIXTURES = _load_fixtures()

_KNOWN_LOSSY_FIXTURES = {
    "text-style-highlight",
    "image-with-dimensions",
    "image-with-title",
    "emoji-surrogate",
    "table-html-merged",
    "inline-marks-combo",
}


class RoundtripFixtureTests(unittest.TestCase):
    """Parametric round-trip stability tests over shared fixtures."""

    def _assert_roundtrip_stable(self, fixture: dict[str, Any]) -> None:
        """pm → md → pm → md  ⇒  md₁ == md₂"""
        pm_json = fixture["pmJson"]
        md1 = pm_json_to_markdown(pm_json)
        pm2 = markdown_to_pm_json(md1)
        md2 = pm_json_to_markdown(pm2)
        self.assertEqual(
            md2,
            md1,
            f"Round-trip unstable for {fixture['name']!r}:\n"
            f"  md1={md1!r}\n"
            f"  md2={md2!r}",
        )


def _make_roundtrip_test(fixture: dict[str, Any]):
    def test(self: RoundtripFixtureTests) -> None:
        self._assert_roundtrip_stable(fixture)
    return test


def _make_expected_markdown_test(fixture: dict[str, Any]):
    def test(self: RoundtripFixtureTests) -> None:
        pm_json = fixture["pmJson"]
        actual = pm_json_to_markdown(pm_json)
        expected = fixture["expectedMarkdown"]
        self.assertEqual(
            actual,
            expected,
            f"Backend output differs from expectedMarkdown for {fixture['name']!r}:\n"
            f"  actual  ={actual!r}\n"
            f"  expected={expected!r}",
        )
    return test


def _make_invalid_markdown_test(fixture: dict[str, Any]):
    def test(self: RoundtripFixtureTests) -> None:
        for markdown in fixture["invalidMarkdown"]:
            with self.subTest(markdown=markdown):
                with self.assertRaisesRegex(ValueError, "tableId|tabdata"):
                    markdown_to_pm_json(markdown)
    return test


for _fx in _ALL_FIXTURES:
    _safe_name = _fx["name"].replace("-", "_")

    setattr(
        RoundtripFixtureTests,
        f"test_roundtrip_{_safe_name}",
        _make_roundtrip_test(_fx),
    )

    if "expectedMarkdown" in _fx and _fx["name"] not in _KNOWN_LOSSY_FIXTURES:
        setattr(
            RoundtripFixtureTests,
            f"test_expected_md_{_safe_name}",
            _make_expected_markdown_test(_fx),
        )
    if _fx.get("invalidMarkdown"):
        setattr(
            RoundtripFixtureTests,
            f"test_invalid_md_{_safe_name}",
            _make_invalid_markdown_test(_fx),
        )


class RoundtripSmokeTests(unittest.TestCase):
    """Sanity checks to ensure fixture loading works and covers all 23 files."""

    def test_fixture_count(self):
        self.assertEqual(
            len(_ALL_FIXTURES),
            23,
            f"Expected 23 fixtures, found {len(_ALL_FIXTURES)}. "
            f"Dir: {FIXTURES_DIR}",
        )

    def test_all_fixtures_have_pm_json(self):
        for fx in _ALL_FIXTURES:
            self.assertIn(
                "pmJson",
                fx,
                f"Fixture {fx.get('_file')} missing pmJson key",
            )

    def test_known_lossy_are_still_roundtrip_stable(self):
        """Even lossy fixtures must be round-trip stable (info lost once, then stable)."""
        lossy = [fx for fx in _ALL_FIXTURES if fx["name"] in _KNOWN_LOSSY_FIXTURES]
        self.assertTrue(len(lossy) > 0, "No lossy fixtures found")
        for fx in lossy:
            md1 = pm_json_to_markdown(fx["pmJson"])
            pm2 = markdown_to_pm_json(md1)
            md2 = pm_json_to_markdown(pm2)
            self.assertEqual(
                md2,
                md1,
                f"Lossy fixture {fx['name']!r} is round-trip unstable",
            )


if __name__ == "__main__":
    unittest.main()
