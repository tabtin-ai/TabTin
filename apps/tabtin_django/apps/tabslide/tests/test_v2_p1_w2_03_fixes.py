"""
V2 P1 Wave2-03 修复回归测试

- M03: 音频预览 autoplay 需 muted 以遵守浏览器 Autoplay 策略
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]


def _load_preview_service():
    """Load preview_service module with Django dependencies stubbed."""
    stubs = {}
    for mod_name in (
        "django",
        "django.conf",
        "django.conf.settings",
        "rest_framework",
        "channels",
        "asgiref",
    ):
        if mod_name not in sys.modules:
            stubs[mod_name] = types.ModuleType(mod_name)
            sys.modules[mod_name] = stubs[mod_name]

    svc_path = _BASE / "services" / "preview_service.py"
    spec = importlib.util.spec_from_file_location("preview_service", svc_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {svc_path}")
    mod = importlib.util.module_from_spec(spec)
    return mod, svc_path


class TestM03AudioAutoplayMuted(TestCase):
    """M03: 音频 autoplay 需包含 muted 以遵守浏览器策略"""

    def test_audio_autoplay_includes_muted(self):
        """_render_audio_element with autoplay=True must produce 'autoplay muted'"""
        svc_path = _BASE / "services" / "preview_service.py"
        src = svc_path.read_text(encoding="utf-8")

        self.assertIn(
            'autoplay muted',
            src,
            "Audio autoplay should include 'muted' to comply with browser autoplay policy",
        )

    def test_audio_autoplay_not_bare(self):
        """_render_audio_element must NOT emit bare 'autoplay' without muted"""
        svc_path = _BASE / "services" / "preview_service.py"
        src = svc_path.read_text(encoding="utf-8")

        func_match = src[src.index("def _render_audio_element"):]
        func_end = func_match.index("\n\n")
        func_body = func_match[:func_end]

        autoplay_line = [
            line for line in func_body.splitlines()
            if "autoplay_attr" in line and "autoplay" in line and "el.get" in line
        ]
        self.assertTrue(len(autoplay_line) > 0, "Should have autoplay_attr assignment")
        self.assertIn("muted", autoplay_line[0])

    def test_video_autoplay_also_has_muted(self):
        """_render_video_element autoplay should also include muted (consistency check)"""
        svc_path = _BASE / "services" / "preview_service.py"
        src = svc_path.read_text(encoding="utf-8")

        func_start = src.index("def _render_video_element")
        func_body = src[func_start:func_start + 500]
        autoplay_line = [
            line for line in func_body.splitlines()
            if "autoplay_attr" in line and "autoplay" in line
        ]
        self.assertTrue(len(autoplay_line) > 0)
        self.assertIn("muted", autoplay_line[0])
