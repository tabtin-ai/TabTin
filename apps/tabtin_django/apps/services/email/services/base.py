"""
邮件服务基础抽象类
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List
import logging

from apps.i18n import _

logger = logging.getLogger(__name__)


class EmailServiceBase(ABC):
    """邮件服务基础抽象类"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化邮件服务

        Args:
            config: 服务配置
        """
        self.config = config
        self.logger = logger

    @abstractmethod
    def send_email(self, to_email: str, subject: str, content: str,
                   content_type: str = 'html', attachments: Optional[List] = None) -> Dict[str, Any]:
        """
        发送邮件

        Args:
            to_email: 收件人邮箱
            subject: 邮件主题
            content: 邮件内容
            content_type: 内容类型 ('html' 或 'plain')
            attachments: 附件列表

        Returns:
            Dict: 发送结果
        """
        pass

    @abstractmethod
    def send_verification_email(self, to_email: str, code: str) -> Dict[str, Any]:
        """
        发送验证码邮件

        Args:
            to_email: 收件人邮箱
            code: 验证码

        Returns:
            Dict: 发送结果
        """
        pass

    @abstractmethod
    def send_template_email(self, to_email: str, template_name: str,
                           template_params: Dict[str, Any]) -> Dict[str, Any]:
        """
        发送模板邮件

        Args:
            to_email: 收件人邮箱
            template_name: 模板名称
            template_params: 模板参数

        Returns:
            Dict: 发送结果
        """
        pass

    def send_batch_email(self, recipients: List[str], subject: str, content: str,
                        content_type: str = 'html') -> Dict[str, Any]:
        """
        批量发送邮件

        Args:
            recipients: 收件人列表
            subject: 邮件主题
            content: 邮件内容
            content_type: 内容类型

        Returns:
            Dict: 发送结果
        """
        results = []
        success_count = 0

        for recipient in recipients:
            try:
                result = self.send_email(recipient, subject, content, content_type)
                results.append({
                    'recipient': recipient,
                    'success': result.get('success', False),
                    'message': result.get('message', '')
                })
                if result.get('success'):
                    success_count += 1
            except Exception as e:
                results.append({
                    'recipient': recipient,
                    'success': False,
                    'message': str(e)
                })

        return self.format_response(
            success=success_count > 0,
            message=_("email_service.batch_send_done", success=success_count, total=len(recipients)),
            data={
                'total': len(recipients),
                'success_count': success_count,
                'failed_count': len(recipients) - success_count,
                'results': results
            }
        )

    def validate_config(self) -> bool:
        """
        验证配置

        Returns:
            bool: 配置是否有效
        """
        required_keys = self.get_required_config_keys()
        for key in required_keys:
            if key not in self.config or not self.config[key]:
                self.logger.error(f"邮件服务配置缺少必需参数: {key}")
                return False
        return True

    @abstractmethod
    def get_required_config_keys(self) -> list:
        """
        获取必需的配置键

        Returns:
            list: 必需的配置键列表
        """
        pass

    def format_response(self, success: bool, message: str, data: Optional[Dict] = None,
                       error_code: Optional[str] = None) -> Dict[str, Any]:
        """
        格式化响应结果

        Args:
            success: 是否成功
            message: 响应消息
            data: 响应数据
            error_code: 错误代码

        Returns:
            Dict: 格式化的响应
        """
        response = {
            'success': success,
            'message': message,
            'timestamp': self._get_timestamp()
        }

        if data:
            response['data'] = data

        if error_code:
            response['error_code'] = error_code

        return response

    def _get_timestamp(self) -> str:
        """获取当前时间戳"""
        from datetime import datetime
        return datetime.now().isoformat()

    def _log_request(self, action: str, params: Dict[str, Any]) -> None:
        """记录请求日志"""
        from apps.services.common.utils import sanitize_log_data

        sanitized_params = sanitize_log_data(params)
        self.logger.info(f"邮件服务请求 - 动作: {action}, 参数: {sanitized_params}")

    def _log_response(self, action: str, response: Dict[str, Any]) -> None:
        """记录响应日志"""
        self.logger.info(f"邮件服务响应 - 动作: {action}, 结果: {response.get('success', False)}, "
                        f"消息: {response.get('message', '')}")

    def _handle_exception(self, action: str, exception: Exception) -> Dict[str, Any]:
        """处理异常"""
        error_message = f"邮件服务异常 - 动作: {action}, 错误: {str(exception)}"
        self.logger.error(error_message, exc_info=True)

        return self.format_response(
            success=False,
            message=_("email_service.send_failed"),
            error_code="EMAIL_SERVICE_ERROR"
        )

    def _render_template(self, template_content: str, params: Dict[str, Any]) -> str:
        """
        渲染邮件模板

        Args:
            template_content: 模板内容
            params: 模板参数

        Returns:
            str: 渲染后的内容
        """
        try:
            return template_content.format(**params)
        except KeyError as e:
            raise ValueError(_("email_service.template_param_missing", detail=str(e)))
        except Exception as e:
            raise ValueError(_("email_service.template_render_failed", detail=str(e)))

    def _validate_email_format(self, email: str) -> bool:
        """验证邮箱格式"""
        from apps.services.common.utils import validate_email
        return validate_email(email)
