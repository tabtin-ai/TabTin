"""
短信服务Celery异步任务
"""

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from celery.schedules import crontab
from typing import Dict, Any, List
from django.conf import settings
from django.utils import timezone
from datetime import datetime, timedelta
import logging

from .models import SmsRecord, SmsStatistics
from .services.factory import get_sms_service
from .services.billing_hook import record_sms_billing_event
from apps.services.common.exceptions import SmsServiceException
from apps.services.common.utils import mask_phone_number

logger = logging.getLogger(__name__)

SMS_BEAT_SCHEDULE = {
    "sms-update-delivery-status": {
        "task": "sms.update_sms_delivery_status",
        "schedule": 300.0,
        "options": {"expires": 240},
    },
    "sms-generate-statistics": {
        "task": "sms.generate_sms_statistics",
        "schedule": crontab(hour=2, minute=0),
        "options": {"expires": 3600},
    },
    "sms-cleanup-old-records": {
        "task": "sms.cleanup_old_sms_records",
        "schedule": crontab(hour=3, minute=30),
        "options": {"expires": 3600},
    },
}

_CLEANUP_BATCH_SIZE = 2000


@shared_task(bind=True, max_retries=3, default_retry_delay=60, rate_limit='10/m', time_limit=300, soft_time_limit=280)
def send_sms_async(self, phone: str, template_code: str, template_params: Dict[str, Any],
                   record_id: str = None) -> Dict[str, Any]:
    """
    异步发送短信任务

    Args:
        phone: 手机号码
        template_code: 模板代码
        template_params: 模板参数
        record_id: 发送记录ID

    Returns:
        Dict: 发送结果
    """
    try:
        logger.info(f"开始异步发送短信任务", extra={
            'task_id': self.request.id,
            'phone': mask_phone_number(phone),
            'template_code': template_code,
            'record_id': record_id
        })

        # 获取或创建发送记录（用 celery task_id 做幂等 key，防止重试时重复创建）
        if record_id:
            try:
                sms_record = SmsRecord.objects.get(id=record_id)
            except SmsRecord.DoesNotExist:
                logger.error(f"短信记录不存在: {record_id}")
                return {'success': False, 'message': '短信记录不存在'}
        else:
            sms_record = SmsRecord.objects.filter(request_id=self.request.id).first()
            if not sms_record:
                sms_record = SmsRecord.objects.create(
                    phone_number=phone,
                    template_code=template_code,
                    template_params=template_params,
                    sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                    request_id=self.request.id,
                )

        if sms_record.status == 'success':
            logger.info(f"短信已发送（幂等跳过）: record_id={sms_record.id}")
            return {'success': True, 'message': '短信已发送'}

        # 获取短信服务并发送
        sms_service = get_sms_service()
        result = sms_service.send_sms(phone, template_code, template_params)

        # 更新发送记录
        if result.get('success'):
            message_id = result.get('data', {}).get('message_id', '')
            sms_record.mark_as_sent(message_id, result.get('data', {}))
            record_sms_billing_event(
                organization_id="__system__",
                sms_record_id=str(sms_record.id),
                phone=phone,
                template_code=template_code,
            )
            logger.info(f"异步短信发送成功", extra={
                'task_id': self.request.id,
                'message_id': message_id,
                'record_id': str(sms_record.id)
            })
        else:
            error_code = result.get('error_code', 'UNKNOWN_ERROR')
            error_message = result.get('message', '发送失败')
            sms_record.mark_as_failed(error_code, error_message)

            logger.warning(f"异步短信发送失败", extra={
                'task_id': self.request.id,
                'error_code': error_code,
                'error_message': error_message
            })

        return result

    except SmsServiceException as e:
        logger.error(f"短信服务异常: {e}", extra={'task_id': self.request.id})

        # 重试逻辑
        if self.request.retries < self.max_retries:
            logger.info(f"准备重试发送短信，重试次数: {self.request.retries + 1}")
            raise self.retry(countdown=60 * (2 ** self.request.retries))

        # 标记为失败
        if record_id:
            try:
                sms_record = SmsRecord.objects.get(id=record_id)
                sms_record.mark_as_failed('SERVICE_ERROR', str(e))
            except SmsRecord.DoesNotExist:
                pass

        return {'success': False, 'message': f'短信服务异常: {e}'}

    except Exception as e:
        logger.error(f"异步发送短信任务异常: {e}", exc_info=True, extra={'task_id': self.request.id})

        # 重试逻辑
        if self.request.retries < self.max_retries:
            logger.info(f"准备重试发送短信，重试次数: {self.request.retries + 1}")
            raise self.retry(countdown=60 * (2 ** self.request.retries))

        return {'success': False, 'message': f'发送失败: {e}'}


