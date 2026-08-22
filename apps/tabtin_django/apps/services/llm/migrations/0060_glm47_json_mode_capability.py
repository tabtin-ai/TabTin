"""Backfill the canonical Official Zhipu GLM-4.7 JSON Mode capability.

The provider type (``name=zhipu``), Official scope, and provider model code
(``model_name=glm-4.7``) form the stable identity. Display names and channel
labels are deliberately excluded so same-name BYOK and relay records are not
modified.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from django.db import migrations


def merge_glm47_json_mode(config: Any) -> dict[str, Any]:
    merged = deepcopy(config) if isinstance(config, dict) else {}
    merged["supports_json_mode"] = True
    json_mode = merged.get("json_mode")
    json_mode_config = dict(json_mode) if isinstance(json_mode, dict) else {}
    existing_modes = json_mode_config.get("modes")
    modes = list(existing_modes) if isinstance(existing_modes, (list, tuple)) else []
    if "json_object" not in modes:
        modes.append("json_object")
    json_mode_config["modes"] = modes
    merged["json_mode"] = json_mode_config
    return merged


def backfill_glm47_json_mode(apps, schema_editor):
    llm_model = apps.get_model("llm", "LLMModel")
    queryset = llm_model.objects.filter(
        provider__scope="global",
        provider__name="zhipu",
        model_name="glm-4.7",
    )
    for model in queryset.iterator(chunk_size=500):
        before = model.capabilities_config or {}
        after = merge_glm47_json_mode(before)
        if before == after:
            continue
        model.capabilities_config = after
        model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0059_llm_usage_invocation_attempt_settlement"),
    ]

    operations = [
        migrations.RunPython(
            backfill_glm47_json_mode,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
