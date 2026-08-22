"""Historical migration compatibility for the retired computed outbox.

Runtime models and services were removed. Migration 0027 still imports this
callable while reconstructing its historical state, so the ID factory must
remain importable for fresh installations.
"""

from uuid import uuid4


def generate_outbox_id() -> str:
    return f"cuo_{uuid4().hex[:16]}"
