"""Prompt 只读 API — v0.1 AdminDash

显式 NO POST/PUT/DELETE — 编辑必须走 Git PR。
"""

import logging
import re
from pathlib import Path
from typing import Optional

from ninja import Router

from apps.i18n.response import success_response
from apps.users.auth.permissions import StaffAuth

from ..scenes.registry import SCENES, get_scene_spec

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Prompts"], auth=StaffAuth())

BUNDLED_DIR = Path(__file__).resolve().parent.parent / "scenes" / "bundled"


def _get_prompt_info(scene_key: str) -> Optional[dict]:
    bundle_dir = BUNDLED_DIR / scene_key
    if not bundle_dir.is_dir():
        return None

    has_system = (bundle_dir / "system.md").exists()
    has_user = (bundle_dir / "user.md").exists()

    system_chars = 0
    if has_system:
        system_chars = len((bundle_dir / "system.md").read_text(encoding="utf-8"))

    template_vars = []
    if has_user:
        content = (bundle_dir / "user.md").read_text(encoding="utf-8")
        template_vars = list(dict.fromkeys(re.findall(r'\{\{\s*(\w+)\s*\}\}', content)))

    frontmatter = {}
    scene_md = bundle_dir / "SCENE.md"
    if scene_md.exists():
        text = scene_md.read_text(encoding="utf-8")
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                try:
                    import yaml
                    frontmatter = yaml.safe_load(parts[1]) or {}
                except Exception:
                    pass

    return {
        "scene_key": scene_key,
        "bundle_path": f"scenes/bundled/{scene_key}/",
        "capability_domain": frontmatter.get("capability_domain", ""),
        "has_system_md": has_system,
        "has_user_template": has_user,
        "system_char_count": system_chars,
        "template_variables": template_vars,
    }


@router.get("/admin/prompts")
def list_prompts(request):
    items = []
    for scene_key, spec in SCENES.items():
        if spec.is_system:
            continue
        info = _get_prompt_info(scene_key)
        if info:
            info["capability_domain"] = info["capability_domain"] or spec.capability_domain
            items.append(info)

    return success_response(data={"prompts": items, "total": len(items)})


@router.get("/admin/prompts/{scene_key}")
def get_prompt_detail(request, scene_key: str):
    from .scenes_router import get_scene_prompt
    return get_scene_prompt(request, scene_key)
