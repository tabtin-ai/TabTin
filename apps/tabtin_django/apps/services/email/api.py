"""
邮件服务API接口
"""

from ninja import Router
from ninja.errors import HttpError
from apps.users.auth.permissions import JWTAuth
from typing import List
from django.conf import settings
from django.core.paginator import Paginator
from django.db.models import Count, Q
from django.db.models.functions import TruncDate
from datetime import datetime
import logging

from apps.i18n import get_text

from .schemas import (
    SendEmailRequest, SendEmailResponse,
    SendVerificationEmailRequest,
    SendTemplateEmailRequest,
    BatchEmailRequest, BatchEmailResponse,
    EmailRecordResponse, EmailRecordListResponse,
    EmailRecordQueryParams, EmailStatisticsResponse,
    EmailStatisticsQueryParams, EmailTemplateResponse,
    EmailTemplateQueryParams, CreateEmailTemplateRequest,
    UpdateEmailTemplateRequest, ServiceStatusResponse,
    HealthCheckResponse
)
from .models import EmailRecord, EmailTemplate
from .services.factory import get_email_service, validate_provider_config, get_provider_info
from .services.billing_hook import record_email_billing_event
from apps.services.billing.organization_resolver import resolve_organization_id_from_request
from ..common.exceptions import EmailServiceException, ValidationException
from ..common.validators import validate_email_request
from ..common.utils import mask_email

logger = logging.getLogger(__name__)

jwt_auth = JWTAuth()
router = Router(auth=jwt_auth)


def _require_organization_id(request) -> str:
    organization_id = resolve_organization_id_from_request(request)
    if not organization_id:
        raise HttpError(400, "organization_id is required")
    return organization_id


@router.post("/send-email", response=SendEmailResponse, tags=["邮件发送"])
def send_email(request, payload: SendEmailRequest):
    """
    发送邮件

    发送自定义邮件到指定邮箱地址
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理邮件发送请求", extra={
            'request_id': request_id,
            'to_email': mask_email(payload.to_email),
            'subject': payload.subject
        })

        validate_email_request(payload.to_email, payload.subject, payload.content)

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        email_record = EmailRecord.objects.create(
            user=user,
            recipient_email=payload.to_email,
            sender_email=settings.DEFAULT_FROM_EMAIL,
            subject=payload.subject,
            content=payload.content,
            content_type=payload.content_type,
            priority=payload.priority,
            has_attachments=bool(payload.attachments),
            attachments_info=payload.attachments or [],
            request_id=request_id
        )

        email_service = get_email_service()
        result = email_service.send_email(
            to_email=payload.to_email,
            subject=payload.subject,
            content=payload.content,
            content_type=payload.content_type,
            attachments=payload.attachments
        )

        if result.get('success'):
            message_id = result.get('data', {}).get('message_id', '')
            email_record.mark_as_sent(message_id, result.get('data', {}))
            record_email_billing_event(
                organization_id=organization_id,
                user_id=user_id,
                email_record_id=str(email_record.id),
                recipient=payload.to_email,
            )
        else:
            error_code = result.get('error_code', 'UNKNOWN_ERROR')
            error_message = result.get('message', '发送失败')
            email_record.mark_as_failed(error_code, error_message)

        logger.info(f"[{request_id}] 邮件发送完成", extra={
            'request_id': request_id,
            'success': result.get('success', False),
            'message_id': result.get('data', {}).get('message_id', '')
        })

        return SendEmailResponse(**result)

    except ValidationException as e:
        logger.warning(f"[{request_id}] 邮件发送参数验证失败: {e}")
        raise HttpError(400, get_text("common.validation_error", detail=str(e)))

    except EmailServiceException as e:
        logger.error(f"[{request_id}] 邮件服务异常: {e}")
        raise HttpError(500, get_text("email.service_error", detail=str(e)))

    except Exception as e:
        logger.error(f"[{request_id}] 邮件发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.send_failed"))


@router.post("/send-code", response=SendEmailResponse, tags=["邮件发送"])
def send_verification_email(request, payload: SendVerificationEmailRequest):
    """
    发送验证码邮件

    发送验证码邮件到指定邮箱地址，使用默认验证码模板
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理验证码邮件发送请求", extra={
            'request_id': request_id,
            'to_email': mask_email(payload.email)
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        email_record = EmailRecord.objects.create(
            user=user,
            recipient_email=payload.email,
            sender_email=settings.DEFAULT_FROM_EMAIL,
            subject=f'【{getattr(settings, "COMPANY_NAME", "TabTin")}】邮箱验证码',
            template_name='verification',
            template_params={'code': payload.code},
            content_type='html',
            request_id=request_id
        )

        email_service = get_email_service()
        result = email_service.send_verification_email(
            to_email=payload.email,
            code=payload.code
        )

        if result.get('success'):
            message_id = result.get('data', {}).get('message_id', '')
            email_record.mark_as_sent(message_id, result.get('data', {}))
            record_email_billing_event(
                organization_id=organization_id,
                user_id=user_id,
                email_record_id=str(email_record.id),
                recipient=payload.email,
                template_name='verification',
            )
        else:
            error_code = result.get('error_code', 'UNKNOWN_ERROR')
            error_message = result.get('message', '发送失败')
            email_record.mark_as_failed(error_code, error_message)

        logger.info(f"[{request_id}] 验证码邮件发送完成", extra={
            'request_id': request_id,
            'success': result.get('success', False)
        })

        return SendEmailResponse(**result)

    except Exception as e:
        logger.error(f"[{request_id}] 验证码邮件发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.verification_failed"))


