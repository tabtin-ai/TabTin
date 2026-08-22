# ─── openai / pydantic 兼容 patch ───────────────────────────────────
# openai >= 2.28 把 by_alias=None 传给 pydantic model_dump()，
# 但 pydantic < 2.10 的 Rust 序列化器要求 by_alias 必须是 bool。
# 此 patch 在 rag 模块加载时（早于所有 embedding 调用）统一修正。
#
# 修正策略：
#   1. 替换 openai._compat.model_dump（函数内 lazy import 的来源）
#   2. 替换 openai._base_client.model_dump（模块级 import 的缓存引用）
#   3. 替换 openai._utils._json.model_dump（同上）
# ────────────────────────────────────────────────────────────────────
import functools as _ft

def _apply_openai_pydantic_compat_patch():
    try:
        import openai._compat as _compat
    except ImportError:
        return

    _orig = _compat.model_dump

    @_ft.wraps(_orig)
    def _safe_model_dump(model, *, by_alias=None, **kw):
        if by_alias is None:
            by_alias = False
        return _orig(model, by_alias=by_alias, **kw)

    _compat.model_dump = _safe_model_dump

    _targets = [
        'openai._base_client',
        'openai._utils._json',
    ]
    import importlib
    for mod_name in _targets:
        try:
            mod = importlib.import_module(mod_name)
            if getattr(mod, 'model_dump', None) is _orig:
                mod.model_dump = _safe_model_dump
        except (ImportError, AttributeError):
            pass


_apply_openai_pydantic_compat_patch()
del _apply_openai_pydantic_compat_patch, _ft
