"""
阿里云OSS服务实现
"""

import os
import json
import hashlib
import base64
import hmac
import requests
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, BinaryIO
from django.conf import settings
import oss2
from oss2.credentials import Credentials

from .base import OSSServiceBase
from apps.i18n import _
from apps.services.common.exceptions import OSSServiceException, AuthenticationException, NetworkException
from apps.services.common.utils import generate_request_id


class AliyunOSSService(OSSServiceBase):
    """阿里云OSS服务实现"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化阿里云OSS服务

        Args:
            config: 服务配置
        """
        super().__init__(config)
        self.bucket = None
        self._init_client()

    def _init_client(self):
        """初始化阿里云OSS客户端"""
        try:
            # 获取临时凭证
            credentials = self._get_ecs_credentials()

            if credentials:
                # 使用临时凭证创建认证对象
                auth = oss2.StsAuth(
                    credentials['AccessKeyId'],
                    credentials['AccessKeySecret'],
                    credentials['SecurityToken']
                )
                self._upload_credentials = {
                    "access_key_id": credentials["AccessKeyId"],
                    "access_key_secret": credentials["AccessKeySecret"],
                    "security_token": credentials["SecurityToken"],
                }

                self.logger.info(f"成功获取ECS RAM角色凭证，AccessKeyId: {credentials['AccessKeyId'][:8]}...")
            else:
                # 回退到环境变量方式
                access_key_id = self.config.get('access_key_id', '')
                access_key_secret = self.config.get('access_key_secret', '')

                if not access_key_id or not access_key_secret:
                    raise AuthenticationException("未配置阿里云访问密钥")

                auth = oss2.Auth(access_key_id, access_key_secret)
                self._upload_credentials = {
                    "access_key_id": access_key_id,
                    "access_key_secret": access_key_secret,
                    "security_token": self.config.get("security_token") or "",
                }
                self.logger.info("使用AccessKey方式创建OSS认证")

            # 选择合适的endpoint
            endpoint = self._get_endpoint()
            bucket_name = self.config.get('bucket_name')

            if not bucket_name:
                raise OSSServiceException("未配置存储桶名称")

            # 创建Bucket对象
            self.bucket = oss2.Bucket(auth, endpoint, bucket_name)

            self.logger.info(f"阿里云OSS客户端初始化成功: {bucket_name}@{endpoint}")

        except Exception as e:
            self.logger.error(f"阿里云OSS客户端初始化失败: {e}")
            raise AuthenticationException(f"OSS服务认证失败: {e}")

    def _get_ecs_credentials(self):
        """获取ECS实例RAM角色凭证（本地开发时通过 ALIYUN_USE_ECS_ROLE=False 跳过）"""
        use_ecs_role = getattr(settings, 'ALIYUN_USE_ECS_ROLE', True)
        if not use_ecs_role:
            self.logger.debug("ALIYUN_USE_ECS_ROLE=False，跳过ECS凭证获取")
            return None

        try:
            role_name = getattr(settings, 'ALIYUN_ECS_ROLE_NAME', 'ecs')
            metadata_url = f"http://100.100.100.200/latest/meta-data/ram/security-credentials/{role_name}"

            response = requests.get(metadata_url, timeout=5)
            response.raise_for_status()

            credentials = response.json()

            required_keys = ['AccessKeyId', 'AccessKeySecret', 'SecurityToken']
            if all(key in credentials for key in required_keys):
                return credentials
            else:
                self.logger.error(f"ECS凭证格式不正确: {credentials}")
                return None

        except Exception as e:
            self.logger.error(f"获取ECS凭证失败: {e}")
            return None

    @property
    def _public_endpoint(self) -> str:
        """公网 endpoint（不含协议前缀），用于面向客户端的 URL"""
        ep = self.config.get('endpoint')
        if ep:
            return ep
        region = self.config.get('region', 'oss-cn-wuhan-lr')
        return f"{region}.aliyuncs.com"

    @property
    def _using_internal_endpoint(self) -> bool:
        return bool(self.config.get('internal_endpoint'))

    def _get_endpoint(self) -> str:
        """获取服务端使用的 endpoint（优先内网以节省流量）"""
        internal_endpoint = self.config.get('internal_endpoint')
        if internal_endpoint:
            return f"https://{internal_endpoint}"

        return f"https://{self._public_endpoint}"

    _UPLOAD_MAX_BYTES = 200 * 1024 * 1024  # 200 MB hard cap at service layer

    def upload_file(self, file_obj: BinaryIO, object_key: str, **kwargs) -> Dict[str, Any]:
        """上传文件（流式传输，避免一次性全部加载到内存）。

        kwargs:
            content_type: MIME 类型
            file_hash: 调用方已计算的 MD5 hex，传入后跳过重复计算
            file_size: 调用方已知的文件大小，传入后跳过重复计算
        """
        request_id = generate_request_id()

        try:
            self._log_request("upload_file", {
                'object_key': object_key,
                'request_id': request_id,
                'content_type': kwargs.get('content_type'),
            })

            file_obj.seek(0, 2)
            file_size = kwargs.get('file_size') or file_obj.tell()
            file_obj.seek(0)

            if file_size > self._UPLOAD_MAX_BYTES:
                raise OSSServiceException(
                    f"File size {file_size} exceeds limit {self._UPLOAD_MAX_BYTES}"
                )

            pre_hash = kwargs.get('file_hash')
            if pre_hash:
                file_hash = pre_hash
            else:
                md5 = hashlib.md5()
                for chunk in iter(lambda: file_obj.read(8192), b''):
                    md5.update(chunk)
                file_hash = md5.hexdigest()
                file_obj.seek(0)

            headers = {}
            if 'content_type' in kwargs:
                headers['Content-Type'] = kwargs['content_type']

            result = self.bucket.put_object(object_key, file_obj, headers=headers)

            access_url = self.build_access_url(object_key)

            response_data = {
                'object_key': object_key,
                'file_size': file_size,
                'file_hash': file_hash,
                'etag': result.etag,
                'request_id': result.request_id,
                'access_url': access_url,
                'cdn_url': self.build_cdn_url(object_key),
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_upload_success"),
                data=response_data,
            )
            self._log_response("upload_file", response)
            return response

        except Exception as e:
            return self._handle_exception("upload_file", e)

    def upload_bytes(self, data: bytes, object_key: str, *, content_type: str = "application/octet-stream") -> str:
        """上传 bytes 到 OSS，返回可即时访问的 URL（优先 CDN URL）。"""
        from io import BytesIO
        result = self.upload_file(BytesIO(data), object_key, content_type=content_type)
        if result.get("success") and result.get("data"):
            cdn_url = result["data"].get("cdn_url")
            if cdn_url:
                return cdn_url
            return self.get_accessible_url(object_key)
        raise OSSServiceException(result.get("message", "OSS upload_bytes failed"))

    def upload_file_from_path(self, file_path: str, object_key: str, **kwargs) -> Dict[str, Any]:
        """从本地路径上传文件"""
        try:
            if not os.path.exists(file_path):
                raise OSSServiceException(f"文件不存在: {file_path}")

            with open(file_path, 'rb') as f:
                return self.upload_file(f, object_key, **kwargs)

        except Exception as e:
            return self._handle_exception("upload_file_from_path", e)

    def download_file(self, object_key: str, local_path: str = None) -> Dict[str, Any]:
        """下载文件"""
        request_id = generate_request_id()

        try:
            self._log_request("download_file", {
                'object_key': object_key,
                'local_path': local_path,
                'request_id': request_id
            })

            if local_path:
                # 下载到本地文件
                result = self.bucket.get_object_to_file(object_key, local_path)

                response_data = {
                    'object_key': object_key,
                    'local_path': local_path,
                    'file_size': os.path.getsize(local_path),
                    'request_id': result.request_id
                }
            else:
                # 获取文件内容
                result = self.bucket.get_object(object_key)
                content = result.read()

                response_data = {
                    'object_key': object_key,
                    'content': content,
                    'file_size': len(content),
                    'content_type': result.content_type,
                    'request_id': result.request_id
                }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_download_success"),
                data=response_data
            )

            self._log_response("download_file", response)
            return response

        except Exception as e:
            return self._handle_exception("download_file", e)

    def delete_file(self, object_key: str) -> Dict[str, Any]:
        """删除文件"""
        request_id = generate_request_id()

        try:
            self._log_request("delete_file", {
                'object_key': object_key,
                'request_id': request_id
            })

            result = self.bucket.delete_object(object_key)

            response_data = {
                'object_key': object_key,
                'request_id': result.request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_delete_success"),
                data=response_data
            )

            self._log_response("delete_file", response)
            return response

        except Exception as e:
            return self._handle_exception("delete_file", e)

    def delete_files(self, object_keys: List[str]) -> Dict[str, Any]:
        """批量删除文件"""
        request_id = generate_request_id()

        try:
            self._log_request("delete_files", {
                'object_keys_count': len(object_keys),
                'request_id': request_id
            })

            result = self.bucket.batch_delete_objects(object_keys)

            response_data = {
                'deleted_keys': result.deleted_keys,
                'delete_count': len(result.deleted_keys),
                'request_id': request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.batch_delete_success", count=len(result.deleted_keys)),
                data=response_data
            )

            self._log_response("delete_files", response)
            return response

        except Exception as e:
            return self._handle_exception("delete_files", e)

    def copy_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        """复制文件"""
        request_id = generate_request_id()

        try:
            self._log_request("copy_file", {
                'source_key': source_key,
                'target_key': target_key,
                'request_id': request_id
            })

            source_bucket = kwargs.get('source_bucket', self.config.get('bucket_name'))

            result = self.bucket.copy_object(source_bucket, source_key, target_key)

            response_data = {
                'source_key': source_key,
                'target_key': target_key,
                'etag': result.etag,
                'request_id': result.request_id,
                'access_url': self.build_access_url(target_key)
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_copy_success"),
                data=response_data
            )

            self._log_response("copy_file", response)
            return response

        except Exception as e:
            return self._handle_exception("copy_file", e)

    def move_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        """移动文件"""
        try:
            # 先复制文件
            copy_result = self.copy_file(source_key, target_key, **kwargs)

            if copy_result['success']:
                # 删除源文件
                delete_result = self.delete_file(source_key)

                if delete_result['success']:
                    response = self.format_response(
                        success=True,
                        message=_("oss_service.file_move_success"),
                        data=copy_result['data']
                    )
                else:
                    # 复制成功但删除失败，记录警告
                    self.logger.warning(f"文件复制成功但删除源文件失败: {source_key}")
                    response = self.format_response(
                        success=True,
                        message=_("oss_service.file_copy_delete_source_failed"),
                        data=copy_result['data']
                    )
            else:
                response = copy_result

            return response

        except Exception as e:
            return self._handle_exception("move_file", e)

    def list_files(self, prefix: str = '', max_keys: int = 100, **kwargs) -> Dict[str, Any]:
        """列出文件"""
        request_id = generate_request_id()

        try:
            self._log_request("list_files", {
                'prefix': prefix,
                'max_keys': max_keys,
                'request_id': request_id
            })

            marker = kwargs.get('marker', '')
            delimiter = kwargs.get('delimiter', '')

            result = self.bucket.list_objects(
                prefix=prefix,
                marker=marker,
                max_keys=max_keys,
                delimiter=delimiter
            )

            files = []
            for obj in result.object_list:
                files.append({
                    'key': obj.key,
                    'size': obj.size,
                    'etag': obj.etag,
                    'type': obj.type,
                    'storage_class': obj.storage_class,
                    'last_modified': str(obj.last_modified) if obj.last_modified else None,
                    'access_url': self.build_access_url(obj.key)
                })

            response_data = {
                'files': files,
                'file_count': len(files),
                'is_truncated': result.is_truncated,
                'next_marker': result.next_marker,
                'prefix': prefix,
                'request_id': request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_list_success", count=len(files)),
                data=response_data
            )

            self._log_response("list_files", response)
            return response

        except Exception as e:
            return self._handle_exception("list_files", e)

    def file_exists(self, object_key: str) -> bool:
        """检查文件是否存在。

        Raises:
            OSSServiceException: OSS 服务不可达或权限异常时抛出，
                调用方应返回 503 而非将其误报为文件不存在。
        """
        try:
            return self.bucket.object_exists(object_key)
        except oss2.exceptions.NoSuchKey:
            return False
        except oss2.exceptions.OssError as e:
            if e.status == 404:
                return False
            self.logger.error("file_exists OSS 服务异常 (status=%s): %s", e.status, e)
            raise OSSServiceException(f"OSS 服务异常，无法验证文件存在性: {e}")
        except Exception as e:
            self.logger.error("file_exists 未预期异常: %s", e)
            raise OSSServiceException(f"OSS 服务异常: {e}")

    def get_file_info(self, object_key: str) -> Dict[str, Any]:
        """获取文件信息"""
        request_id = generate_request_id()

        try:
            self._log_request("get_file_info", {
                'object_key': object_key,
                'request_id': request_id
            })

            result = self.bucket.head_object(object_key)

            response_data = {
                'object_key': object_key,
                'content_length': result.content_length,
                'content_type': result.content_type,
                'etag': result.etag,
                'last_modified': str(result.last_modified) if result.last_modified else None,
                'storage_class': getattr(result, 'storage_class', 'Standard'),
                'metadata': dict(result.headers),
                'access_url': self.build_access_url(object_key),
                'request_id': request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.file_info_success"),
                data=response_data
            )

            self._log_response("get_file_info", response)
            return response

        except Exception as e:
            return self._handle_exception("get_file_info", e)

    def generate_presigned_url(self, object_key: str, expiration: int = 3600,
                              method: str = 'GET',
                              content_type: str | None = None,
                              response_content_disposition: str | None = None) -> str:
        """生成预签名URL

        Args:
            content_type: PUT 请求必须传入，确保签名包含 Content-Type，
                          否则客户端带 Content-Type 头的请求会因签名不匹配而 403。

        注意：当服务端使用内网 endpoint 时，生成的 URL 会自动替换为公网域名，
        因为签名不包含域名，替换安全可靠。
        """
        try:
            headers = {'Content-Type': content_type} if content_type else None
            params = (
                {'response-content-disposition': response_content_disposition}
                if response_content_disposition
                else None
            )
            url = self.bucket.sign_url(method, object_key, expiration,
                                       headers=headers, params=params, slash_safe=True)
            url = self._ensure_public_domain(url)
            return url
        except Exception as e:
            self.logger.error(f"生成预签名URL失败: {e}")
            raise OSSServiceException(f"生成预签名URL失败: {e}")

    def generate_bounded_upload(
        self,
        object_key: str,
        *,
        expiration: int,
        content_type: str,
        content_length: int,
    ) -> Dict[str, Any]:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expiration)
        policy = {
            "expiration": expires_at.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "conditions": [
                {"bucket": self.config["bucket_name"]},
                ["eq", "$key", object_key],
                ["eq", "$content-type", content_type],
                ["content-length-range", content_length, content_length],
                ["eq", "$success_action_status", "200"],
            ],
        }
        token = self._upload_credentials.get("security_token")
        fields = {
            "key": object_key,
            "Content-Type": content_type,
            "success_action_status": "200",
            "OSSAccessKeyId": self._upload_credentials["access_key_id"],
        }
        if token:
            policy["conditions"].append({"x-oss-security-token": token})
            fields["x-oss-security-token"] = token
        encoded_policy = base64.b64encode(
            json.dumps(policy, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        signature = base64.b64encode(
            hmac.new(
                self._upload_credentials["access_key_secret"].encode("utf-8"),
                encoded_policy.encode("ascii"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        fields.update({"policy": encoded_policy, "Signature": signature})
        return {
            "method": "POST",
            "url": f"https://{self.config['bucket_name']}.{self._public_endpoint}/",
            "fields": fields,
        }

    def generate_part_presigned_url(
        self, object_key: str, upload_id: str, part_number: int,
        expiration: int = 600,
    ) -> str:
        """为分片上传的单个 part 生成预签名 PUT URL。"""
        try:
            params = {
                'uploadId': upload_id,
                'partNumber': str(part_number),
            }
            url = self.bucket.sign_url('PUT', object_key, expiration, params=params, slash_safe=True)
            return self._ensure_public_domain(url)
        except Exception as e:
            self.logger.error(f"生成分片预签名URL失败: {e}")
            raise OSSServiceException(f"生成分片预签名URL失败: {e}")

    def init_multipart_upload(self, object_key: str, **kwargs) -> Dict[str, Any]:
        """初始化分片上传"""
        request_id = generate_request_id()

        try:
            self._log_request("init_multipart_upload", {
                'object_key': object_key,
                'request_id': request_id
            })

            headers = {}
            if 'content_type' in kwargs:
                headers['Content-Type'] = kwargs['content_type']

            result = self.bucket.init_multipart_upload(object_key, headers=headers)

            response_data = {
                'object_key': object_key,
                'upload_id': result.upload_id,
                'request_id': result.request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.multipart_init_success"),
                data=response_data
            )

            self._log_response("init_multipart_upload", response)
            return response

        except Exception as e:
            return self._handle_exception("init_multipart_upload", e)

    def upload_part(self, object_key: str, upload_id: str, part_number: int,
                   data: bytes) -> Dict[str, Any]:
        """上传分片"""
        try:
            result = self.bucket.upload_part(object_key, upload_id, part_number, data)

            response_data = {
                'object_key': object_key,
                'upload_id': upload_id,
                'part_number': part_number,
                'etag': result.etag,
                'request_id': result.request_id
            }

            return self.format_response(
                success=True,
                message=_("oss_service.part_upload_success", part_number=part_number),
                data=response_data
            )

        except Exception as e:
            return self._handle_exception("upload_part", e)

    def complete_multipart_upload(self, object_key: str, upload_id: str,
                                 parts: List[Dict]) -> Dict[str, Any]:
        """完成分片上传"""
        request_id = generate_request_id()

        try:
            self._log_request("complete_multipart_upload", {
                'object_key': object_key,
                'upload_id': upload_id,
                'parts_count': len(parts),
                'request_id': request_id
            })

            # 转换分片信息格式
            part_info_list = []
            for part in parts:
                part_info = oss2.models.PartInfo(part['part_number'], part['etag'])
                part_info_list.append(part_info)

            result = self.bucket.complete_multipart_upload(object_key, upload_id, part_info_list)

            response_data = {
                'object_key': object_key,
                'upload_id': upload_id,
                'etag': getattr(result, 'etag', ''),
                'request_id': getattr(result, 'request_id', ''),
                'access_url': self.build_access_url(object_key)
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.multipart_complete_success"),
                data=response_data
            )

            self._log_response("complete_multipart_upload", response)
            return response

        except Exception as e:
            return self._handle_exception("complete_multipart_upload", e)

    def abort_multipart_upload(self, object_key: str, upload_id: str) -> Dict[str, Any]:
        """取消分片上传"""
        request_id = generate_request_id()

        try:
            self._log_request("abort_multipart_upload", {
                'object_key': object_key,
                'upload_id': upload_id,
                'request_id': request_id
            })

            result = self.bucket.abort_multipart_upload(object_key, upload_id)

            response_data = {
                'object_key': object_key,
                'upload_id': upload_id,
                'request_id': result.request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.multipart_cancel_success"),
                data=response_data
            )

            self._log_response("abort_multipart_upload", response)
            return response

        except Exception as e:
            return self._handle_exception("abort_multipart_upload", e)

    def get_bucket_info(self) -> Dict[str, Any]:
        """获取存储桶信息"""
        request_id = generate_request_id()

        try:
            self._log_request("get_bucket_info", {'request_id': request_id})

            result = self.bucket.get_bucket_info()

            response_data = {
                'bucket_name': result.name,
                'location': result.location,
                'creation_date': result.creation_date if result.creation_date else None,
                'storage_class': result.storage_class,
                'owner': {
                    'id': result.owner.id if result.owner else None,
                    'display_name': result.owner.display_name if result.owner else None
                },
                'request_id': request_id
            }

            response = self.format_response(
                success=True,
                message=_("oss_service.bucket_info_success"),
                data=response_data
            )

            self._log_response("get_bucket_info", response)
            return response

        except Exception as e:
            return self._handle_exception("get_bucket_info", e)

    def validate_config(self) -> bool:
        """验证配置是否有效"""
        try:
            required_keys = self.get_required_config_keys()
            for key in required_keys:
                if not self.config.get(key):
                    self.logger.error(f"缺少必需配置: {key}")
                    return False

            # 尝试获取存储桶信息来验证连接
            result = self.get_bucket_info()
            return result['success']

        except Exception as e:
            self.logger.error(f"配置验证失败: {e}")
            return False

    def _ensure_public_domain(self, url: str) -> str:
        """将内网 endpoint 域名替换为公网域名。

        安全性依据：OSS V1 签名的 CanonicalizedResource 仅含 /{bucket}/{key}，
        不包含 host，因此替换域名不影响签名校验。
        ⚠️ 若 oss2 升级为 V4 签名且启用 x-oss-additional-headers=host，
        host 会参与签名，届时需改为双 Bucket（内网操作 + 公网签名）方案。

        当服务端未使用内网 endpoint 时直接返回原 URL。
        """
        if not self._using_internal_endpoint:
            return url
        internal_ep = self.config['internal_endpoint']
        return url.replace(internal_ep, self._public_endpoint, 1)

    def build_access_url(self, object_key: str) -> str:
        """构建标准访问 URL（无签名、公网 endpoint）。

        此 URL 用于**持久化存储**（写入 FileRecord.access_url 等），
        不含签名参数，永久有效。对于 public-read bucket 可直接访问；
        private bucket 需通过 get_accessible_url() 获取带签名的临时 URL。
        """
        bucket_name = self.config.get('bucket_name')
        return f"https://{bucket_name}.{self._public_endpoint}/{object_key}"

    _build_access_url = build_access_url

    def get_accessible_url(self, object_key: str, expiration: int = 3600) -> str:
        """获取可实际访问的 URL。

        - public-read / public-read-write: 直接返回标准 URL
        - private: 动态生成签名 URL（有 TTL，不可持久化）
        """
        if self.config.get('access_mode') in ('public-read', 'public-read-write'):
            return self.build_access_url(object_key)
        return self.generate_presigned_url(object_key, expiration=expiration)

    def set_object_public_read(self, object_key: str) -> bool:
        """Use backend OSS credentials to make a confirmed public asset readable."""
        try:
            self.bucket.put_object_acl(object_key, oss2.OBJECT_ACL_PUBLIC_READ)
            return True
        except Exception as e:
            self.logger.warning("设置 OSS 对象 public-read 失败: key=%s, err=%s", object_key, e)
            return False

    def set_object_private(self, object_key: str) -> bool:
        """Force object ACL private so public-read buckets do not leak new private assets."""
        try:
            self.bucket.put_object_acl(object_key, oss2.OBJECT_ACL_PRIVATE)
            return True
        except Exception as e:
            self.logger.warning("设置 OSS 对象 private 失败: key=%s, err=%s", object_key, e)
            return False

    def build_cdn_url(self, object_key: str) -> str:
        """构建CDN URL"""
        cdn_domain = self.config.get('cdn_domain')
        if cdn_domain:
            return f"https://{cdn_domain}/{object_key}"
        return ""

    _build_cdn_url = build_cdn_url

    def get_required_config_keys(self) -> List[str]:
        """获取必需的配置键"""
        return ['bucket_name', 'endpoint', 'region']
