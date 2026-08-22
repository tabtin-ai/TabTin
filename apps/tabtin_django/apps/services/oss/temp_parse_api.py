"""
File Pipeline W3 — OSS 临时通道 (temp parse channel)

业务目标：让 Agent `read_file('./foo.pptx')` 能拿到完整 PPT 文本——客户端把
文件直传到一个**短 TTL** 的 OSS 临时对象，后端同步解析后返 chunks，**不写**
`FileRecord` / `FileUsage` / `ParsedDocument`，**不计费**，**不进 RAG**。

> 这是 file-pipeline 总控产品决策 D 的红线：行为意图决定持久化级别。临时
> 通道（read_file 工具）= 0 入库；持久通道（chat 拖文件）= OSS + RAG +
> 计费。两条通道 endpoint 物理分离避免任何"路径漂移变成持久"风险。

物理分离设计：
  - URL: `POST /services/oss/temp-parse-presign`（与 `/presign-upload` 字面 +
    路径双重区分，防止误用）
  - 不接受 `module` / `context_type` / `organization_id` 参数（持久通道入库才需要
    这些字段）
  - **绝不** import `FileRegistryService.register_uploaded_file`（持久通道核心
    路径）；本模块测试钉死这一红线
  - object_key 前缀强制 `temp-parse/{user_short}/{uuid}.{ext}`，与持久通道
    `chat/attachments/{uuid}.{ext}` 物理分离；OSS lifecycle policy 仅对
    `temp-parse/` 前缀设短 TTL（不影响持久通道）

TTL 与生命周期（T4）：
  - presigned URL TTL = 1h（与持久通道一致；客户端必须 1h 内 PUT 完）
  - object lifecycle = parse-sync 完成后**主动 delete**（主防线）+ OSS bucket
    lifecycle policy 兜底（防御性，运维 1 次性配置；命令见
    `apps.services.oss.management.commands.configure_temp_parse_lifecycle`）

错误处理：13 类全局 SSoT（`@tabtin/file-pipeline-errors`）字面值对齐。
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import uuid

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from apps.users.auth.permissions import JWTAuth

from .services.factory import get_oss_service
from ..common.cache import is_rate_limited as cache_is_rate_limited
from ..common.exceptions import OSSServiceException, ValidationException

logger = logging.getLogger(__name__)
router = Router(tags=["OSS Temp Parse Channel"])
jwt_auth = JWTAuth()


# ---------------------------------------------------------------------------
# 临时通道常量（**不**导入持久通道的 OSS_MAX_FILE_SIZE，物理隔离）
# ---------------------------------------------------------------------------

#: temp parse 单文件上限（与 read_file 临时通道边界一致——50MB 是 image
#: 硬上限，本地 doc parse 也是 50MB，临时通道沿用同款边界让 size 上限按
#: "通道"分，跨 Wave 不变量 #5）
TEMP_PARSE_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

#: presigned URL TTL（用户必须 1h 内 PUT 完文件）
TEMP_PARSE_PRESIGN_TTL_SECONDS = 3600

#: object_key 前缀（与持久通道 `chat/attachments/` 物理分离；OSS lifecycle
#: policy 配置时必须用此常量，不能写裸字符串字面值）
TEMP_PARSE_OBJECT_KEY_PREFIX = "temp-parse"

#: 临时通道支持的 MIME 白名单（W3 主场景是 PPTX；DOCX/XLSX/PDF 也可以但
#: 持久通道的 RAG 索引更优，这里只放 PPTX 是为了让"通道选择"语义清晰）。
#:
#: 后续若想让临时通道也支持别的格式，加白名单即可——但持久通道仍然是更优
#: 选择（用户拖到 chat 走深度解析）。
TEMP_PARSE_MIME_WHITELIST = frozenset({
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
})

# ── Rate limit（W3.1 收尾 L50 修复 2026-05-13）：每用户 30/min ────────
# 与 docparse parse-sync 临时通道同策略。临时通道不写持久化模型 → 审计 /
# 计费追踪缺失 → 比持久通道更适合滥用。30/min/user 是经验值（GPT-4 LLM
# 在长会话里高频读 PPTX 不超过 5/min，30 给 6× 头部余量）。
TEMP_PARSE_PRESIGN_RATE_LIMIT = 30
TEMP_PARSE_RATE_WINDOW_SECONDS = 60

#: 扩展名 → MIME（用于校验客户端声明的 mime 与文件名后缀一致）
_EXT_TO_MIME = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# 安全的文件名正则（仅允许 ASCII 字母数字 + 常见标点；防止路径穿越）
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9_.\-\u4e00-\u9fff ]{1,200}$")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class TempParsePresignRequest(Schema):
    """临时通道 presign 入参（**不**含 module / organization / context 字段）。

    **W5 L57（2026-05-14）**：`mime_type` 加 `min_length=1` + 正则约束。
    避免：
      - `mime_type=""`：空串绕过下游 `data.mime_type and ...` 短路检查（True branch 被跳过）
      - `mime_type="application/x-malicious"`：含奇怪 token 注入 OSS metadata
      - `mime_type=" application/pdf "`：前后空白让白名单 set 比对漏匹配
    校验通过后仍走 `_validate_temp_parse_input` 的扩展名一致性 + 白名单检查。
    """

    # **W5 L57（2026-05-14）**：file_name 也加 schema-level min_length=1 + max_length=200。
    # 历史上 _validate_temp_parse_input 业务函数会检 `if not data.file_name`，但 422
    # vs 200 OK 业务错的精确度差一层；schema 拒空串让客户端 / API consumer 第一时间
    # 拿到 pydantic 结构化拒绝，不用读 endpoint 业务文案猜原因。
    file_name: str = Field(
        min_length=1,
        max_length=200,
        description="原始文件名（用于推断扩展名 + 诊断日志），1-200 字符非空",
    )
    file_size_bytes: int = Field(ge=1, description="文件字节数（>0）")
    mime_type: str = Field(
        min_length=1,
        max_length=255,
        # MIME 标准格式（RFC 6838）：type/subtype，type/subtype 都是 ASCII
        # token；本表达式严于标准（不允许参数 ;charset=...），覆盖 file
        # pipeline 实际使用的 application/pdf, application/vnd.openxmlformats-*,
        # image/png 等格式即可。后续 _validate_temp_parse_input 还会做白名单
        # 一致性校验。
        pattern=r"^[a-zA-Z][a-zA-Z0-9!#$&\-^_+.]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+.]*$",
        description="MIME 类型（非空），必须在 TEMP_PARSE_MIME_WHITELIST 内",
    )


class TempParsePresignResponse(Schema):
    success: bool
    message: str = ""
    presigned_url: str = ""
    temp_object_key: str = ""
    expires_in: int = 0
    error_code: str = ""


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------

def _is_temp_parse_object_key(key: str) -> bool:
    """临时通道 object key 校验：必须以 `temp-parse/` 开头 + 长度合理。"""
    if not key or not isinstance(key, str):
        return False
    if not key.startswith(f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/"):
        return False
    if ".." in key or "//" in key or "\\" in key or "\0" in key:
        return False
    if len(key) > 256:
        return False
    return True


def _user_key_segment(user_id: str) -> str:
    """从 user_id 派生一段固定长度的 hash 前缀作为 object_key 路径中的归属标记。

    目的：让后续 parse-sync-temp 校验"调用方是 presign 时的同一个用户"
    时可以一行字符串前缀比对，不依赖额外缓存（与持久通道的 presign 缓存
    解耦——临时通道无 presign 缓存校验，避免单点失败把链路打死）。

    **W3 Review 1 H4 / Review 2 M3 修复（2026-05-13）**：
      原版本取 user_id 前 8 字符（32-bit 空间，~65k 用户后碰撞概率非平凡）+
      泄露 user_id 前缀（OSS 日志可做行为指纹）。改为 sha256(user_id)[:16]：
        - 64-bit 空间（生日悖论 ~4B 用户后才碰撞，实际无风险）
        - 不暴露原 user_id 任何位
        - 长度 16 字符仍短，URL/日志可读
      anon 段拒绝（JWTAuth 已拦但加防御性 raise，避免 anon 段共享带来交叉读取）。
    """
    if not user_id:
        # JWTAuth 已经会先拦下匿名请求；这里 raise 是 defense-in-depth，
        # 防止未来某条路径绕过 auth 后仍走 _user_key_segment。
        raise ValidationException("user_id is required for temp-parse object key derivation")
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]


def _validate_temp_parse_input(data: TempParsePresignRequest) -> tuple[str, str]:
    """统一校验临时通道入参 → 返回 (file_extension, normalized_mime)。"""
    if not data.file_name or not _SAFE_FILENAME_RE.match(data.file_name):
        raise ValidationException("file_name 格式非法")
    if "/" in data.file_name or "\\" in data.file_name:
        raise ValidationException("file_name 不允许包含路径分隔符")

    ext = os.path.splitext(data.file_name)[1].lower()
    if not ext:
        raise ValidationException("file_name 必须含扩展名")

    if ext not in _EXT_TO_MIME:
        raise ValidationException(
            f"临时通道暂不支持扩展名 {ext}（当前白名单: {sorted(_EXT_TO_MIME.keys())}）"
        )

    expected_mime = _EXT_TO_MIME[ext]
    if data.mime_type and data.mime_type != expected_mime:
        raise ValidationException(
            f"mime_type 与扩展名不匹配：声明 {data.mime_type}，扩展名 {ext} 对应 {expected_mime}"
        )

    if expected_mime not in TEMP_PARSE_MIME_WHITELIST:
        raise ValidationException(
            f"mime {expected_mime} 不在临时通道白名单（当前白名单: {sorted(TEMP_PARSE_MIME_WHITELIST)}）"
        )

    if data.file_size_bytes <= 0:
        raise ValidationException("file_size_bytes 必须 > 0")
    if data.file_size_bytes > TEMP_PARSE_MAX_FILE_SIZE_BYTES:
        raise ValidationException(
            f"文件超出临时通道上限：{data.file_size_bytes} bytes > "
            f"{TEMP_PARSE_MAX_FILE_SIZE_BYTES} bytes "
            f"（{TEMP_PARSE_MAX_FILE_SIZE_BYTES // 1024 // 1024} MB）"
        )

    return ext, expected_mime


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/temp-parse-presign", auth=jwt_auth, response=TempParsePresignResponse)
def temp_parse_presign(request: HttpRequest, data: TempParsePresignRequest) -> dict:
    """W3 临时通道：为单个 PPTX 文件生成 1h TTL 的 presigned PUT URL。

    **绝不**写 `FileRecord` / `FileUsage`。**绝不**触发 `parse_async`。
    object_key 前缀强制 `temp-parse/{user_short}/{uuid}.{ext}` 与持久通道
    物理分离。
    """
    user_id = str(getattr(request.auth, "id", "")) if getattr(request, "auth", None) else ""

    # ── Rate limit（W3.1 L50）：每用户 30/min ─────────────────────────
    # JWTAuth 已先拦匿名请求；user_id 必非空。复用通用 cache rate limiter
    # （Redis Lua 原子 + Django cache fallback），与 RateLimitMiddleware
    # 同款 cache backend 让运维监控有统一入口。
    if user_id:
        rl_limited, rl_count, rl_ttl = cache_is_rate_limited(
            "oss_temp_parse_presign",
            f"user:{user_id}",
            TEMP_PARSE_PRESIGN_RATE_LIMIT,
            TEMP_PARSE_RATE_WINDOW_SECONDS,
        )
        if rl_limited:
            logger.warning(
                "temp-parse-presign rate limited: user=%s count=%d limit=%d ttl=%ds",
                user_id[:8], rl_count, TEMP_PARSE_PRESIGN_RATE_LIMIT, rl_ttl,
            )
            return {
                "success": False,
                "message": (
                    f"临时通道 presign 请求频率超限"
                    f"（{TEMP_PARSE_PRESIGN_RATE_LIMIT}/min）"
                    f"——请等待 {max(1, rl_ttl)}s 后重试"
                ),
                "error_code": "network_failed",
            }

    try:
        ext, mime = _validate_temp_parse_input(data)
    except ValidationException as exc:
        return {
            "success": False,
            "message": str(exc),
            "error_code": "invalid_param_format",
        }

    user_seg = _user_key_segment(user_id)
    object_key = f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/{user_seg}/{uuid.uuid4().hex}{ext}"

    try:
        oss_service = get_oss_service()
        presigned_url = oss_service.generate_presigned_url(
            object_key,
            expiration=TEMP_PARSE_PRESIGN_TTL_SECONDS,
            method="PUT",
            content_type=mime,
        )
    except OSSServiceException as exc:
        logger.error("temp-parse-presign 生成签名失败: %s", exc, exc_info=True)
        return {
            "success": False,
            "message": "OSS 签名生成失败，请稍后重试",
            "error_code": "network_failed",
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("temp-parse-presign 未知异常: %s", exc, exc_info=True)
        return {
            "success": False,
            "message": "服务端异常",
            "error_code": "upstream_error",
        }

    logger.info(
        "temp-parse-presign 签发成功: user=%s object_key=%s mime=%s size=%d ttl=%ds",
        user_seg, object_key, mime, data.file_size_bytes, TEMP_PARSE_PRESIGN_TTL_SECONDS,
    )

    return {
        "success": True,
        "message": "OK",
        "presigned_url": presigned_url,
        "temp_object_key": object_key,
        "expires_in": TEMP_PARSE_PRESIGN_TTL_SECONDS,
        "error_code": "",
    }


# ---------------------------------------------------------------------------
# Helpers exported for parse-sync-temp endpoint
# ---------------------------------------------------------------------------

def assert_temp_parse_object_key(object_key: str, *, user_id: str = "") -> None:
    """parse-sync-temp 接收 temp_object_key 时的安全校验：

    1. 必须以 `temp-parse/` 开头（防止任意 OSS 对象被读 + parse + delete）
    2. 第二层路径段必须是当前 user 的 `_user_key_segment(user_id)`（防止越权
       读他人 temp 对象——不依赖 presign cache，从 key 自身的 path segment
       做归属校验）
    3. 通用路径穿越防御 + 路径深度校验

    **W4 (2026-05-13) L64 收**：合并 `_is_temp_parse_object_key` 与本函数的
    "前缀 + path 穿越 + 深度 + 归属" 4 步校验到单一调用。`_is_temp_parse_object_key`
    仅做前缀 + 路径穿越（不查归属也不查深度——presign 阶段还没有 user 上下文，
    且 deep paths 在 presign 时由 _user_key_segment 控制）。本函数做完整校验。
    """
    if not _is_temp_parse_object_key(object_key):
        raise ValidationException(
            f"非法 temp_object_key：必须以 '{TEMP_PARSE_OBJECT_KEY_PREFIX}/' 开头"
        )
    parts = object_key.split("/")
    if len(parts) < 3:
        raise ValidationException("temp_object_key 路径深度不足")
    expected_seg = _user_key_segment(user_id)
    if parts[1] != expected_seg:
        raise ValidationException(
            f"temp_object_key 归属校验失败：路径段 '{parts[1]}' 与当前用户不匹配"
        )
