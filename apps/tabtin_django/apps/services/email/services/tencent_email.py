"""
腾讯企业邮箱服务实现
"""

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from typing import Dict, Any, List, Optional
from django.conf import settings
from django.template.loader import render_to_string
from django.core.mail import EmailMessage, EmailMultiAlternatives
import logging

from .base import EmailServiceBase
from apps.i18n import _
from apps.services.common.exceptions import EmailServiceException, NetworkException, AuthenticationException
from apps.services.common.utils import generate_request_id, mask_email

logger = logging.getLogger(__name__)


class TencentEmailService(EmailServiceBase):
    """腾讯企业邮箱服务实现"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化腾讯企业邮箱服务

        Args:
            config: 服务配置
        """
        super().__init__(config)
        self.smtp_server = None
        self._validate_and_init()

    def _validate_and_init(self):
        """验证配置并初始化"""
        if not self.validate_config():
            raise EmailServiceException("邮件服务配置无效")

        self.logger.info("腾讯企业邮箱服务初始化成功")

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
        request_id = generate_request_id()

        try:
            self._log_request("send_email", {
                'to_email': mask_email(to_email),
                'subject': subject,
                'content_type': content_type,
                'has_attachments': bool(attachments),
                'request_id': request_id
            })

            # 使用Django的邮件系统发送
            if content_type == 'html':
                email = EmailMultiAlternatives(
                    subject=subject,
                    body=content,
                    from_email=self.config.get('from_email'),
                    to=[to_email]
                )
                email.attach_alternative(content, "text/html")
            else:
                email = EmailMessage(
                    subject=subject,
                    body=content,
                    from_email=self.config.get('from_email'),
                    to=[to_email]
                )

            # 添加附件
            if attachments:
                for attachment in attachments:
                    if isinstance(attachment, dict):
                        email.attach(
                            attachment.get('filename', 'attachment'),
                            attachment.get('content', ''),
                            attachment.get('mimetype', 'application/octet-stream')
                        )

            # 发送邮件
            result = email.send()

            if result:
                response = self.format_response(
                    success=True,
                    message=_("email_service.send_success"),
                    data={
                        'message_id': request_id,  # Django邮件系统没有返回message_id，使用request_id
                        'request_id': request_id,
                        'to_email': mask_email(to_email)
                    }
                )
            else:
                response = self.format_response(
                    success=False,
                    message=_("email_service.send_failed"),
                    error_code="SEND_FAILED"
                )

            self._log_response("send_email", response)
            return response

        except Exception as e:
            return self._handle_exception("send_email", e)

    def send_verification_email(self, to_email: str, code: str) -> Dict[str, Any]:
        """
        发送验证码邮件

        Args:
            to_email: 收件人邮箱
            code: 验证码

        Returns:
            Dict: 发送结果
        """
        try:
            # 使用HTML模板渲染验证码邮件
            subject = f"【{self.config.get('company_name', 'TabTin')}】邮箱验证码"

            # 渲染HTML内容
            html_content = self._render_verification_template(code)

            return self.send_email(
                to_email=to_email,
                subject=subject,
                content=html_content,
                content_type='html'
            )

        except Exception as e:
            return self._handle_exception("send_verification_email", e)

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
        try:
            # 根据模板名称渲染内容
            if template_name == 'verification':
                return self.send_verification_email(to_email, template_params.get('code', ''))
            elif template_name == 'welcome':
                return self._send_welcome_email(to_email, template_params)
            elif template_name == 'notification':
                return self._send_notification_email(to_email, template_params)
            else:
                raise EmailServiceException(f"不支持的邮件模板: {template_name}")

        except Exception as e:
            return self._handle_exception("send_template_email", e)

    def get_required_config_keys(self) -> list:
        """
        获取必需的配置键

        Returns:
            list: 必需的配置键列表
        """
        return ['host', 'port', 'username', 'password', 'use_ssl', 'from_email']

    def _render_verification_template(self, code: str) -> str:
        """
        渲染验证码邮件模板

        Args:
            code: 验证码

        Returns:
            str: 渲染后的HTML内容
        """
        template_context = {
            'code': code,
            'company': self.config.get('company_name', 'TabTin'),
            'website': self.config.get('website', 'https://www.example.com'),
            'support_email': self.config.get('support_email', 'support@laichang.live')
        }

        # 简单的HTML模板
        html_template = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>邮箱验证码</title>
            <style>
                body {{ font-family: Arial, sans-serif; line-height: 1.6; color: ; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ background: #f8f9fa; padding: 20px; text-align: center; border-radius: 5px; }}
                .content {{ padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 5px; margin: 20px 0; }}
                .code {{ font-size: 24px; font-weight: bold; color: #007bff; text-align: center; padding: 20px; background: #f8f9fa; border-radius: 5px; margin: 20px 0; }}
                .footer {{ text-align: center; color: ; font-size: 12px; margin-top: 20px; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>{company}</h1>
                    <p>邮箱验证码</p>
                </div>
                <div class="content">
                    <p>您好！</p>
                    <p>您正在进行邮箱验证，验证码如下：</p>
                    <div class="code">{code}</div>
                    <p><strong>注意事项：</strong></p>
                    <ul>
                        <li>验证码有效期为10分钟</li>
                        <li>请勿将验证码泄露给他人</li>
                        <li>如非本人操作，请忽略此邮件</li>
                    </ul>
                </div>
                <div class="footer">
                    <p>此邮件由系统自动发送，请勿回复</p>
                    <p>如有疑问，请联系客服：{support_email}</p>
                    <p>© {company} - {website}</p>
                </div>
            </div>
        </body>
        </html>
        """

        return self._render_template(html_template, template_context)

    def _send_welcome_email(self, to_email: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发送欢迎邮件"""
        subject = f"欢迎加入{self.config.get('company_name', 'TabTin')}！"

        html_content = f"""
        <html>
        <body>
            <h2>欢迎您，{params.get('username', '用户')}！</h2>
            <p>感谢您注册我们的服务。</p>
            <p>您的账户已经创建成功，现在可以开始使用我们的服务了。</p>
            <p>如有任何问题，请随时联系我们。</p>
            <br>
            <p>祝好！</p>
            <p>{self.config.get('company_name', 'TabTin')}团队</p>
        </body>
        </html>
        """

        return self.send_email(to_email, subject, html_content, 'html')

    def _send_notification_email(self, to_email: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发送通知邮件"""
        subject = params.get('subject', '系统通知')
        content = params.get('content', '您有一条新的系统通知。')

        html_content = f"""
        <html>
        <body>
            <h2>系统通知</h2>
            <p>{content}</p>
            <br>
            <p>此邮件由系统自动发送，请勿回复。</p>
            <p>{self.config.get('company_name', 'TabTin')}团队</p>
        </body>
        </html>
        """

        return self.send_email(to_email, subject, html_content, 'html')

    def test_connection(self) -> Dict[str, Any]:
        """
        测试邮件服务连接

        Returns:
            Dict: 测试结果
        """
        try:
            # 使用Django的邮件后端测试连接
            from django.core.mail import get_connection

            connection = get_connection()
            connection.open()
            connection.close()

            return self.format_response(
                success=True,
                message=_("email_service.connection_test_success")
            )

        except Exception as e:
            return self.format_response(
                success=False,
                message=_("email_service.connection_test_failed", detail=str(e)),
                error_code="CONNECTION_FAILED"
            )
