"""
短信服务基础抽象类
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import logging

from apps.i18n import _

logger = logging.getLogger(__name__)


class SmsServiceBase(ABC):
    """短信服务基础抽象类"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化短信服务

        Args:
            config: 服务配置
        """
        self.config = config
        self.logger = logger

    @abstractmethod
    def send_sms(self, phone: str, template_code: str, template_params: Dict[str, Any]) -> Dict[str, Any]:
        """
        发送短信

        Args:
            phone: 手机号码
            template_code: 模板代码
            template_params: 模板参数

        Returns:
            Dict: 发送结果
        """
        pass

    @abstractmethod
    def send_verification_code(self, phone: str, code: str) -> Dict[str, Any]:
        """
        发送验证码短信

        Args:
            phone: 手机号码
            code: 验证码

        Returns:
            Dict: 发送结果
        """
        pass

    @abstractmethod
    def query_send_status(self, message_id: str) -> Dict[str, Any]:
        """
        查询发送状态

        Args:
            message_id: 消息ID

        Returns:
            Dict: 状态信息
        """
        pass

    def validate_config(self) -> bool:
        """
        验证配置

        Returns:
            bool: 配置是否有效
        """
        required_keys = self.get_required_config_keys()
        for key in required_keys:
            if key not in self.config or not self.config[key]:
                self.logger.error(f"短信服务配置缺少必需参数: {key}")
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
        self.logger.info(f"短信服务请求 - 动作: {action}, 参数: {sanitized_params}")

    def _log_response(self, action: str, response: Dict[str, Any]) -> None:
        """记录响应日志"""
        self.logger.info(f"短信服务响应 - 动作: {action}, 结果: {response.get('success', False)}, "
                        f"消息: {response.get('message', '')}")

    def _handle_exception(self, action: str, exception: Exception) -> Dict[str, Any]:
        """处理异常"""
        error_message = f"短信服务异常 - 动作: {action}, 错误: {str(exception)}"
        self.logger.error(error_message, exc_info=True)

        return self.format_response(
            success=False,
            message=_("sms_service.send_failed"),
            error_code="SMS_SERVICE_ERROR"
        )
