"""Shared field configuration invariants across all metadata write paths."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table
from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.utils.default_values import reconcile_select_default, validate_default_value


CONFIG_UNSET = object()
DEFAULT_VALUE_UNSET = object()


@dataclass(frozen=True)
class FieldConfigurationChange:
    config_changed: bool
    default_changed: bool
    native_type_changed: bool


def apply_field_configuration_change(
    field: Any,
    *,
    config: Any = CONFIG_UNSET,
    default_value: Any = DEFAULT_VALUE_UNSET,
) -> FieldConfigurationChange:
    """Apply config/default invariants and synchronize date native storage.

    The caller remains responsible for saving ``field``.  Keeping persistence
    outside this function lets REST, collab, and undo/redo retain their own
    transaction, history, and event semantics while sharing the invariants.
    """
    old_config = deepcopy(field.config or {})
    old_default = deepcopy(field.default_value)

    if config is not CONFIG_UNSET:
        field.config = deepcopy(config or {})

    if default_value is not DEFAULT_VALUE_UNSET:
        field.default_value = validate_default_value(
            field.field_type,
            default_value,
            field.config,
        )
    elif config is not CONFIG_UNSET and field.field_type in {'select', 'multi_select'}:
        field.default_value = reconcile_select_default(
            field.default_value,
            old_config.get('choices') or [],
            (field.config or {}).get('choices') or [],
            multiple=field.field_type == 'multi_select',
        )

    config_changed = old_config != (field.config or {})
    default_changed = old_default != field.default_value
    native_type_changed = False

    # Always inspect the actual native type for date config/default writes.
    # This also repairs legacy metadata/storage drift on a default-only update.
    if field.field_type == 'date' and (
        config is not CONFIG_UNSET or default_value is not DEFAULT_VALUE_UNSET
    ):
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=field.table_id)
        native_type_changed = DDLManager().alter_column_type(
            resolve_schema_partition_id(table),
            field.table_id,
            field.id,
            field.field_type,
            field.field_type,
            config=field.config,
            old_config=old_config,
        )

    return FieldConfigurationChange(
        config_changed=config_changed,
        default_changed=default_changed,
        native_type_changed=native_type_changed,
    )
