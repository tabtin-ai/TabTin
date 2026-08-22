"""Historical migration compatibility for retired shadow comparison models."""

from uuid import uuid4


def _gen_shadow_id() -> str:
    return uuid4().hex
