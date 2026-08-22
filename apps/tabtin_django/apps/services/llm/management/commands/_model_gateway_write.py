import json
from dataclasses import asdict

from django.core.management.base import CommandError
from django.utils.dateparse import parse_datetime

from ...model_gateway.apply.results import ProjectionOperationRejected


def binding_identity(value: str) -> tuple[str, str, str]:
    parts = tuple(value.split("/"))
    if len(parts) != 3 or any(not part for part in parts):
        raise CommandError("binding must be exact package/deployment/binding identity")
    return parts


def utc_time(value: str):
    parsed = parse_datetime(value)
    if parsed is None or parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise CommandError("evaluation time must be an explicit UTC timestamp")
    return parsed


def emit_result(command, operation):
    command.stdout.write(json.dumps(asdict(operation), sort_keys=True, separators=(",", ":")))


def reject_safely(exc: ProjectionOperationRejected):
    raise CommandError(exc.code) from None
