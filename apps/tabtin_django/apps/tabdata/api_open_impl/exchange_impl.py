import base64
import binascii
from typing import Optional, List
from uuid import UUID

from django.http import HttpRequest, HttpResponse, JsonResponse, StreamingHttpResponse

from apps.tabdata.api_open_impl.common import impl_error_handler
from apps.tabdata.api_helpers import success_response
from apps.tabdata.api_open_schemas import (
    OpenExportCSVBody, OpenExportExcelBody, OpenExportJSONBody, OpenExportPDFBody,
    OpenImportCSVBody, OpenImportExcelBody, OpenImportJSONBody, OpenImportPreviewBody,
)
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.services import ExportService, ImportService
from apps.tabdata.services.import_error_classifier import classify_import_error, build_error_summary


_MAX_OPEN_TEXT_IMPORT_BYTES = 10 * 1024 * 1024


_MAX_OPEN_EXCEL_IMPORT_BYTES = 20 * 1024 * 1024


def _parse_uuid_list(raw_values: Optional[List[str]], field_name: str) -> Optional[List[UUID]]:
    if not raw_values:
        return None

    parsed: List[UUID] = []
    for raw in raw_values:
        try:
            parsed.append(UUID(str(raw)))
        except (TypeError, ValueError) as exc:
            raise ValueError(f'{field_name} 包含非法 UUID: {raw}') from exc
    return parsed


def _parse_optional_uuid(raw_value: Optional[str], field_name: str) -> Optional[UUID]:
    if raw_value in (None, '', 'null', 'undefined'):
        return None
    try:
        return UUID(str(raw_value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{field_name} 不是合法 UUID: {raw_value}') from exc


def _decode_base64_content(raw_value: str, field_name: str) -> bytes:
    if raw_value is None:
        raise ValueError(f'{field_name} 不能为空')

    payload = raw_value.strip()
    if ';base64,' in payload:
        payload = payload.split(';base64,', 1)[1]
    payload = ''.join(payload.split())
    if not payload:
        raise ValueError(f'{field_name} 不能为空')

    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f'{field_name} 不是合法的 base64 内容') from exc


def _build_open_import_result(
    created_count: int,
    updated_count: int,
    errors: list,
    *,
    service: Optional[ImportService] = None,
) -> JsonResponse:
    classified = getattr(service, '_last_classified_errors', None) if service else None
    if classified is None:
        classified = [classify_import_error(error) for error in errors]

    skipped_count = getattr(service, '_last_skipped_count', 0) if service else 0
    message = '导入完成'
    if created_count > 0:
        message += f'，新建 {created_count} 条'
    if updated_count > 0:
        message += f'，更新 {updated_count} 条'
    if skipped_count > 0:
        message += f'，跳过 {skipped_count} 条'

    payload = {
        'created_count': created_count,
        'updated_count': updated_count,
        'skipped_count': skipped_count,
        'error_summary': build_error_summary(classified),
        'errors': [error.to_dict() for error in classified],
        'import_metadata': getattr(service, 'last_import_metadata', None) if service else None,
    }
    return JsonResponse(success_response(data=payload, message=message), status=200)


@impl_error_handler('导入预览')
def preview_open_import_data_impl(request: HttpRequest, table_id: UUID, body: OpenImportPreviewBody):
    if body.file_type == 'excel':
        file_content = _decode_base64_content(body.file_base64 or '', 'file_base64')
        if len(file_content) > _MAX_OPEN_EXCEL_IMPORT_BYTES:
            return JsonResponse(
                get_error_response(
                    ErrorCode.VALIDATION_ERROR,
                    detail=f'Excel 文件超过 {_MAX_OPEN_EXCEL_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试',
                ),
                status=400,
            )
    else:
        if not body.file_content:
            return JsonResponse(
                get_error_response(
                    ErrorCode.VALIDATION_ERROR,
                    detail='file_content 不能为空',
                ),
                status=400,
            )
        file_content = body.file_content
        if len(file_content.encode('utf-8')) > _MAX_OPEN_TEXT_IMPORT_BYTES:
            return JsonResponse(
                get_error_response(
                    ErrorCode.VALIDATION_ERROR,
                    detail=f'{body.file_type.upper()} 内容超过 {_MAX_OPEN_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试',
                ),
                status=400,
            )

    service = ImportService(user=request.auth)
    preview_result = service.preview_import(
        table_id=table_id,
        file_content=file_content,
        file_type=body.file_type,
        preview_rows=body.preview_rows,
        sheet_name=body.sheet_name,
    )
    return JsonResponse(success_response(data=preview_result, message='预览生成成功'), status=200)


@impl_error_handler('Excel 导入')
def import_table_from_excel_impl(request: HttpRequest, table_id: UUID, body: OpenImportExcelBody):
    file_bytes = _decode_base64_content(body.file_base64, 'file_base64')
    if len(file_bytes) > _MAX_OPEN_EXCEL_IMPORT_BYTES:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail=f'Excel 文件超过 {_MAX_OPEN_EXCEL_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试',
            ),
            status=400,
        )

    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)
    service = ImportService(user=request.auth)
    created_count, updated_count, errors = service.import_from_excel(
        table_id=table_id,
        file_bytes=file_bytes,
        skip_errors=body.skip_errors,
        update_existing=body.update_existing,
        primary_key_field=body.primary_key_field,
        sheet_name=body.sheet_name,
        auto_create_missing_fields=body.auto_create_missing_fields,
        rls_context=rls_ctx,
    )
    return _build_open_import_result(
        created_count,
        updated_count,
        errors,
        service=service,
    )