@shared_task(bind=True, max_retries=3, default_retry_delay=60, rate_limit='10/m', time_limit=300, soft_time_limit=280)
def send_verification_code_async(self, phone: str, code: str) -> Dict[str, Any]:
    """
    异步发送验证码任务

    直接调用短信服务发送，不再通过 .apply_async().get() 等待子任务，
    避免 critical 队列死锁（COM-5 修复）。
    """
    template_params = {'code': code}
    template_code = settings.ALIYUN_SMS_TEMPLATE_CODE
    try:
        logger.info("开始发送验证码", extra={
            'task_id': self.request.id,
            'phone': mask_phone_number(phone),
        })

        sms_record = SmsRecord.objects.filter(request_id=self.request.id).first()
        if not sms_record:
            sms_record = SmsRecord.objects.create(
                phone_number=phone,
                template_code=template_code,
                template_params=template_params,
                sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                request_id=self.request.id,
            )

        if sms_record.status == 'success':
            logger.info("验证码已发送（幂等跳过）: record_id=%s", sms_record.id)
            return {'success': True, 'message': '验证码已发送'}

        sms_service = get_sms_service()
        result = sms_service.send_sms(phone, template_code, template_params)

        if result.get('success'):
            message_id = result.get('data', {}).get('message_id', '')
            sms_record.mark_as_sent(message_id, result.get('data', {}))
            record_sms_billing_event(
                organization_id="__system__",
                sms_record_id=str(sms_record.id),
                phone=phone,
                template_code=template_code,
            )
            logger.info("验证码发送成功", extra={
                'task_id': self.request.id,
                'record_id': str(sms_record.id),
            })
        else:
            error_code = result.get('error_code', 'UNKNOWN_ERROR')
            error_message = result.get('message', '发送失败')
            sms_record.mark_as_failed(error_code, error_message)
            logger.warning("验证码发送失败: %s - %s", error_code, error_message)

        return result

    except SmsServiceException as e:
        logger.error("验证码发送服务异常: %s", e, extra={'task_id': self.request.id})
        if self.request.retries < self.max_retries:
            raise self.retry(countdown=60 * (2 ** self.request.retries))
        return {'success': False, 'message': f'短信服务异常: {e}'}

    except Exception as e:
        logger.error("验证码发送异常: %s", e, exc_info=True, extra={'task_id': self.request.id})
        if self.request.retries < self.max_retries:
            raise self.retry(countdown=60 * (2 ** self.request.retries))
        return {'success': False, 'message': f'发送失败: {e}'}


@shared_task(bind=True, rate_limit='5/m', time_limit=300, soft_time_limit=280)
def send_batch_sms_async(self, phones: List[str], template_code: str,
                        template_params: Dict[str, Any]) -> Dict[str, Any]:
    """
    异步批量发送短信任务

    使用 .delay() 分发子任务，不阻塞当前 worker（COM-6 修复）。
    通过 request_id 做幂等保护，重试时不重复创建 SmsRecord。
    """
    try:
        logger.info("开始异步批量发送短信任务", extra={
            'task_id': self.request.id,
            'phone_count': len(phones),
            'template_code': template_code,
        })

        existing_records = list(
            SmsRecord.objects.filter(request_id=self.request.id)
            .values_list('phone_number', 'id')
        )
        existing_phones = {phone for phone, _ in existing_records}

        records_to_create = []
        for phone in phones:
            if phone not in existing_phones:
                records_to_create.append(SmsRecord(
                    phone_number=phone,
                    template_code=template_code,
                    template_params=template_params,
                    sign_name=getattr(settings, 'ALIYUN_SMS_SIGN_NAME', 'example-sign'),
                    request_id=self.request.id,
                    status='pending',
                ))

        if records_to_create:
            SmsRecord.objects.bulk_create(records_to_create)

        all_records = list(
            SmsRecord.objects.filter(request_id=self.request.id)
            .values_list('id', 'phone_number', 'status')
        )

        dispatched = 0
        skipped = 0
        for record_id, phone, status in all_records:
            if status == 'success':
                skipped += 1
                continue
            send_sms_async.delay(phone, template_code, template_params, str(record_id))
            dispatched += 1

        logger.info("异步批量短信分发完成", extra={
            'task_id': self.request.id,
            'dispatched': dispatched,
            'skipped': skipped,
            'total': len(phones),
        })

        return {
            'success': True,
            'message': f"批量分发完成，dispatched={dispatched}, skipped={skipped}",
            'data': {
                'total': len(phones),
                'dispatched': dispatched,
                'skipped': skipped,
            },
        }

    except Exception as e:
        logger.error("异步批量发送短信任务异常: %s", e, exc_info=True, extra={'task_id': self.request.id})
        return {'success': False, 'message': f'批量发送失败: {e}'}


