"""Allowlisted, eagerly materialized, read-only ORM snapshots."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from ..domain._base import StrictFrozenModel


def _flatten(value: Any, prefix: str = "$") -> tuple[tuple[str,str],...]:
    rows=[]
    if isinstance(value,dict):
        for key in sorted(value): rows.extend(_flatten(value[key],f"{prefix}.{key}"))
    elif isinstance(value,list):
        for index,item in enumerate(value): rows.extend(_flatten(item,f"{prefix}[{index}]"))
    else: rows.append((prefix,json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),default=str)))
    return tuple(rows)


class ProviderSnapshot(StrictFrozenModel):
    id: UUID
    name: str
    provider_key: str
    display_name: str
    default_base_url: str
    capability_domains: tuple[str,...]
    scope: str
    organization_id: str | None
    user_id: str | None
    routing_enabled: bool
    priority: int
    routing_weight: int
    runtime_status: str
    runtime_cooldown_until: str | None
    health_consecutive_failures: int


class ModelSnapshot(StrictFrozenModel):
    id: UUID
    provider_id: UUID
    model_name: str
    display_name: str
    base_url: str
    capability_domain: str
    context_window_tokens: int
    max_input_tokens: int | None
    max_output_tokens: int | None
    billing_type: str
    input_price_per_1k: str
    output_price_per_1k: str
    price_per_request: str
    price_per_second: str
    custom_billing_config: tuple[tuple[str,str],...]
    capabilities_config: tuple[tuple[str,str],...]
    wave_status: str


class DatabaseSnapshot(StrictFrozenModel):
    providers: tuple[ProviderSnapshot,...]
    models: tuple[ModelSnapshot,...]


PROVIDER_FIELDS=("id","name","provider_key","display_name","default_base_url","capability_domains","scope","organization_id","user_id","routing_enabled","priority","routing_weight","runtime_status","runtime_cooldown_until","health_consecutive_failures")
MODEL_FIELDS=("id","provider_id","model_name","display_name","base_url","capability_domain","context_window_tokens","max_input_tokens","max_output_tokens","billing_type","input_price_per_1k","output_price_per_1k","price_per_request","price_per_second","custom_billing_config","capabilities_config","wave_status")


def read_database_snapshot(*, provider_keys: tuple[str,...]=(), model_names: tuple[str,...]=(), using: str="default") -> DatabaseSnapshot:
    from apps.services.llm.models import LLMModel, LLMProvider
    providers=LLMProvider.objects.using(using).all()
    if provider_keys: providers=providers.filter(provider_key__in=provider_keys)
    provider_rows=list(providers.order_by("provider_key","id").values(*PROVIDER_FIELDS))
    provider_ids=[row["id"] for row in provider_rows]
    models=LLMModel.objects.using(using).filter(provider_id__in=provider_ids)
    if model_names: models=models.filter(model_name__in=model_names)
    model_rows=list(models.order_by("provider_id","model_name","id").values(*MODEL_FIELDS))
    provider_dtos=tuple(ProviderSnapshot(**{**row,"capability_domains":tuple(row["capability_domains"] or ()),"runtime_cooldown_until":row["runtime_cooldown_until"].isoformat() if row["runtime_cooldown_until"] else None}) for row in provider_rows)
    model_dtos=tuple(ModelSnapshot(**{**row,"input_price_per_1k":str(row["input_price_per_1k"]),"output_price_per_1k":str(row["output_price_per_1k"]),"price_per_request":str(row["price_per_request"]),"price_per_second":str(row["price_per_second"]),"custom_billing_config":_flatten(row["custom_billing_config"] or {}),"capabilities_config":_flatten(row["capabilities_config"] or {})}) for row in model_rows)
    return DatabaseSnapshot(providers=provider_dtos,models=model_dtos)