@impl_error_handler('CSV 导入')
def import_table_from_csv_impl(request: HttpRequest, table_id: UUID, body: OpenImportCSVBody):
    if len(body.csv_content.encode('utf-8')) > _MAX_OPEN_TEXT_IMPORT_BYTES:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail=f'CSV 内容超过 {_MAX_OPEN_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试',
            ),
            status=400,
        )

    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)
    service = ImportService(user=request.auth)
    created_count, updated_count, errors = service.import_from_csv(
        table_id=table_id,
        file_content=body.csv_content,
        skip_errors=body.skip_errors,
        update_existing=body.update_existing,
        primary_key_field=body.primary_key_field,
        auto_create_missing_fields=body.auto_create_missing_fields,
        rls_context=rls_ctx,
    )
    return _build_open_import_result(
        created_count,
        updated_count,
        errors,
        service=service,
    )


@impl_error_handler('JSON 导入')
def import_table_from_json_impl(request: HttpRequest, table_id: UUID, body: OpenImportJSONBody):
    if len(body.json_content.encode('utf-8')) > _MAX_OPEN_TEXT_IMPORT_BYTES:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail=f'JSON 内容超过 {_MAX_OPEN_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试',
            ),
            status=400,
        )

    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)
    service = ImportService(user=request.auth)
    created_count, updated_count, errors = service.import_from_json(
        table_id=table_id,
        json_content=body.json_content,
        skip_errors=body.skip_errors,
        update_existing=body.update_existing,
        primary_key_field=body.primary_key_field,
        auto_create_missing_fields=body.auto_create_missing_fields,
        rls_context=rls_ctx,
    )
    return _build_open_import_result(
        created_count,
        updated_count,
        errors,
        service=service,
    )


# TODO(QTA-25): 以下所有导出接口（CSV/JSON/Excel/PDF）当前无次数配额检查。
# 免费用户可在分钟级限流（ApiToken.rate_limit，见 auth_open_api.py）范围内无限量导出，
# 与 max_api_calls_per_day 设计意图不符。
# 后续需在此处或 _check_rate_limit 中接入日次导出计数，并在 MembershipTier 补齐相应字段。
# 参考：apps/tabtin_django/apps/tabdata/auth_open_api.py TODO(QTA-25)

