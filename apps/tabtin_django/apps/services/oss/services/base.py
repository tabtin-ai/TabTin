"""
OSS服务基础抽象类
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, BinaryIO
import logging
from datetime import datetime


class OSSServiceBase(ABC):
    """OSS服务基础抽象类"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化OSS服务

        Args:
            config: 服务配置字典
        """
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)

    @abstractmethod
    def upload_file(self, file_obj: BinaryIO, object_key: str, **kwargs) -> Dict[str, Any]:
        """
        上传文件

        Args:
            file_obj: 文件对象
            object_key: 对象键
            **kwargs: 其他参数

        Returns:
            Dict: 上传结果
        """
        pass

    @abstractmethod
    def upload_bytes(self, data: bytes, object_key: str, *, content_type: str = "application/octet-stream") -> str:
        """
        上传 bytes 到 OSS，返回可访问的 URL（优先 CDN URL）。

        Args:
            data: 文件内容
            object_key: 对象键
            content_type: MIME 类型

        Returns:
            str: CDN URL 或 access URL

        Raises:
            Exception: 上传失败时抛出
        """
        pass

    @abstractmethod
    def upload_file_from_path(self, file_path: str, object_key: str, **kwargs) -> Dict[str, Any]:
        """
        从本地路径上传文件

        Args:
            file_path: 本地文件路径
            object_key: 对象键
            **kwargs: 其他参数

        Returns:
            Dict: 上传结果
        """
        pass

    @abstractmethod
    def download_file(self, object_key: str, local_path: str = None) -> Dict[str, Any]:
        """
        下载文件

        Args:
            object_key: 对象键
            local_path: 本地保存路径，如果为None则返回文件内容

        Returns:
            Dict: 下载结果
        """
        pass

    @abstractmethod
    def delete_file(self, object_key: str) -> Dict[str, Any]:
        """
        删除文件

        Args:
            object_key: 对象键

        Returns:
            Dict: 删除结果
        """
        pass

    @abstractmethod
    def delete_files(self, object_keys: List[str]) -> Dict[str, Any]:
        """
        批量删除文件

        Args:
            object_keys: 对象键列表

        Returns:
            Dict: 删除结果
        """
        pass

    @abstractmethod
    def copy_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        """
        复制文件

        Args:
            source_key: 源对象键
            target_key: 目标对象键
            **kwargs: 其他参数

        Returns:
            Dict: 复制结果
        """
        pass

    @abstractmethod
    def move_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        """
        移动文件

        Args:
            source_key: 源对象键
            target_key: 目标对象键
            **kwargs: 其他参数

        Returns:
            Dict: 移动结果
        """
        pass

    @abstractmethod
    def list_files(self, prefix: str = '', max_keys: int = 100, **kwargs) -> Dict[str, Any]:
        """
        列出文件

        Args:
            prefix: 前缀过滤
            max_keys: 最大返回数量
            **kwargs: 其他参数

        Returns:
            Dict: 文件列表
        """
        pass

    @abstractmethod
    def file_exists(self, object_key: str) -> bool:
        """
        检查文件是否存在

        Args:
            object_key: 对象键

        Returns:
            bool: 文件是否存在
        """
        pass

    @abstractmethod
    def get_file_info(self, object_key: str) -> Dict[str, Any]:
        """
        获取文件信息

        Args:
            object_key: 对象键

        Returns:
            Dict: 文件信息
        """
        pass

    @abstractmethod
    def generate_presigned_url(self, object_key: str, expiration: int = 3600,
                              method: str = 'GET',
                              content_type: str | None = None,
                              response_content_disposition: str | None = None) -> str:
        """
        生成预签名URL

        Args:
            object_key: 对象键
            expiration: 过期时间（秒）
            method: HTTP方法
            content_type: PUT 时传入，确保签名包含 Content-Type
            response_content_disposition: GET 时要求对象存储覆盖响应下载方式

        Returns:
            str: 预签名URL
        """
        pass

    def generate_bounded_upload(
        self,
        object_key: str,
        *,
        expiration: int,
        content_type: str,
        content_length: int,
    ) -> Dict[str, Any]:
        """Generate a direct-upload contract that the storage provider enforces."""
        raise NotImplementedError

    @abstractmethod
    def init_multipart_upload(self, object_key: str, **kwargs) -> Dict[str, Any]:
        """
        初始化分片上传

        Args:
            object_key: 对象键
            **kwargs: 其他参数

        Returns:
            Dict: 初始化结果，包含upload_id
        """
        pass

    @abstractmethod
    def upload_part(self, object_key: str, upload_id: str, part_number: int,
                   data: bytes) -> Dict[str, Any]:
        """
        上传分片

        Args:
            object_key: 对象键
            upload_id: 上传ID
            part_number: 分片号
            data: 分片数据

        Returns:
            Dict: 上传结果
        """
        pass

    @abstractmethod
    def complete_multipart_upload(self, object_key: str, upload_id: str,
                                 parts: List[Dict]) -> Dict[str, Any]:
        """
        完成分片上传

        Args:
            object_key: 对象键
            upload_id: 上传ID
            parts: 分片信息列表

        Returns:
            Dict: 完成结果
        """
        pass

    @abstractmethod
    def abort_multipart_upload(self, object_key: str, upload_id: str) -> Dict[str, Any]:
        """
        取消分片上传

        Args:
            object_key: 对象键
            upload_id: 上传ID

        Returns:
            Dict: 取消结果
        """
        pass

    @abstractmethod
    def get_bucket_info(self) -> Dict[str, Any]:
        """
        获取存储桶信息

        Returns:
            Dict: 存储桶信息
        """
        pass

    @abstractmethod
    def validate_config(self) -> bool:
        """
        验证配置是否有效

        Returns:
            bool: 配置是否有效
        """
        pass

    @abstractmethod
    def build_access_url(self, object_key: str) -> str:
        """
        构建标准访问 URL（无签名、公网 endpoint）。

        此 URL 用于持久化存储（FileRecord.access_url 等），永久有效。
        对 public-read bucket 可直接访问；private bucket 需配合
        get_accessible_url() 使用。

        Args:
            object_key: 对象键

        Returns:
            str: 标准访问 URL
        """
        pass

    def get_accessible_url(self, object_key: str, expiration: int = 3600) -> str:
        """
        获取可实际访问的 URL。

        - public-read: 返回标准 URL（等同 build_access_url）
        - private: 返回带签名的临时 URL（有 TTL，不可持久化）

        Args:
            object_key: 对象键
            expiration: 签名有效期（秒），仅 private bucket 生效

        Returns:
            str: 可访问的 URL
        """
        return self.build_access_url(object_key)

    def set_object_public_read(self, object_key: str) -> bool:
        """Mark an object as public-read when the provider supports per-object ACL."""
        return False

    def set_object_private(self, object_key: str) -> bool:
        """Mark an object as private when the provider supports per-object ACL.

        Needed on public-read buckets so newly uploaded private objects do not
        inherit anonymous bucket-level readability (TabDoc HTML ).
        """
        return False

    @abstractmethod
    def build_cdn_url(self, object_key: str) -> str:
        """
        构建 CDN URL

        Args:
            object_key: 对象键

        Returns:
            str: CDN URL（无 CDN 配置时返回空字符串）
        """
        pass

    def get_required_config_keys(self) -> List[str]:
        """
        获取必需的配置键

        Returns:
            List[str]: 必需的配置键列表
        """
        return ['bucket_name', 'endpoint', 'region']

    def format_response(self, success: bool, message: str, data: Any = None,
                       error_code: str = None) -> Dict[str, Any]:
        """
        格式化响应

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
            'timestamp': self._get_timestamp(),
            'error_code': error_code,
            'data': data
        }
        return response

    def _get_timestamp(self) -> str:
        """获取当前时间戳"""
        from datetime import datetime
        return datetime.now().isoformat()

    def _log_request(self, action: str, params: Dict[str, Any]) -> None:
        """记录请求日志"""
        from apps.services.common.utils import sanitize_log_data

        sanitized_params = sanitize_log_data(params)
        self.logger.info(f"OSS服务请求 - 动作: {action}, 参数: {sanitized_params}")

    def _log_response(self, action: str, response: Dict[str, Any]) -> None:
        """记录响应日志"""
        success = response.get('success', False)
        message = response.get('message', '')
        self.logger.info(f"OSS服务响应 - 动作: {action}, 成功: {success}, 消息: {message}")

    def _handle_exception(self, action: str, exception: Exception) -> Dict[str, Any]:
        """处理异常。对象不存在是预期 404，不打 error，避免 Sentry 当故障。"""
        error_message = str(exception)
        error_code = self._classify_oss_error(exception, error_message)

        if error_code == 'FILE_NOT_FOUND':
            self.logger.warning(f"OSS对象不存在 - 动作: {action}, 错误: {error_message}")
        else:
            self.logger.error(f"OSS服务异常 - 动作: {action}, 错误: {error_message}", exc_info=True)

        return self.format_response(
            success=False,
            message=f"OSS服务异常: {error_message}",
            error_code=error_code
        )

    @staticmethod
    def _classify_oss_error(exception: Exception, error_message: str) -> str:
        name = type(exception).__name__
        code = getattr(exception, 'code', None) or getattr(exception, 'error_code', None)
        status = getattr(exception, 'status', None)
        lowered = error_message.lower()

        if 'NoSuchBucket' in error_message or name == 'NoSuchBucket':
            return 'BUCKET_NOT_FOUND'
        if (
            name in {'NoSuchKey', 'NotFound'}
            or code in {'NoSuchKey', 'NotFound'}
            or status == 404
            or 'NoSuchKey' in error_message
            or 'specified key does not exist' in lowered
        ):
            return 'FILE_NOT_FOUND'
        if 'AccessDenied' in error_message:
            return 'ACCESS_DENIED'
        if 'InvalidCredentials' in error_message:
            return 'INVALID_CREDENTIALS'
        if 'NetworkError' in error_message:
            return 'NETWORK_ERROR'
        return 'OSS_SERVICE_ERROR'
