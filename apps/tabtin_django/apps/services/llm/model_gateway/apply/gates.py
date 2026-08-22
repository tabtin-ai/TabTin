from django.conf import settings

from .results import ProjectionOperationRejected


def require_write_gate(*, database_alias: str, actor: str, ticket: str) -> None:
    if not getattr(settings, "MODEL_GATEWAY_PROJECTION_WRITE_ENABLED", False):
        raise ProjectionOperationRejected("projection-write-disabled")
    if not database_alias or not actor or not ticket:
        raise ProjectionOperationRejected("operation-context-required")
