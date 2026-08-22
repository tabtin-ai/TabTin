"""
Open API 再导出层

所有业务逻辑在 api_open_impl/ 子模块中，本文件做符号再导出，
供 api_open_space.py 和测试统一导入。

路由在 api_open_space.py（/api/open/v1/spaces/...，@deprecated ）
与 api_open_org.py（/api/open/v1/organizations/.../data/...）中。
底部保留若干装饰器包装函数，仅供测试调用。
"""
from uuid import UUID

from django.http import HttpRequest

from apps.tabdata.api_helpers import api_error_handler
from apps.tabdata.auth_open_api import (
    require_scope,
    require_table_access,
)

# ---------------------------------------------------------------------------
# Schema 再导出（供测试和 api_open_space.py 使用）
# ---------------------------------------------------------------------------
from apps.tabdata.api_open_schemas import (  # noqa: F401
    InlineFieldDefinition,
    BulkCreateBody,
    OpenCreateFieldBody,
    OpenCreateRecordBody,
    OpenExportPDFBody,
    RLSPolicyBody,
    WebhookCreateBody,
    WebhookUpdateBody,
)

# ---------------------------------------------------------------------------
# Impl 函数再导出
# ---------------------------------------------------------------------------
from apps.tabdata.api_open_impl.db_conn_impl import (  # noqa: F401
    create_db_connection_impl,
    delete_db_connection_impl,
    get_db_connection_impl,
    reset_db_connection_password_impl,
)
from apps.tabdata.api_open_impl.exchange_impl import (  # noqa: F401
    export_table_to_csv_impl,
    export_table_to_excel_impl,
    export_table_to_json_impl,
    export_table_to_pdf_impl,
    get_open_import_template_impl,
    import_table_from_csv_impl,
    import_table_from_excel_impl,
    import_table_from_json_impl,
    preview_open_import_data_impl,
)
from apps.tabdata.api_open_impl.field_impl import (  # noqa: F401
    get_field_map_impl,
    list_fields_impl,
    open_create_field_impl,
    open_delete_field_impl,
    open_update_field_impl,
)
from apps.tabdata.api_open_impl.policy_impl import (  # noqa: F401
    create_policy_impl,
    delete_policy_impl,
    list_policies_impl,
    toggle_rls_impl,
    update_policy_impl,
)
from apps.tabdata.api_open_impl.record_impl import (  # noqa: F401
    _structurize_batch_errors,
    aggregate_records_impl,
    batch_create_records_impl,
    batch_delete_records_impl,
    batch_update_records_impl,
    create_record_impl,
    delete_record_impl,
    get_record_impl,
    query_records_get_impl,
    query_records_post_impl,
    update_record_impl,
    upsert_records_impl,
)
from apps.tabdata.api_open_impl.table_impl import (  # noqa: F401
    _build_table_developer_contract,
    _build_table_openapi_spec,
    export_table_openapi_spec_route_impl,
    get_table_developer_contract_route_impl,
    get_table_impl,
    list_tables_impl,
    open_delete_table_impl,
    open_update_table_impl,
)
from apps.tabdata.api_open_impl.view_impl import (  # noqa: F401
    open_create_view_impl,
    open_delete_view_impl,
    open_get_view_data_impl,
    open_list_views_impl,
    open_update_view_impl,
)
from apps.tabdata.api_open_impl.webhook_impl import (  # noqa: F401
    create_webhook_impl,
    delete_webhook_impl,
    list_webhooks_impl,
    test_webhook_impl,
    update_webhook_impl,
)


# ---------------------------------------------------------------------------
# 向后兼容：测试直接调用的装饰函数
#
# test_open_api_adjacent_guards.py 通过 create_policy / list_policies 等
# 测试 @require_scope + @require_table_access 装饰器的权限拦截行为，
# 因此这些函数必须保留装饰器。
# ---------------------------------------------------------------------------

@require_scope('policy:manage')
@require_table_access(required_role='editor')
@api_error_handler
def create_policy(request: HttpRequest, table_id: UUID, body: RLSPolicyBody):
    return create_policy_impl(request, table_id, body)


@require_scope('policy:read')
@require_table_access
@api_error_handler
def list_policies(request: HttpRequest, table_id: UUID):
    return list_policies_impl(request, table_id)


@require_scope('webhook:manage')
@api_error_handler
def create_webhook(request: HttpRequest, body: WebhookCreateBody):
    return create_webhook_impl(request, body)


@require_scope('webhook:manage')
@api_error_handler
def list_webhooks(request: HttpRequest):
    return list_webhooks_impl(request)


@require_scope('webhook:manage')
@api_error_handler
def update_webhook(request: HttpRequest, webhook_id: UUID, body: WebhookUpdateBody):
    return update_webhook_impl(request, webhook_id, body)


@require_scope('import:write', 'table:read')
@require_table_access
@api_error_handler
def get_open_import_template(request: HttpRequest, table_id: UUID):
    return get_open_import_template_impl(request, table_id)


@require_scope('export:read')
@require_table_access
@api_error_handler
def export_table_to_pdf(request: HttpRequest, table_id: UUID, body: OpenExportPDFBody):
    return export_table_to_pdf_impl(request, table_id, body)