@impl_error_handler('CSV 导出')
def export_table_to_csv_impl(request: HttpRequest, table_id: UUID, body: OpenExportCSVBody):
    field_ids = _parse_uuid_list(body.field_ids, 'field_ids')
    record_ids = _parse_uuid_list(body.record_ids, 'record_ids')
    view_id = _parse_optional_uuid(body.view_id, 'view_id')

    service = ExportService(user=request.auth)
    streaming_content = service.export_to_csv_streaming(
        table_id=table_id,
        field_ids=field_ids,
        record_ids=record_ids,
        view_id=view_id,
        include_headers=body.include_headers,
    )

    response = StreamingHttpResponse(
        streaming_content,
        content_type='text/csv; charset=utf-8',
    )
    response['Content-Disposition'] = f'attachment; filename="export_{table_id}.csv"'
    return response


@impl_error_handler('JSON 导出')
def export_table_to_json_impl(request: HttpRequest, table_id: UUID, body: OpenExportJSONBody):
    field_ids = _parse_uuid_list(body.field_ids, 'field_ids')
    record_ids = _parse_uuid_list(body.record_ids, 'record_ids')
    view_id = _parse_optional_uuid(body.view_id, 'view_id')

    service = ExportService(user=request.auth)
    if body.format_type == 'array':
        streaming_content = service.export_to_json_streaming(
            table_id=table_id,
            field_ids=field_ids,
            record_ids=record_ids,
            view_id=view_id,
        )
        response = StreamingHttpResponse(
            streaming_content,
            content_type='application/json; charset=utf-8',
        )
    else:
        json_content = service.export_to_json(
            table_id=table_id,
            field_ids=field_ids,
            record_ids=record_ids,
            view_id=view_id,
            format_type=body.format_type,
        )
        response = HttpResponse(
            json_content,
            content_type='application/json; charset=utf-8',
        )
        response['Content-Length'] = len(json_content.encode('utf-8'))

    response['Content-Disposition'] = f'attachment; filename="export_{table_id}.json"'
    return response


@impl_error_handler('Excel 导出')
def export_table_to_excel_impl(request: HttpRequest, table_id: UUID, body: OpenExportExcelBody):
    field_ids = _parse_uuid_list(body.field_ids, 'field_ids')
    record_ids = _parse_uuid_list(body.record_ids, 'record_ids')
    view_id = _parse_optional_uuid(body.view_id, 'view_id')

    service = ExportService(user=request.auth)
    excel_bytes = service.export_to_excel(
        table_id=table_id,
        field_ids=field_ids,
        record_ids=record_ids,
        view_id=view_id,
        include_headers=body.include_headers,
        sheet_name=body.sheet_name,
    )

    response = HttpResponse(
        excel_bytes,
        content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    response['Content-Disposition'] = f'attachment; filename="export_{table_id}.xlsx"'
    response['Content-Length'] = len(excel_bytes)
    return response


@impl_error_handler('导入模板')
def get_open_import_template_impl(request: HttpRequest, table_id: UUID):
    template_format = (
        request.GET.get('file_format') or request.GET.get('format') or 'csv'
    ).strip().lower()
    service = ImportService(user=request.auth)
    template = service.get_import_template(table_id, format=template_format)

    if template_format == 'json':
        response = HttpResponse(template, content_type='application/json; charset=utf-8')
        response['Content-Disposition'] = f'inline; filename="import_template_{table_id}.json"'
        response['Content-Length'] = len(template.encode('utf-8'))
        return response

    response = HttpResponse(template, content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = f'attachment; filename="import_template_{table_id}.csv"'
    response['Content-Length'] = len(template.encode('utf-8'))
    return response


@impl_error_handler('PDF 导出')
def export_table_to_pdf_impl(request: HttpRequest, table_id: UUID, body: OpenExportPDFBody):
    field_ids = _parse_uuid_list(body.field_ids, 'field_ids')
    record_ids = _parse_uuid_list(body.record_ids, 'record_ids')
    view_id = _parse_optional_uuid(body.view_id, 'view_id')

    service = ExportService(user=request.auth)
    pdf_bytes = service.export_to_pdf(
        table_id=table_id,
        field_ids=field_ids,
        record_ids=record_ids,
        view_id=view_id,
        orientation=body.orientation,
        title=body.title,
    )

    response = HttpResponse(pdf_bytes, content_type='application/pdf')
    response['Content-Disposition'] = f'attachment; filename="export_{table_id}.pdf"'
    response['Content-Length'] = len(pdf_bytes)
    return response

