"""PromptRegistry — 全量加载器 + 渲染器。

Django startup 时一次性扫描 scenes/bundled/ 把所有 bundle 加载到内存。

"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

BUNDLED_DIR = Path(__file__).resolve().parent.parent / "scenes" / "bundled"


@dataclass(frozen=True)
class TemplateVariableSpec:
    name: str
    type: str
    required: bool
    description: str = ""
    max_length: int | None = None


@dataclass(frozen=True)
class PromptBundle:
    """SCENE 目录加载后的内存表示。frozen=True 保证启动后不可变。"""
    scene_key: str
    system_text: str | None = None
    system_variants: Mapping[str, str] = field(default_factory=dict)
    user_template: str | None = None
    user_static: str | None = None
    template_variables: tuple[TemplateVariableSpec, ...] = ()
    bundle_dir: Path | None = None
    version_hash: str | None = None


@dataclass(frozen=True)
class RenderedPrompt:
    system: str
    user: str
    default_params: Mapping[str, Any]
    bundle: PromptBundle


class PromptRegistry:
    _bundles: dict[str, PromptBundle] = {}
    _loaded: bool = False

    @classmethod
    def get(cls, scene_key: str) -> PromptBundle:
        if not cls._loaded:
            raise RuntimeError("PromptRegistry not loaded — Django startup misconfigured")
        from ..scenes.exceptions import PromptBundleMissing
        try:
            return cls._bundles[scene_key]
        except KeyError as exc:
            raise PromptBundleMissing(scene_key=scene_key) from exc

    @classmethod
    def render(
        cls,
        scene_key: str,
        *,
        variables: Mapping[str, Any] | None = None,
        mode: str | None = None,
    ) -> RenderedPrompt:
        bundle = cls.get(scene_key)
        variables = variables or {}

        cls._validate_variables(bundle, variables)
        system = cls._resolve_system(bundle, mode, variables)
        user = cls._resolve_user(bundle, variables)

        from ..scenes.registry import SCENES
        spec = SCENES.get(scene_key)
        default_params = spec.default_params if spec else {}

        return RenderedPrompt(
            system=system,
            user=user,
            default_params=default_params,
            bundle=bundle,
        )

    @classmethod
    def validate_at_startup(cls) -> None:
        """启动时加载所有 bundle 到内存并校验。"""
        from ..scenes.registry import SCENES

        cls._bundles = {}
        cls._loaded = False

        if not BUNDLED_DIR.exists():
            from ..scenes.registry import SCENES
            needs_bundle = [
                k for k, s in SCENES.items()
                if not s.is_system
                and s.capability_domain not in ("embedding", "asr", "tts", "image_gen", "video_gen", "audio_gen")
            ]
            if needs_bundle:
                raise ImportError(
                    f"bundled/ 目录不存在，但有 {len(needs_bundle)} 个 scene 需要 bundle"
                )
            cls._loaded = True
            return

        for child in sorted(BUNDLED_DIR.iterdir()):
            if not child.is_dir() or child.name.startswith((".", "_")):
                continue

            scene_key = child.name
            bundle = cls._load_bundle(child, scene_key)
            if bundle:
                cls._bundles[scene_key] = bundle

        for scene_key, spec in SCENES.items():
            if spec.is_system:
                continue
            if spec.capability_domain in ("embedding", "asr", "tts", "image_gen", "video_gen", "audio_gen"):
                continue
            if scene_key not in cls._bundles:
                raise ImportError(f"E18_PROMPT_BUNDLE_MISSING: scene={scene_key} 无 bundle")

        cls._loaded = True
        logger.info("[PromptRegistry] 加载完成：%d 个 bundle", len(cls._bundles))

    @classmethod
    def _load_bundle(cls, bundle_dir: Path, scene_key: str) -> PromptBundle | None:
        system_text = None
        system_variants: dict[str, str] = {}
        user_template = None
        user_static = None
        template_variables: tuple[TemplateVariableSpec, ...] = ()

        system_md = bundle_dir / "system.md"
        if system_md.exists():
            system_text = system_md.read_text(encoding="utf-8").strip()

        for child_file in sorted(bundle_dir.iterdir()):
            if child_file.name.startswith("system.") and child_file.name.endswith(".md"):
                if child_file.name == "system.md":
                    continue
                mode_name = child_file.stem.split(".", 1)[1]
                system_variants[mode_name] = child_file.read_text(encoding="utf-8").strip()

        if system_variants:
            system_text = None

        user_tmpl = bundle_dir / "user.md.tmpl"
        user_md = bundle_dir / "user.md"
        if user_tmpl.exists():
            user_template = user_tmpl.read_text(encoding="utf-8")
        elif user_md.exists():
            user_static = user_md.read_text(encoding="utf-8")

        scene_md = bundle_dir / "SCENE.md"
        if scene_md.exists():
            from ..scenes.loader import load_scene_md_frontmatter
            fm = load_scene_md_frontmatter(bundle_dir)
            if fm and fm.get("template_variables"):
                tv_list = []
                for tv in fm["template_variables"]:
                    if isinstance(tv, dict):
                        tv_list.append(TemplateVariableSpec(
                            name=tv.get("name", ""),
                            type=tv.get("type", "str"),
                            required=tv.get("required", True),
                            description=tv.get("description", ""),
                            max_length=tv.get("max_length"),
                        ))
                template_variables = tuple(tv_list)

        version_hash = cls._compute_version_hash(bundle_dir)

        return PromptBundle(
            scene_key=scene_key,
            system_text=system_text,
            system_variants=system_variants,
            user_template=user_template,
            user_static=user_static,
            template_variables=template_variables,
            bundle_dir=bundle_dir,
            version_hash=version_hash,
        )

    @classmethod
    def _compute_version_hash(cls, bundle_dir: Path) -> str:
        h = hashlib.sha256()
        for f in sorted(bundle_dir.rglob("*")):
            if f.is_file():
                h.update(f.read_bytes())
        return h.hexdigest()[:16]

    @classmethod
    def _resolve_system(
        cls,
        bundle: PromptBundle,
        mode: str | None,
        variables: Mapping[str, Any] | None = None,
    ) -> str:
        if bundle.system_variants:
            from ..scenes.exceptions import InvalidVariables
            if not mode:
                raise InvalidVariables(
                    f"scene requires mode_variants but mode not given",
                    scene_key=bundle.scene_key,
                )
            try:
                raw = bundle.system_variants[mode]
            except KeyError as exc:
                raise InvalidVariables(
                    f"unknown mode: {mode}",
                    scene_key=bundle.scene_key,
                ) from exc
            return cls._maybe_render_system(raw, variables)
        if bundle.system_text is None:
            return ""
        return cls._maybe_render_system(bundle.system_text, variables)

    @classmethod
    def _maybe_render_system(
        cls, text: str, variables: Mapping[str, Any] | None
    ) -> str:
        """当 system 文本含 Jinja2 模板语法时走渲染，否则原样返回。"""
        if "{%" in text or "{{" in text:
            return cls._render_jinja(text, variables or {})
        return text

    @classmethod
    def _resolve_user(cls, bundle: PromptBundle, variables: Mapping[str, Any]) -> str:
        if bundle.user_static is not None:
            return bundle.user_static
        if bundle.user_template is None:
            return ""
        return cls._render_jinja(bundle.user_template, variables)

    @classmethod
    def _render_jinja(cls, template: str, variables: Mapping[str, Any]) -> str:
        from .jinja_env import get_jinja_env
        env = get_jinja_env()
        return env.from_string(template).render(**dict(variables))

    @classmethod
    def _validate_variables(cls, bundle: PromptBundle, variables: Mapping[str, Any]) -> None:
        from ..scenes.exceptions import InvalidVariables
        for spec in bundle.template_variables:
            if spec.required and spec.name not in variables:
                raise InvalidVariables(
                    f"missing required variable: {spec.name}",
                    scene_key=bundle.scene_key,
                )
