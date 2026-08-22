"""SandboxedEnvironment + StrictUndefined — prompt 模板渲染沙箱。"""

from __future__ import annotations

from jinja2.sandbox import SandboxedEnvironment
from jinja2 import StrictUndefined

_ENV: SandboxedEnvironment | None = None


def get_jinja_env() -> SandboxedEnvironment:
    global _ENV
    if _ENV is None:
        _ENV = SandboxedEnvironment(
            autoescape=False,
            trim_blocks=True,
            lstrip_blocks=True,
            extensions=[],
            undefined=StrictUndefined,
        )
    return _ENV
