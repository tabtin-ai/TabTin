"""
短信服务API接口
"""

from ninja import Router
from ninja.errors import HttpError
from apps.users.auth.permissions import JWTAuth
from typing import List
from django.conf import settings
from django.core.paginator import Paginator
from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncDate
from datetime import datetime
import logging

from apps.i18n import get_text

from .schemas import (
    SendSmsRequest, SendSmsResponse,
    SendVerificationCodeRequest,
    BatchSmsRequest, BatchSmsResponse,
    QueryStatusRequest, QueryStatusResponse,
    SmsRecordResponse, SmsRecordListResponse,
    SmsRecordQueryParams, SmsStatisticsResponse,
    SmsStatisticsQueryParams, ServiceStatusResponse,
    HealthCheckResponse
)
from .models import SmsRecord, SmsTemplate
from .services.factory import get_sms_service, validate_provider_config, get_provider_info
from .services.billing_hook import record_sms_billing_event
from apps.services.billing.organization_resolver import resolve_organization_id_from_request
from apps.services.common.executor import run_in_agent_io_executor
from ..common.exceptions import SmsServiceException, ValidationException
from ..common.validators import validate_sms_request
from ..common.utils import mask_phone_number

logger = logging.getLogger(__name__)

jwt_auth = JWTAuth()
router = Router(auth=jwt_auth)


def _require_organization_id(request) -> str:
    organization_id = resolve_organization_id_from_request(request)
    if not organization_id:
        raise HttpError(400, "organization_id is required")
    return organization_id


@router.post("/send-sms", response=SendSmsResponse, tags=["短信发送"])
async def send_sms(request, payload: SendSmsRequest):
    """
    发送短信

    发送自定义模板短信到指定手机号码
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理短信发送请求", extra={
            'request_id': request_id,
            'phone': mask_phone_number(payload.phone),
            'template_code': payload.template_code
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        def _run_sync():
            validate_sms_request(payload.phone, payload.template_code, payload.template_params)
            sms_record = SmsRecord.objects.create(
                user=user,
                phone_number=payload.phone,
                template_code=payload.template_code,
                template_params=payload.template_params,
                sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                request_id=request_id
            )
            sms_service = get_sms_service()
            result = sms_service.send_sms(
                phone=payload.phone,
                template_code=payload.template_code,
                template_params=payload.template_params
            )
            if result.get('success'):
                message_id = result.get('data', {}).get('message_id', '')
                sms_record.mark_as_sent(message_id, result.get('data', {}))
                record_sms_billing_event(
                    organization_id=organization_id,
                    user_id=user_id,
                    sms_record_id=str(sms_record.id),
                    phone=payload.phone,
                    template_code=payload.template_code,
                )
            else:
                error_code = result.get('error_code', 'UNKNOWN_ERROR')
                error_message = result.get('message', '发送失败')
                sms_record.mark_as_failed(error_code, error_message)
            logger.info(f"[{request_id}] 短信发送完成", extra={
                'request_id': request_id,
                'success': result.get('success', False),
                'message_id': result.get('data', {}).get('message_id', '')
            })
            return SendSmsResponse(**result)

        return await run_in_agent_io_executor(_run_sync)

    except ValidationException as e:
        logger.warning(f"[{request_id}] 短信发送参数验证失败: {e}")
        raise HttpError(400, get_text("common.validation_error", detail=str(e)))

    except SmsServiceException as e:
        logger.error(f"[{request_id}] 短信服务异常: {e}")
        raise HttpError(500, get_text("sms.service_error", detail=str(e)))

    except Exception as e:
        logger.error(f"[{request_id}] 短信发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.send_failed"))


# 注意：认证模块已经提供统一的验证码发送接口 /api/auth/send-verification-code
# 为避免歧义，这里保留底层发送短信能力，不再直接对外暴露“验证码发送”业务入口。

@router.post("/send-code", response=SendSmsResponse, tags=["短信发送"], deprecated=True)
async def send_verification_code(request, payload: SendVerificationCodeRequest):
    """
    发送验证码短信

    发送验证码短信到指定手机号码，使用默认验证码模板
    """
    request_id = getattr(request, 'request_id', 'unknown')

    logger.info(f"[{request_id}] SMS服务deprecated验证码入口被调用: phone={payload.phone}, code={payload.code}")

    try:
        logger.info(f"[{request_id}] 开始处理验证码发送请求", extra={
            'request_id': request_id,
            'phone': mask_phone_number(payload.phone)
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        def _run_sync():
            template_code = settings.ALIYUN_SMS_TEMPLATE_CODE
            sms_record = SmsRecord.objects.create(
                user=user,
                phone_number=payload.phone,
                template_code=template_code,
                template_params={'code': payload.code},
                sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                request_id=request_id
            )
            sms_service = get_sms_service()
            result = sms_service.send_verification_code(
                phone=payload.phone,
                code=payload.code
            )
            if result.get('success'):
                message_id = result.get('data', {}).get('message_id', '')
                sms_record.mark_as_sent(message_id, result.get('data', {}))
                record_sms_billing_event(
                    organization_id=organization_id,
                    user_id=user_id,
                    sms_record_id=str(sms_record.id),
                    phone=payload.phone,
                    template_code=template_code,
                )
            else:
                error_code = result.get('error_code', 'UNKNOWN_ERROR')
                error_message = result.get('message', '发送失败')
                sms_record.mark_as_failed(error_code, error_message)
            logger.info(f"[{request_id}] 验证码发送完成", extra={
                'request_id': request_id,
                'success': result.get('success', False)
            })
            return SendSmsResponse(**result)

        return await run_in_agent_io_executor(_run_sync)

    except Exception as e:
        logger.error(f"[{request_id}] 验证码发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.verification_failed"))


@router.post("/send-batch", response=BatchSmsResponse, tags=["短信发送"])
async def send_batch_sms(request, payload: BatchSmsRequest):
    """
    批量发送短信

    批量发送相同内容的短信到多个手机号码
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理批量短信发送请求", extra={
            'request_id': request_id,
            'phone_count': len(payload.phones),
            'template_code': payload.template_code
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        def _run_sync():
            sms_service = get_sms_service()
            result = sms_service.send_batch_sms(
                phones=payload.phones,
                template_code=payload.template_code,
                template_params=payload.template_params
            )
            records_to_create = []
            for phone in payload.phones:
                records_to_create.append(SmsRecord(
                    user=user,
                    phone_number=phone,
                    template_code=payload.template_code,
                    template_params=payload.template_params,
                    sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                    request_id=request_id,
                    status='pending'
                ))
            SmsRecord.objects.bulk_create(records_to_create)

            success_count = result.get('data', {}).get('success_count', 0)
            if success_count > 0:
                record_sms_billing_event(
                    organization_id=organization_id,
                    user_id=user_id,
                    sms_record_id=request_id,
                    phone="batch",
                    template_code=payload.template_code,
                    quantity=success_count,
                )

            logger.info(f"[{request_id}] 批量短信发送完成", extra={
                'request_id': request_id,
                'success_count': success_count,
                'total': len(payload.phones)
            })
            return BatchSmsResponse(**result)

        return await run_in_agent_io_executor(_run_sync)

    except Exception as e:
        logger.error(f"[{request_id}] 批量短信发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.batch_failed"))


