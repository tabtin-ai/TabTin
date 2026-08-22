"""Stable safe rendering for projection proposals."""

import json
from typing import Literal

from .compiler import ProjectionPlan


def render_projection_diff(plan: ProjectionPlan, *, format: Literal["text","json"]="text") -> str:
    groups={name:[] for name in ("generated_factual","commercial","preserved_operational","secret","unmanaged","unchanged")}
    for field in plan.fields:
        row={"target":field.target,"path":field.path,"proposed":field.proposed,"current":field.current,"source_ref":field.source_ref}
        if field.classification=="secret": row={"target":field.target,"path":field.path,"proposed":"not-read","current":None,"source_ref":"redaction-policy"}
        groups[field.classification].append(row)
    provider_target = plan.provider_managed_target_identity.model_dump(mode="json") if plan.provider_managed_target_identity else None
    model_target = plan.model_managed_target_identity.model_dump(mode="json") if plan.model_managed_target_identity else None
    payload={"package_key":plan.package_key,"deployment":plan.deployment_identity.model_dump(mode="json"),"binding":plan.binding_identity.model_dump(mode="json"),"provider_managed_target_identity":provider_target,"model_managed_target_identity":model_target,"fields":groups,"drift":[x.model_dump(mode="json") for x in plan.drift],"blocking_issues":list(plan.blocking_issues),"warnings":list(plan.warnings),"precedence":list(plan.precedence),"projection_hash":plan.projection_hash}
    if format=="json": return json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    lines=[f"package {plan.package_key}",f"deployment {plan.deployment_identity.key}@{plan.deployment_identity.revision}",f"binding {plan.binding_identity.key}@{plan.binding_identity.revision}",f"provider-target {json.dumps(provider_target,sort_keys=True,separators=(',',':'))}",f"model-target {json.dumps(model_target,sort_keys=True,separators=(',',':'))}",f"projection-hash {plan.projection_hash}"]
    for group in groups:
        lines.append(f"[{group}]")
        for row in sorted(groups[group],key=lambda x:(x["target"],x["path"])): lines.append(f"{row['target']}.{row['path']}: {row['current']} -> {row['proposed']} ({row['source_ref']})")
    for drift in plan.drift: lines.append(f"drift {drift.severity} {drift.code} {drift.path}: {drift.message}")
    for issue in plan.blocking_issues: lines.append(f"blocking {issue}")
    for warning in plan.warnings: lines.append(f"warning {warning}")
    return "\n".join(lines)+"\n"
