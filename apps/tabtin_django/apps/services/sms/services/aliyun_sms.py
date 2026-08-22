"""
阿里云短信服务实现
"""

import json
import requests
from typing import Dict, Any
from django.conf import settings
from alibabacloud_dysmsapi20170525.client import Client as DysmsapiClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_dysmsapi20170525 import models as dysmsapi_models
from alibabacloud_tea_util import models as util_models
from alibabacloud_credentials.client import Client as CredClient
from alibabacloud_credentials.models import Config as CredConfig

from .base import SmsServiceBase
from apps.i18n import _
from apps.services.common.exceptions import SmsServiceException, AuthenticationException, NetworkException
from apps.services.common.utils import generate_request_id, mask_phone_number


class AliyunSmsService(SmsServiceBase):
    """阿里云短信服务实现"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化阿里云短信服务

        Args:
            config: 服务配置
        """
        super().__init__(config)
        self.client = None
        self._init_client()

    def _init_client(self):
        """初始化阿里云客户端"""
        try:
            # 检查是否使用ECS RAM角色
            use_ecs_role = getattr(settings, 'ALIYUN_USE_ECS_ROLE', True)

            if use_ecs_role:
                # 使用阿里云凭证SDK获取RAM角色临时凭证
                self.logger.info("使用阿里云凭证SDK获取RAM角色凭证")

                try:
                    cred_config = CredConfig(
                        type='ecs_ram_role',
                        role_name=getattr(settings, 'ALIYUN_ECS_ROLE_NAME', 'ecsadmin')
                    )
                    cred_client = CredClient(cred_config)
                    credential = cred_client.get_credential()

                    access_key_id = credential.access_key_id
                    access_key_secret = credential.access_key_secret
                    security_token = getattr(credential, 'security_token', None) or getattr(credential, 'sts_token', None)

                    if not all([access_key_id, access_key_secret, security_token]):
                        raise AuthenticationException("RAM角色凭证不完整")

                    self.logger.info(f"成功获取RAM角色凭证，AccessKeyId: {access_key_id[:8]}...")

                    config = open_api_models.Config(
                        access_key_id=access_key_id,
                        access_key_secret=access_key_secret,
                        security_token=security_token,
                        region_id=self.config.get('region', 'cn-hangzhou')
                    )
                    self.logger.info("RAM角色凭证配置完成")

                except Exception as e:
                    self.logger.error(f"通过凭证SDK获取RAM角色凭证失败: {e}")

                    # 回退到直接访问ECS元数据服务
                    credentials = self._get_ecs_credentials()

                    if credentials:
                        access_key_id = credentials.get('AccessKeyId')
                        access_key_secret = credentials.get('AccessKeySecret')
                        security_token = credentials.get('SecurityToken')

                        if all([access_key_id, access_key_secret, security_token]):
                            config = open_api_models.Config(
                                access_key_id=access_key_id,
                                access_key_secret=access_key_secret,
                                security_token=security_token,
                                region_id=self.config.get('region', 'cn-hangzhou')
                            )
                            self.logger.info("通过元数据服务获取RAM角色凭证配置完成")
                        else:
                            raise AuthenticationException("ECS元数据服务返回的凭证不完整")
                    else:
                        self.logger.info("尝试使用环境变量获取凭证")
                        config = open_api_models.Config(
                            access_key_id=self.config.get('access_key_id', ''),
                            access_key_secret=self.config.get('access_key_secret', ''),
                            region_id=self.config.get('region', 'cn-hangzhou')
                        )
            else:
                # 使用传统的AccessKey方式
                self.logger.info("使用AccessKey方式获取阿里云凭证")

                config = open_api_models.Config(
                    access_key_id=self.config.get('access_key_id', ''),
                    access_key_secret=self.config.get('access_key_secret', ''),
                    region_id=self.config.get('region', 'cn-hangzhou')
                )

                # 如果有STS Token，则添加
                if self.config.get('security_token'):
                    config.security_token = self.config.get('security_token')

            # 创建短信客户端
            self.client = DysmsapiClient(config)
            self.logger.info("阿里云短信客户端初始化成功")

        except Exception as e:
            self.logger.error(f"阿里云短信客户端初始化失败: {e}")
            raise AuthenticationException(f"短信服务认证失败: {e}")

    def _get_ecs_credentials(self):
        """
        直接通过HTTP请求获取ECS实例RAM角色凭证
        参考：https://help.aliyun.com/zh/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance
        """
        try:
            # 获取角色名称
            role_name = getattr(settings, 'ALIYUN_ECS_ROLE_NAME', 'ecsadmin')

            # ECS元数据服务地址
            metadata_url = f"http://100.100.100.200/latest/meta-data/ram/security-credentials/{role_name}"

            # 请求凭证
            response = requests.get(metadata_url, timeout=5)
            response.raise_for_status()

            credentials = response.json()

            # 验证凭证格式
            required_keys = ['AccessKeyId', 'AccessKeySecret', 'SecurityToken']
            if all(key in credentials for key in required_keys):
                return credentials
            else:
                self.logger.error(f"ECS凭证格式不正确: {credentials}")
                return None

        except requests.RequestException as e:
            self.logger.error(f"请求ECS元数据服务失败: {e}")
            return None
        except json.JSONDecodeError as e:
            self.logger.error(f"解析ECS凭证JSON失败: {e}")
            return None
        except Exception as e:
            self.logger.error(f"获取ECS凭证时发生未知错误: {e}")
            return None

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
        request_id = generate_request_id()

        try:
            self._log_request("send_sms", {
                'phone': mask_phone_number(phone),
                'template_code': template_code,
                'template_params': template_params,
                'request_id': request_id
            })

            # 构建发送请求
            send_sms_request = dysmsapi_models.SendSmsRequest(
                phone_numbers=phone,
                sign_name=self.config.get('sign_name', 'example-sign'),
                template_code=template_code,
                template_param=json.dumps(template_params, ensure_ascii=False)
            )

            runtime = util_models.RuntimeOptions(
                connect_timeout=5000,
                read_timeout=15000,
            )
            response = self.client.send_sms_with_options(send_sms_request, runtime)

            # 处理响应
            result = self._handle_send_response(response, request_id)
            self._log_response("send_sms", result)

            return result

        except Exception as e:
            return self._handle_exception("send_sms", e)

    def send_verification_code(self, phone: str, code: str) -> Dict[str, Any]:
        """
        发送验证码短信

        Args:
            phone: 手机号码
            code: 验证码

        Returns:
            Dict: 发送结果
        """
        template_code = self.config.get('verification_template_code', 'example-template-code')
        template_params = {'code': code}

        return self.send_sms(phone, template_code, template_params)

    def query_send_status(self, message_id: str) -> Dict[str, Any]:
        """
        查询发送状态

        Args:
            message_id: 消息ID

        Returns:
            Dict: 状态信息
        """
        try:
            self._log_request("query_send_status", {
                'message_id': message_id
            })

            # 构建查询请求
            query_request = dysmsapi_models.QuerySendDetailsRequest(
                biz_id=message_id,
                phone_number="",  # 可选参数
                send_date="",     # 可选参数
                page_size=10,
                current_page=1
            )

            runtime = util_models.RuntimeOptions(
                connect_timeout=5000,
                read_timeout=15000,
            )
            response = self.client.query_send_details_with_options(query_request, runtime)

            # 处理响应
            result = self._handle_query_response(response)
            self._log_response("query_send_status", result)

            return result

        except Exception as e:
            return self._handle_exception("query_send_status", e)

    def get_required_config_keys(self) -> list:
        """
        获取必需的配置键

        Returns:
            list: 必需的配置键列表
        """
        if self.config.get('use_ecs_role', True):
            return ['region', 'sign_name']
        else:
            return ['access_key_id', 'access_key_secret', 'region', 'sign_name']

    def _handle_send_response(self, response, request_id: str) -> Dict[str, Any]:
        """
        处理发送响应

        Args:
            response: 阿里云响应
            request_id: 请求ID

        Returns:
            Dict: 格式化的响应
        """
        body = response.body

        if body.code == 'OK':
            return self.format_response(
                success=True,
                message=_("sms_service.send_success"),
                data={
                    'message_id': body.biz_id,
                    'request_id': request_id,
                    'aliyun_request_id': body.request_id
                }
            )
        else:
            return self.format_response(
                success=False,
                message=_("sms_service.send_failed_detail", detail=body.message),
                error_code=body.code,
                data={
                    'request_id': request_id,
                    'aliyun_request_id': body.request_id
                }
            )

    def _handle_query_response(self, response) -> Dict[str, Any]:
        """
        处理查询响应

        Args:
            response: 阿里云响应

        Returns:
            Dict: 格式化的响应
        """
        body = response.body

        if body.code == 'OK':
            details = []
            if body.sms_send_detail_dtos and body.sms_send_detail_dtos.sms_send_detail_dto:
                for detail in body.sms_send_detail_dtos.sms_send_detail_dto:
                    details.append({
                        'phone_number': mask_phone_number(detail.phone_num),
                        'send_status': detail.send_status,
                        'send_date': detail.send_date,
                        'receive_date': detail.receive_date,
                        'template_code': detail.template_code,
                        'content': detail.content,
                        'err_code': detail.err_code
                    })

            return self.format_response(
                success=True,
                message=_("sms_service.query_success"),
                data={
                    'total_count': body.total_count,
                    'details': details
                }
            )
        else:
            return self.format_response(
                success=False,
                message=_("sms_service.query_failed", detail=body.message),
                error_code=body.code
            )

    def send_batch_sms(self, phones: list, template_code: str, template_params: Dict[str, Any]) -> Dict[str, Any]:
        """
        批量发送短信

        Args:
            phones: 手机号码列表
            template_code: 模板代码
            template_params: 模板参数

        Returns:
            Dict: 发送结果
        """
        results = []
        success_count = 0

        for phone in phones:
            try:
                result = self.send_sms(phone, template_code, template_params)
                results.append({
                    'phone': mask_phone_number(phone),
                    'success': result.get('success', False),
                    'message': result.get('message', ''),
                    'message_id': result.get('data', {}).get('message_id')
                })
                if result.get('success'):
                    success_count += 1
            except Exception as e:
                results.append({
                    'phone': mask_phone_number(phone),
                    'success': False,
                    'message': str(e)
                })

        return self.format_response(
            success=success_count > 0,
            message=_("sms_service.batch_send_done", success=success_count, total=len(phones)),
            data={
                'total': len(phones),
                'success_count': success_count,
                'failed_count': len(phones) - success_count,
                'results': results
            }
        )

    def get_account_balance(self) -> Dict[str, Any]:
        """
        查询账户余额

        Returns:
            Dict: 余额信息
        """
        try:
            # 这里可以调用阿里云的余额查询接口
            # 暂时返回模拟数据
            return self.format_response(
                success=True,
                message=_("sms_service.query_success"),
                data={
                    'balance': 'N/A',  # 需要调用具体的余额查询接口
                    'currency': 'CNY'
                }
            )
        except Exception as e:
            return self._handle_exception("get_account_balance", e)