@shared_task(name="sms.update_sms_delivery_status", ignore_result=True, time_limit=300, soft_time_limit=280)
def update_sms_delivery_status():
    """
    更新短信送达状态任务

    定期查询已发送短信的送达状态并更新数据库
    """
    try:
        logger.info("开始更新短信送达状态任务")

        # 查询24小时内已发送但未确认送达的短信
        cutoff_time = timezone.now() - timedelta(hours=24)
        pending_records = SmsRecord.objects.filter(
            status='success',
            sent_at__gte=cutoff_time,
            delivered_at__isnull=True,
            message_id__isnull=False
        )[:100]  # 限制每次处理的数量

        sms_service = get_sms_service()
        updated_count = 0

        for record in pending_records:
            try:
                # 查询送达状态
                result = sms_service.query_send_status(record.message_id)

                if result.get('success'):
                    details = result.get('data', {}).get('details', [])
                    for detail in details:
                        if detail.get('send_status') == '3':  # 已送达
                            record.mark_as_delivered()
                            updated_count += 1
                            break
                        elif detail.get('send_status') in ['2', '4']:  # 发送失败或未送达
                            record.status = 'undelivered'
                            record.save(update_fields=['status'])
                            break

            except Exception as e:
                logger.warning(f"查询单条短信送达状态失败: {e}", extra={
                    'record_id': str(record.id),
                    'message_id': record.message_id
                })

        logger.info(f"短信送达状态更新完成，更新数量: {updated_count}")
        return {'updated_count': updated_count}

    except Exception as e:
        logger.error(f"更新短信送达状态任务异常: {e}", exc_info=True)
        return {'error': str(e)}


@shared_task(name="sms.generate_sms_statistics", ignore_result=True, time_limit=120, soft_time_limit=100)
def generate_sms_statistics():
    """
    生成短信统计数据任务

    每日统计短信发送情况并生成统计报表
    """
    try:
        logger.info("开始生成短信统计数据任务")

        # 统计昨天的数据
        yesterday = (timezone.now() - timedelta(days=1)).date()

        # 按提供商和模板代码分组统计
        from django.db.models import Count, Q

        stats_data = SmsRecord.objects.filter(
            created_at__date=yesterday
        ).values(
            'provider', 'template_code'
        ).annotate(
            total_sent=Count('id'),
            success_count=Count('id', filter=Q(status='success')),
            failed_count=Count('id', filter=Q(status='failed')),
            delivered_count=Count('id', filter=Q(status='delivered'))
        )

        created_count = 0

        for stat in stats_data:
            # 创建或更新统计记录
            statistics, created = SmsStatistics.objects.get_or_create(
                date=yesterday,
                provider=stat['provider'],
                template_code=stat['template_code'],
                defaults={
                    'total_sent': stat['total_sent'],
                    'success_count': stat['success_count'],
                    'failed_count': stat['failed_count'],
                    'delivered_count': stat['delivered_count']
                }
            )

            if not created:
                # 更新已存在的记录
                statistics.total_sent = stat['total_sent']
                statistics.success_count = stat['success_count']
                statistics.failed_count = stat['failed_count']
                statistics.delivered_count = stat['delivered_count']
                statistics.save()

            created_count += 1

        logger.info(f"短信统计数据生成完成，生成数量: {created_count}")
        return {'created_count': created_count, 'date': yesterday.strftime('%Y-%m-%d')}

    except Exception as e:
        logger.error(f"生成短信统计数据任务异常: {e}", exc_info=True)
        return {'error': str(e)}


@shared_task(name="sms.cleanup_old_sms_records", ignore_result=True, time_limit=300, soft_time_limit=280)
def cleanup_old_sms_records():
    """
    清理旧的短信记录任务

    定期清理超过保留期限的短信发送记录。
    分批删除避免长时间行锁影响正常短信写入（COM-46 修复）。
    """
    cutoff_date = timezone.now() - timedelta(days=90)
    total_deleted = 0

    try:
        while True:
            batch_ids = list(
                SmsRecord.objects.filter(created_at__lt=cutoff_date)
                .values_list("id", flat=True)[:_CLEANUP_BATCH_SIZE]
            )
            if not batch_ids:
                break
            deleted_count, _ = SmsRecord.objects.filter(id__in=batch_ids).delete()
            total_deleted += deleted_count
    except SoftTimeLimitExceeded:
        logger.warning(
            "[SMS] cleanup_old_sms_records 超时，已完成部分清理: deleted=%d",
            total_deleted,
        )
        return {'deleted_count': total_deleted, 'partial': True}
    except Exception as e:
        logger.error("清理旧短信记录任务异常: %s", e, exc_info=True)
        return {'error': str(e)}

    if total_deleted:
        logger.info("旧短信记录清理完成，删除数量: %d", total_deleted)
    return {'deleted_count': total_deleted}
