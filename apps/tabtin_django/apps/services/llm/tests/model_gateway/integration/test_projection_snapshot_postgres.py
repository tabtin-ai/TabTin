import re

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.services.llm.model_gateway.projection.snapshot import MODEL_FIELDS, PROVIDER_FIELDS, read_database_snapshot


FORBIDDEN_SQL = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|VACUUM|GRANT|REVOKE|LOCK\s+TABLE|pg_advisory_lock|pg_try_advisory_lock|nextval|setval)\b|\bFOR\s+(?:UPDATE|SHARE)\b",
    re.I,
)


def normalize_sql(statement: str) -> str:
    without_block_comments = re.sub(r"/\*.*?\*/", " ", statement, flags=re.S)
    without_line_comments = re.sub(r"--[^\n]*(?:\n|$)", " ", without_block_comments)
    return " ".join(without_line_comments.split())


@pytest.mark.django_db
def test_snapshot_executes_allowlisted_select_only_on_postgresql():
    assert connection.vendor=="postgresql"
    with CaptureQueriesContext(connection) as captured:
        snapshot=read_database_snapshot(provider_keys=("fictional-provider",),model_names=("fictional-model",))
    sql=[normalize_sql(query["sql"]) for query in captured.captured_queries]
    assert sql and all(statement.upper().startswith("SELECT") for statement in sql)
    assert not any(FORBIDDEN_SQL.search(statement) for statement in sql)
    assert snapshot.providers==() and snapshot.models==()


@pytest.mark.django_db
def test_snapshot_query_shape_is_scoped_ordered_and_provider_key_free():
    from apps.services.llm.models import LLMModel

    with CaptureQueriesContext(connection) as captured:
        read_database_snapshot(provider_keys=("fictional-provider",), model_names=("fictional-model",))
    statements = [normalize_sql(query["sql"]) for query in captured.captured_queries]
    assert len(statements) == 1
    provider_sql = statements[0]
    assert '"provider_key" IN' in provider_sql
    assert 'ORDER BY "services_llm_provider"."provider_key" ASC, "services_llm_provider"."id" ASC' in provider_sql
    model_sql = str(
        LLMModel.objects.filter(provider_id__in=["11111111-1111-4111-8111-111111111111"], model_name__in=["fictional-model"])
        .order_by("provider_id", "model_name", "id")
        .values(*MODEL_FIELDS)
        .query
    )
    assert '"provider_id" IN' in model_sql
    assert '"model_name" IN' in model_sql
    assert "providerkey" not in (provider_sql + model_sql).lower()
    assert "encrypted_api_key" not in (provider_sql + model_sql).lower()


def test_snapshot_field_allowlists_exclude_all_credentials():
    selected=set(PROVIDER_FIELDS)|set(MODEL_FIELDS)
    assert selected.isdisjoint({"encrypted_api_key","api_key","authorization","secret","label"})
    assert "provider_key" in selected and "model_name" in selected
