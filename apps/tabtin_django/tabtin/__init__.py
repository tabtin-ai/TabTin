# This will make sure the app is always imported when
# Django starts so that shared_task will use this app.
from .celery import app as celery_app

__all__ = ('celery_app',)


def _patch_rename_field_indexes():
    """
    Django 4.2 ProjectState.rename_field 不会完整更新 model options 中的字段引用，
    导致 RenameField 后 Meta.indexes / unique_together / constraints 等仍指向旧字段名，
    在 SQLite 表重建时尤其容易失败。
    Django 5.0 已修复 (ticket )。此补丁回移修复逻辑。

    L24 补丁(2026-04-17):仅设置 Index.fields 不够 —— Index.fields_orders 是在
    __init__ 时根据 fields 派生的元组列表，clone+mutate 不会重新计算它。MySQL
    backend 的 SchemaEditor.remove_index() 调 _create_missing_fk_index() 时
    取 [field_name for field_name, _ in index.fields_orders][0]，仍是旧字段名，
    导致 model._meta.get_field(old_name) 抛 FieldDoesNotExist。修复方式：
    通过 Index.deconstruct() + 重新 __init__ 的方式重建 Index，确保 fields_orders
    与 fields 一致。

    Django >= 5.0 升级保护:Django 5.0 已 native 修复 ticket ,继续 patch
    可能与官方实现叠加产生不可预期行为。本 patch 在 Django 5.0+ 自动 no-op,
    届时建议直接删除本函数。

    fallback 安全性:`Index.deconstruct()+__init__` 失败极少见(标准 Index 类一定
    可往返;失败仅可能是自定义 Index 子类),失败时**直接 raise**而非降级到
    `clone()+改 fields`(后者正是 L24 要修的破口)。让上游显式处理。
    """
    import django as _dj

    if _dj.VERSION >= (5, 0):
        # Django 5.0 已 native 修复;不再 patch,避免双重处理
        return

    from django.db.migrations.state import ProjectState

    _original = ProjectState.rename_field

    def _rename_field_list(values, old_name, new_name):
        if not values:
            return values, False
        renamed = []
        changed = False
        for value in values:
            renamed_value = tuple(new_name if field == old_name else field for field in value)
            if tuple(value) != renamed_value:
                changed = True
            renamed.append(renamed_value)
        if isinstance(values, set):
            return set(renamed), changed
        if isinstance(values, tuple):
            return tuple(renamed), changed
        return renamed, changed

    def _rebuild_index_with_fields(idx, new_fields):
        """通过 deconstruct + 重新 __init__ 重建 Index, 确保 fields_orders 同步。

        失败时直接 raise(不降级到 clone()+改 fields,避免重新引入 fields_orders bug)。
        """
        _, args, kwargs = idx.deconstruct()
        kwargs["fields"] = list(new_fields)
        return idx.__class__(*args, **kwargs)

    def _patched_rename_field(self, app_label, model_name, old_name, new_name):
        _original(self, app_label, model_name, old_name, new_name)
        model_state = self.models[app_label, model_name]
        changed = False

        rebuilt_indexes = []
        for idx in model_state.options.get("indexes", []):
            new_fields = [
                new_name if f == old_name else f for f in idx.fields
            ]
            if new_fields == list(idx.fields):
                rebuilt_indexes.append(idx)
                continue
            new_idx = _rebuild_index_with_fields(idx, new_fields)
            rebuilt_indexes.append(new_idx)
            changed = True

        if rebuilt_indexes:
            model_state.options["indexes"] = rebuilt_indexes

        for option_name in ("unique_together", "index_together"):
            renamed_option, option_changed = _rename_field_list(
                model_state.options.get(option_name),
                old_name,
                new_name,
            )
            if option_changed:
                model_state.options[option_name] = renamed_option
                changed = True

        rebuilt_constraints = []
        constraints_changed = False
        for constraint in model_state.options.get("constraints", []):
            cloned_constraint = constraint.clone()
            fields = getattr(cloned_constraint, "fields", None)
            if fields:
                renamed_fields = tuple(
                    new_name if field == old_name else field for field in fields
                )
                if tuple(fields) != renamed_fields:
                    cloned_constraint.fields = renamed_fields
                    constraints_changed = True
            rebuilt_constraints.append(cloned_constraint)
        if rebuilt_constraints:
            model_state.options["constraints"] = rebuilt_constraints
        if constraints_changed:
            changed = True

        if changed:
            # 不要原地修改 Index 实例，避免污染历史 migration state，
            # 否则 fresh migrate + SQLite 表重建时会把旧阶段索引字段错误地提前改名。
            self.reload_model(app_label, model_name)

    ProjectState.rename_field = _patched_rename_field


def _patch_sqlite_remake_table_field_renames():
    """
    Django 4.2 的 SQLite SchemaEditor._remake_table() 会在 RenameField 场景下
    直接复用旧 model._meta.indexes / constraints，导致自定义 Index/UniqueConstraint
    仍引用旧字段名，重建临时表时抛 FieldDoesNotExist。

    Django >= 5.0 升级保护:同 ,5.0 已 native 修。
    """
    import django as _dj

    if _dj.VERSION >= (5, 0):
        return

    import copy
    from django.db.backends.sqlite3.schema import DatabaseSchemaEditor

    _original = DatabaseSchemaEditor._remake_table

    def _clone_with_renamed_fields(items, rename_mapping):
        rebuilt = []
        for item in items:
            cloned = item.clone() if hasattr(item, "clone") else copy.copy(item)
            fields = getattr(cloned, "fields", None)
            if fields:
                renamed_fields = type(fields)(
                    rename_mapping.get(field, field) for field in fields
                )
                cloned.fields = renamed_fields
            rebuilt.append(cloned)
        return rebuilt

    def _patched(self, model, create_field=None, delete_field=None, alter_fields=None):
        alter_fields = alter_fields or []
        rename_mapping = {
            old_field.name: new_field.name
            for old_field, new_field in alter_fields
            if old_field.name != new_field.name
        }
        if not rename_mapping:
            return _original(
                self,
                model,
                create_field=create_field,
                delete_field=delete_field,
                alter_fields=alter_fields,
            )

        original_indexes = model._meta.indexes
        original_constraints = model._meta.constraints
        try:
            model._meta.indexes = _clone_with_renamed_fields(
                original_indexes,
                rename_mapping,
            )
            model._meta.constraints = _clone_with_renamed_fields(
                original_constraints,
                rename_mapping,
            )
            return _original(
                self,
                model,
                create_field=create_field,
                delete_field=delete_field,
                alter_fields=alter_fields,
            )
        finally:
            model._meta.indexes = original_indexes
            model._meta.constraints = original_constraints

    DatabaseSchemaEditor._remake_table = _patched


_patch_rename_field_indexes()
_patch_sqlite_remake_table_field_renames()
