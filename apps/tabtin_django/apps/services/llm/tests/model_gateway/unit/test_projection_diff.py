import json

from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity
from apps.services.llm.model_gateway.projection.compiler import ProjectionPlan, ProjectedField
from apps.services.llm.model_gateway.projection.diff import render_projection_diff
from apps.services.llm.model_gateway.projection.identities import ManagedDatabaseTargetIdentity
from uuid import UUID

H="sha256:"+"a"*64
def plan():
    deployment=ArtifactIdentity(kind="deployment-profile",key="fictional-deployment",revision="1",canonical_hash=H); binding=ArtifactIdentity(kind="model-deployment-binding",key="fictional-binding",revision="1",canonical_hash=H)
    fields=(ProjectedField(target="model",path="base_url",proposed="https://api.example.test",current="https://old.test",source_ref="deployment-profile:fictional",classification="generated_factual"),ProjectedField(target="provider",path="encrypted_api_key",proposed="not-read",current=None,source_ref="redaction-policy",classification="secret"))
    provider_target=ManagedDatabaseTargetIdentity(database_alias="default",target_type="llm-provider",create_candidate_key="sha256:"+"b"*64)
    model_target=ManagedDatabaseTargetIdentity(database_alias="default",target_type="llm-model",existing_database_uuid=UUID("22222222-2222-4222-8222-222222222222"))
    return ProjectionPlan(package_key="fictional-package",deployment_identity=deployment,binding_identity=binding,closure_identities=(deployment,binding),provider_managed_target_identity=provider_target,model_managed_target_identity=model_target,fields=fields,drift=(),blocking_issues=(),warnings=(),precedence=("emergency-restrict-only","runtime-health-cooldown","published-generated-projection"),projection_hash=H)


def test_diff_text_is_stable():
    result=plan(); assert render_projection_diff(result)==render_projection_diff(result)


def test_diff_json_is_stable():
    result=plan(); assert render_projection_diff(result,format="json")==render_projection_diff(result,format="json")


def test_diff_contains_all_field_groups():
    payload=json.loads(render_projection_diff(plan(),format="json")); assert set(payload["fields"])=={"generated_factual","commercial","preserved_operational","secret","unmanaged","unchanged"}


def test_diff_redacts_secret_values_and_shows_projection_hash():
    text=render_projection_diff(plan()); assert "not-read" in text and "encrypted_api_key" in text and "projection-hash sha256:" in text
