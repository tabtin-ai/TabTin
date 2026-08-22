from django.core.management.base import BaseCommand

from ...model_gateway.apply import apply_projection_revision
from ...model_gateway.apply.results import ProjectionOperationRejected
from ._model_gateway_write import binding_identity, emit_result, reject_safely, utc_time


class Command(BaseCommand):
    help = "Apply one exact prepared Model Gateway projection revision."

    def add_arguments(self, parser):
        parser.add_argument("--binding", required=True)
        parser.add_argument("--revision", required=True, type=int)
        parser.add_argument("--expected-projection-hash", required=True)
        parser.add_argument("--expected-current-revision", required=True)
        parser.add_argument("--database", required=True)
        parser.add_argument("--evaluation-time", required=True)
        parser.add_argument("--actor", required=True)
        parser.add_argument("--ticket", required=True)
        parser.add_argument("--confirm-hash", required=True)

    def handle(self, *args, **options):
        expected = None if options["expected_current_revision"] == "none" else int(options["expected_current_revision"])
        try:
            result = apply_projection_revision(
                database_alias=options["database"], binding_identity=binding_identity(options["binding"]),
                revision_number=options["revision"], expected_projection_hash=options["expected_projection_hash"],
                expected_current_revision=expected, actor=options["actor"], ticket=options["ticket"],
                evaluation_time=utc_time(options["evaluation_time"]), confirmation_hash=options["confirm_hash"],
            )
        except ProjectionOperationRejected as exc:
            reject_safely(exc)
        emit_result(self, result)