@router.get("/status/{message_id}", response=QueryStatusResponse, tags=["状态查询"])
async def query_send_status(request, message_id: str):
    """
    查询发送状态

    根据消息ID查询短信发送状态和详细信息
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 查询短信发送状态", extra={
            'request_id': request_id,
            'message_id': message_id
        })

        user = request.auth

        def _run_sync():
            if not SmsRecord.objects.filter(message_id=message_id, user=user).exists():
                raise HttpError(404, get_text("sms.record_not_found"))
            sms_service = get_sms_service()
            result = sms_service.query_send_status(message_id)
            return QueryStatusResponse(**result)

        return await run_in_agent_io_executor(_run_sync)

    except HttpError:
        raise

    except Exception as e:
        logger.error(f"[{request_id}] 查询发送状态异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.status_query_failed"))


@router.get("/records", response=SmsRecordListResponse, tags=["记录查询"])
def get_sms_records(request, params: SmsRecordQueryParams = None):
    """
    获取短信发送记录

    分页查询短信发送记录，支持多种筛选条件
    """
    if params is None:
        params = SmsRecordQueryParams()

    try:
        queryset = SmsRecord.objects.filter(user=request.auth)

        if params.phone:
            queryset = queryset.filter(phone_number__icontains=params.phone)

        if params.template_code:
            queryset = queryset.filter(template_code=params.template_code)

        if params.status:
            queryset = queryset.filter(status=params.status)

        if params.start_date:
            start_date = datetime.strptime(params.start_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__gte=start_date)

        if params.end_date:
            end_date = datetime.strptime(params.end_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__lte=end_date)

        paginator = Paginator(queryset, params.page_size)
        page_obj = paginator.get_page(params.page)

        # 构建响应数据
        records = []
        for record in page_obj:
            records.append(SmsRecordResponse(
                id=str(record.id),
                phone_number=mask_phone_number(record.phone_number),
                template_code=record.template_code,
                template_params=record.template_params,
                sign_name=record.sign_name,
                content=record.content,
                status=record.status,
                provider=record.provider,
                message_id=record.message_id,
                error_code=record.error_code,
                error_message=record.error_message,
                created_at=record.created_at,
                sent_at=record.sent_at,
                delivered_at=record.delivered_at,
                retry_count=record.retry_count,
                cost=float(record.cost) if record.cost else None
            ))

        return SmsRecordListResponse(
            total=paginator.count,
            page=params.page,
            page_size=params.page_size,
            records=records
        )

    except Exception as e:
        logger.error(f"获取短信记录异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.records_fetch_failed"))


@router.get("/statistics", response=List[SmsStatisticsResponse], tags=["统计分析"])
def get_sms_statistics(request, params: SmsStatisticsQueryParams = None):
    """
    获取短信统计数据

    基于当前用户的 SmsRecord 实时聚合，按日期/服务商/模板维度统计。
    """
    if params is None:
        params = SmsStatisticsQueryParams()

    try:
        queryset = SmsRecord.objects.filter(user=request.auth)

        if params.provider:
            queryset = queryset.filter(provider=params.provider)

        if params.template_code:
            queryset = queryset.filter(template_code=params.template_code)

        if params.start_date:
            start_date = datetime.strptime(params.start_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__gte=start_date)

        if params.end_date:
            end_date = datetime.strptime(params.end_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__lte=end_date)

        aggregated = (
            queryset
            .annotate(date=TruncDate('created_at'))
            .values('date', 'provider', 'template_code')
            .annotate(
                total_sent=Count('id'),
                success_count=Count('id', filter=Q(status='success')),
                failed_count=Count('id', filter=Q(status='failed')),
                delivered_count=Count('id', filter=Q(status='delivered')),
                total_cost=Sum('cost'),
            )
            .order_by('-date')
        )

        statistics = []
        for row in aggregated:
            total = row['total_sent'] or 0
            success = row['success_count'] or 0

            statistics.append(SmsStatisticsResponse(
                date=row['date'].strftime('%Y-%m-%d') if row['date'] else '',
                provider=row['provider'] or '',
                template_code=row['template_code'] or '',
                total_sent=total,
                success_count=success,
                failed_count=row['failed_count'] or 0,
                delivered_count=row['delivered_count'] or 0,
                success_rate=round(success / total * 100, 2) if total else 0,
                delivery_rate=round((row['delivered_count'] or 0) / success * 100, 2) if success else 0,
                total_cost=float(row['total_cost']) if row['total_cost'] else None,
            ))

        return statistics

    except Exception as e:
        logger.error(f"获取短信统计异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.stats_fetch_failed"))


@router.get("/service-status", response=ServiceStatusResponse, tags=["服务状态"])
def get_service_status(request):
    """
    获取服务状态

    获取短信服务的当前状态和配置信息
    """
    try:
        provider = 'aliyun'  # 当前使用的提供商
        config_valid = validate_provider_config(provider)
        provider_info = get_provider_info(provider)

        return ServiceStatusResponse(
            provider=provider,
            status='active' if config_valid else 'error',
            config_valid=config_valid,
            last_check=datetime.now(),
            features=provider_info.get('features', []),
            regions=provider_info.get('regions', [])
        )

    except Exception as e:
        logger.error(f"获取服务状态异常: {e}", exc_info=True)
        raise HttpError(500, get_text("sms.status_fetch_failed"))


@router.get("/health", response=HealthCheckResponse, tags=["健康检查"], auth=None)
def health_check(request):
    """
    健康检查

    检查短信服务的健康状态和依赖服务
    """
    try:
        # 检查数据库连接
        db_status = 'ok'
        try:
            SmsRecord.objects.count()
        except Exception:
            db_status = 'error'

        # 检查短信服务配置
        sms_status = 'ok'
        try:
            validate_provider_config('aliyun')
        except Exception:
            sms_status = 'error'

        overall_status = 'healthy' if db_status == 'ok' and sms_status == 'ok' else 'unhealthy'

        return HealthCheckResponse(
            service='sms',
            status=overall_status,
            version='1.0.0',
            timestamp=datetime.now(),
            dependencies={
                'database': db_status,
                'aliyun_sms': sms_status
            }
        )

    except Exception as e:
        logger.error(f"健康检查异常: {e}", exc_info=True)
        return HealthCheckResponse(
            service='sms',
            status='unhealthy',
            version='1.0.0',
            timestamp=datetime.now(),
            dependencies={
                'database': 'error',
                'aliyun_sms': 'error'
            }
        )