@router.post("/send-template", response=SendEmailResponse, tags=["邮件发送"])
def send_template_email(request, payload: SendTemplateEmailRequest):
    """
    发送模板邮件

    使用指定模板发送邮件
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理模板邮件发送请求", extra={
            'request_id': request_id,
            'to_email': mask_email(payload.email),
            'template_name': payload.template_name
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        email_record = EmailRecord.objects.create(
            user=user,
            recipient_email=payload.email,
            sender_email=settings.DEFAULT_FROM_EMAIL,
            template_name=payload.template_name,
            template_params=payload.template_params,
            content_type='html',
            request_id=request_id
        )

        email_service = get_email_service()
        result = email_service.send_template_email(
            to_email=payload.email,
            template_name=payload.template_name,
            template_params=payload.template_params
        )

        if result.get('success'):
            message_id = result.get('data', {}).get('message_id', '')
            email_record.mark_as_sent(message_id, result.get('data', {}))
            record_email_billing_event(
                organization_id=organization_id,
                user_id=user_id,
                email_record_id=str(email_record.id),
                recipient=payload.email,
                template_name=payload.template_name,
            )
        else:
            error_code = result.get('error_code', 'UNKNOWN_ERROR')
            error_message = result.get('message', '发送失败')
            email_record.mark_as_failed(error_code, error_message)

        logger.info(f"[{request_id}] 模板邮件发送完成", extra={
            'request_id': request_id,
            'success': result.get('success', False)
        })

        return SendEmailResponse(**result)

    except Exception as e:
        logger.error(f"[{request_id}] 模板邮件发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.template_failed"))


@router.post("/send-batch", response=BatchEmailResponse, tags=["邮件发送"])
def send_batch_email(request, payload: BatchEmailRequest):
    """
    批量发送邮件

    批量发送相同内容的邮件到多个邮箱地址
    """
    request_id = getattr(request, 'request_id', 'unknown')

    try:
        logger.info(f"[{request_id}] 开始处理批量邮件发送请求", extra={
            'request_id': request_id,
            'email_count': len(payload.emails),
            'subject': payload.subject
        })

        user = request.auth
        organization_id = _require_organization_id(request)
        user_id = str(getattr(user, 'id', ''))

        email_service = get_email_service()
        result = email_service.send_batch_email(
            recipients=payload.emails,
            subject=payload.subject,
            content=payload.content,
            content_type=payload.content_type
        )

        records_to_create = []
        for email_addr in payload.emails:
            records_to_create.append(EmailRecord(
                user=user,
                recipient_email=email_addr,
                sender_email=settings.DEFAULT_FROM_EMAIL,
                subject=payload.subject,
                content=payload.content,
                content_type=payload.content_type,
                request_id=request_id,
                status='pending'
            ))

        EmailRecord.objects.bulk_create(records_to_create)

        success_count = result.get('data', {}).get('success_count', 0)
        if success_count > 0:
            record_email_billing_event(
                organization_id=organization_id,
                user_id=user_id,
                email_record_id=request_id,
                recipient="batch",
                quantity=success_count,
            )

        logger.info(f"[{request_id}] 批量邮件发送完成", extra={
            'request_id': request_id,
            'success_count': success_count,
            'total': len(payload.emails)
        })

        return BatchEmailResponse(**result)

    except Exception as e:
        logger.error(f"[{request_id}] 批量邮件发送异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.batch_failed"))


@router.get("/records", response=EmailRecordListResponse, tags=["记录查询"])
def get_email_records(request, params: EmailRecordQueryParams = None):
    """
    获取邮件发送记录

    分页查询邮件发送记录，支持多种筛选条件
    """
    if params is None:
        params = EmailRecordQueryParams()

    try:
        queryset = EmailRecord.objects.filter(user=request.auth)

        if params.email:
            queryset = queryset.filter(
                Q(recipient_email__icontains=params.email) |
                Q(sender_email__icontains=params.email)
            )

        if params.template_name:
            queryset = queryset.filter(template_name=params.template_name)

        if params.status:
            queryset = queryset.filter(status=params.status)

        if params.priority:
            queryset = queryset.filter(priority=params.priority)

        if params.start_date:
            start_date = datetime.strptime(params.start_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__gte=start_date)

        if params.end_date:
            end_date = datetime.strptime(params.end_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__lte=end_date)

        # 分页
        paginator = Paginator(queryset, params.page_size)
        page_obj = paginator.get_page(params.page)

        # 构建响应数据
        records = []
        for record in page_obj:
            records.append(EmailRecordResponse(
                id=str(record.id),
                recipient_email=mask_email(record.recipient_email),
                sender_email=mask_email(record.sender_email),
                subject=record.subject,
                content_type=record.content_type,
                template_name=record.template_name,
                template_params=record.template_params,
                status=record.status,
                priority=record.priority,
                provider=record.provider,
                message_id=record.message_id,
                error_code=record.error_code,
                error_message=record.error_message,
                has_attachments=record.has_attachments,
                created_at=record.created_at,
                sent_at=record.sent_at,
                delivered_at=record.delivered_at,
                opened_at=record.opened_at,
                clicked_at=record.clicked_at,
                retry_count=record.retry_count,
                open_count=record.open_count,
                click_count=record.click_count
            ))

        return EmailRecordListResponse(
            total=paginator.count,
            page=params.page,
            page_size=params.page_size,
            records=records
        )

    except Exception as e:
        logger.error(f"获取邮件记录异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.records_fetch_failed"))


@router.get("/statistics", response=List[EmailStatisticsResponse], tags=["统计分析"])
def get_email_statistics(request, params: EmailStatisticsQueryParams = None):
    """
    获取邮件统计数据

    基于当前用户的 EmailRecord 实时聚合，按日期/服务商/模板维度统计。
    """
    if params is None:
        params = EmailStatisticsQueryParams()

    try:
        queryset = EmailRecord.objects.filter(user=request.auth)

        if params.provider:
            queryset = queryset.filter(provider=params.provider)

        if params.template_name:
            queryset = queryset.filter(template_name=params.template_name)

        if params.start_date:
            start_date = datetime.strptime(params.start_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__gte=start_date)

        if params.end_date:
            end_date = datetime.strptime(params.end_date, '%Y-%m-%d').date()
            queryset = queryset.filter(created_at__date__lte=end_date)

        # 按 日期/provider/template_name 分组，用条件计数聚合各状态
        aggregated = (
            queryset
            .annotate(date=TruncDate('created_at'))
            .values('date', 'provider', 'template_name')
            .annotate(
                total_sent=Count('id'),
                success_count=Count('id', filter=Q(status='success')),
                failed_count=Count('id', filter=Q(status='failed')),
                delivered_count=Count('id', filter=Q(status='delivered')),
                opened_count=Count('id', filter=Q(status='opened')),
                clicked_count=Count('id', filter=Q(status='clicked')),
                bounced_count=Count('id', filter=Q(status='bounced')),
            )
            .order_by('-date')
        )

        statistics = []
        for row in aggregated:
            total = row['total_sent'] or 0
            success = row['success_count'] or 0
            delivered = row['delivered_count'] or 0
            opened = row['opened_count'] or 0

            statistics.append(EmailStatisticsResponse(
                date=row['date'].strftime('%Y-%m-%d') if row['date'] else '',
                provider=row['provider'] or '',
                template_name=row['template_name'] or '',
                total_sent=total,
                success_count=success,
                failed_count=row['failed_count'] or 0,
                delivered_count=delivered,
                opened_count=opened,
                clicked_count=row['clicked_count'] or 0,
                bounced_count=row['bounced_count'] or 0,
                success_rate=round(success / total * 100, 2) if total else 0,
                delivery_rate=round(delivered / success * 100, 2) if success else 0,
                open_rate=round(opened / delivered * 100, 2) if delivered else 0,
                click_rate=round((row['clicked_count'] or 0) / opened * 100, 2) if opened else 0,
                bounce_rate=round((row['bounced_count'] or 0) / total * 100, 2) if total else 0,
            ))

        return statistics

    except Exception as e:
        logger.error(f"获取邮件统计异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.stats_fetch_failed"))


@router.get("/service-status", response=ServiceStatusResponse, tags=["服务状态"])
def get_service_status(request):
    """
    获取服务状态

    获取邮件服务的当前状态和配置信息
    """
    try:
        provider = 'tencent'  # 当前使用的提供商
        config_valid = validate_provider_config(provider)
        provider_info = get_provider_info(provider)

        return ServiceStatusResponse(
            provider=provider,
            status='active' if config_valid else 'error',
            config_valid=config_valid,
            last_check=datetime.now(),
            features=provider_info.get('features', []),
            smtp_hosts=provider_info.get('smtp_hosts', [])
        )

    except Exception as e:
        logger.error(f"获取服务状态异常: {e}", exc_info=True)
        raise HttpError(500, get_text("email.status_fetch_failed"))


@router.get("/health", response=HealthCheckResponse, tags=["健康检查"], auth=None)
def health_check(request):
    """
    健康检查

    检查邮件服务的健康状态和依赖服务
    """
    try:
        # 检查数据库连接
        db_status = 'ok'
        try:
            EmailRecord.objects.count()
        except Exception:
            db_status = 'error'

        # 检查邮件服务配置
        email_status = 'ok'
        try:
            validate_provider_config('tencent')
        except Exception:
            email_status = 'error'

        overall_status = 'healthy' if db_status == 'ok' and email_status == 'ok' else 'unhealthy'

        return HealthCheckResponse(
            service='email',
            status=overall_status,
            version='1.0.0',
            timestamp=datetime.now(),
            dependencies={
                'database': db_status,
                'tencent_email': email_status
            }
        )

    except Exception as e:
        logger.error(f"健康检查异常: {e}", exc_info=True)
        return HealthCheckResponse(
            service='email',
            status='unhealthy',
            version='1.0.0',
            timestamp=datetime.now(),
            dependencies={
                'database': 'error',
                'tencent_email': 'error'
            }
        )
