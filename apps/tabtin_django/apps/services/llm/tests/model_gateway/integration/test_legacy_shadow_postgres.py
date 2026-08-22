import re

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.services.llm.model_gateway.projection.snapshot import read_database_snapshot


FORBIDDEN_SQL = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|VACUUM|GRANT|REVOKE|LOCK\s+TABLE|pg_advisory_lock|pg_try_advisory_lock|nextval|setval)\b|\bFOR\s+(?:UPDATE|SHARE)\b",
    re.I,
)


def test_shadow_database_capture_is_allowlisted_select_only_on_postgresql(django_db_blocker):
    assert connection.vendor == "postgresql"
    with django_db_blocker.unblock():
        with CaptureQueriesContext(connection) as captured:
            snapshot = read_database_snapshot(
                provider_keys=("moonshot", "volcengine", "volcengine-doubao"),
                model_names=(
                    "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
                    "doubao-seed-2-0-lite-260428", "doubao-seed-evolving",
                    "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628",
                ),
            )
    statements = [" ".join(query["sql"].split()) for query in captured.captured_queries]
    assert statements and all(statement.upper().startswith("SELECT") for statement in statements)
    assert not any(FORBIDDEN_SQL.search(statement) for statement in statements)
    observed_names = {row.model_name for row in snapshot.models}
    assert observed_names == {
        "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
        "doubao-seed-2-0-lite-260428", "doubao-seed-evolving",
    }
    assert observed_names.isdisjoint({"doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"})
