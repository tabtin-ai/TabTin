"""Word 兼容载荷（.doc / OLE / RTF / HTML）→ .docx 转换。

python-docx 只能读 OOXML ZIP。扩展名为 .doc 的文件常见几种真实载荷：
- OLE 复合文档（经典二进制 .doc）
- RTF（WPS / 部分 Word「另存为」）
- HTML / MHTML（网页另存为 Word）
- 已是 ZIP 的 .docx（误标扩展名）

优先 LibreOffice soffice；Windows 本机可回退 Word COM。
RTF 在无转换器时可由调用方降级为纯文本提取。
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

OLE_CFB_MAGIC = b"\xd0\xcf\x11\xe0"

WordPayloadKind = Literal["ole", "docx_zip", "rtf", "html", "unknown"]

_SOFFICE_CANDIDATES = (
    "soffice",
    "soffice.exe",
    "libreoffice",
    "libreoffice.exe",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
)

_WORD_EXE_CANDIDATES = (
    r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files\Microsoft Office\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\Office16\WINWORD.EXE",
)

LEGACY_DOC_UNSUPPORTED_MSG = (
    "暂不支持直接解析旧版 Word（.doc）。"
    "请用 Word / WPS 另存为 .docx 后再导入；"
    "或在本机安装 LibreOffice 后重试（服务端可用 soffice 自动转换）。"
)

UNRECOGNIZED_WORD_PAYLOAD_MSG = (
    "无法识别的 Word 文件格式。"
    "请确认文件是有效的 .doc / .docx，或另存为 .docx / .md / .txt 后再导入。"
)

# 简化 RTF → 文本：控制字 / 十六进制转义 / 分组括号
_RTF_TOKEN_RE = re.compile(
    r"\\([a-z]{1,32})(-?\d{1,10})?[ ]?"
    r"|\\'([0-9a-f]{2})"
    r"|\\([^a-z])"
    r"|([{}])"
    r"|[\r\n]+"
    r"|(.)",
    re.IGNORECASE | re.DOTALL,
)


def is_legacy_ole_doc(file_path: str) -> bool:
    """判断是否为旧版 OLE 复合文档（典型 .doc），而非 ZIP 包装的 .docx。"""
    return detect_word_payload_kind(file_path) == "ole"


def detect_word_payload_kind(file_path: str) -> WordPayloadKind:
    """根据文件头识别 .doc 扩展名背后的真实载荷。"""
    try:
        with open(file_path, "rb") as handle:
            header = handle.read(512)
    except OSError:
        return "unknown"

    if not header:
        return "unknown"
    if header.startswith(OLE_CFB_MAGIC):
        return "ole"
    if zipfile.is_zipfile(file_path):
        return "docx_zip"

    stripped = header.lstrip()
    if stripped.startswith(b"{\\rtf"):
        return "rtf"

    # UTF-16 LE BOM 的 RTF（少见但仍见于部分导出）
    if header.startswith(b"\xff\xfe") and b"{\\rtf" in header[:64].replace(b"\x00", b""):
        return "rtf"

    lower = stripped[:80].lower()
    if (
        lower.startswith(b"<!doctype html")
        or lower.startswith(b"<html")
        or lower.startswith(b"<head")
        or lower.startswith(b"<meta")
    ):
        return "html"

    # MIME HTML（.mht / 部分「网页另存为」）
    if lower.startswith(b"mime-version:") and b"text/html" in header.lower():
        return "html"

    return "unknown"


def convert_legacy_doc_to_docx(file_path: str) -> str:
    """将 OLE .doc 转为临时 .docx，返回新路径。失败抛 ValueError。"""
    if detect_word_payload_kind(file_path) != "ole":
        raise ValueError("不是旧版 Word（.doc）文件")
    return convert_word_payload_to_docx(file_path)


def convert_word_payload_to_docx(file_path: str) -> str:
    """将 OLE / RTF / HTML Word 载荷转为临时 .docx。失败抛 ValueError。"""
    kind = detect_word_payload_kind(file_path)
    if kind not in ("ole", "rtf", "html"):
        raise ValueError(UNRECOGNIZED_WORD_PAYLOAD_MSG)

    file_size = os.path.getsize(file_path)
    if file_size <= 0:
        raise ValueError("文件为空，无法转换 Word 文档")

    errors: list[str] = []

    soffice = _resolve_soffice()
    if soffice:
        try:
            return _convert_with_soffice(file_path, soffice)
        except Exception as exc:  # noqa: BLE001 — 逐个转换器降级
            logger.warning("LibreOffice 转换 Word 载荷失败 kind=%s: %s", kind, exc, exc_info=True)
            errors.append(f"LibreOffice: {exc}")
    else:
        errors.append("LibreOffice: 未找到 soffice")

    if os.name == "nt" and _resolve_winword():
        try:
            return _convert_with_word_com(file_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Word COM 转换失败 kind=%s: %s", kind, exc, exc_info=True)
            errors.append(f"Word: {exc}")
    elif os.name == "nt":
        errors.append("Word: 未找到 WINWORD.EXE")

    detail = "；".join(errors) if errors else "无可用转换器"
    if kind == "ole":
        raise ValueError(f"{LEGACY_DOC_UNSUPPORTED_MSG}（{detail}）")
    raise ValueError(
        f"无法将 {kind.upper()} 格式的 Word 文件转换为 .docx（{detail}）。"
        "请用 Word / WPS 另存为 .docx 后再导入。"
    )


def _decode_rtf_bytes(raw: bytes) -> str:
    for encoding in ("utf-8", "cp1252", "gbk", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _extract_rtf_plaintext_from_text(text: str) -> str:
    """从 RTF 源文本剥离控制字，保留可见字符与段落换行。"""
    out: list[str] = []
    for match in _RTF_TOKEN_RE.finditer(text):
        control, number, hex_code, esc, brace, char = match.groups()
        if brace is not None:
            continue
        if control is not None:
            control_l = control.lower()
            if control_l in {"par", "line", "page"}:
                out.append("\n")
            elif control_l == "tab":
                out.append("\t")
            elif control_l == "u" and number is not None:
                try:
                    code = int(number)
                    if code < 0:
                        code += 65536
                    out.append(chr(code))
                except (ValueError, OverflowError):
                    pass
            continue
        if hex_code is not None:
            try:
                out.append(bytes.fromhex(hex_code).decode("cp1252", errors="replace"))
            except ValueError:
                pass
            continue
        if esc is not None:
            if esc in "{}\\":
                out.append(esc)
            continue
        if char is not None:
            out.append(char)

    lines = [line.rstrip() for line in "".join(out).splitlines()]
    compact: list[str] = []
    blank_run = 0
    for line in lines:
        if not line.strip():
            blank_run += 1
            if blank_run <= 1:
                compact.append("")
            continue
        blank_run = 0
        compact.append(line)
    return "\n".join(compact).strip()


def extract_rtf_plaintext(file_path: str) -> str:
    """无 LibreOffice 时的 RTF 纯文本降级提取（保真度有限）。"""
    raw = Path(file_path).read_bytes()
    text = _decode_rtf_bytes(raw)
    if "{\\rtf" not in text[:64].replace("\x00", ""):
        raise ValueError("不是有效的 RTF 文档")
    return _extract_rtf_plaintext_from_text(text)


def _resolve_soffice() -> str | None:
    for candidate in _SOFFICE_CANDIDATES:
        if os.path.isabs(candidate):
            if os.path.isfile(candidate):
                return candidate
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


def _resolve_winword() -> str | None:
    for candidate in _WORD_EXE_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return shutil.which("WINWORD.EXE")


def _convert_with_soffice(file_path: str, soffice: str) -> str:
    out_dir = tempfile.mkdtemp(prefix="tabtin-doc-convert-")
    profile_dir = tempfile.mkdtemp(prefix="tabtin-soffice-profile-")
    try:
        # LibreOffice 用户配置目录需 file:// URL，避免并发锁
        profile_uri = Path(profile_dir).as_uri()
        cmd = [
            soffice,
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--nodefault",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation={profile_uri}",
            "--convert-to",
            "docx",
            "--outdir",
            out_dir,
            file_path,
        ]
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(stderr or f"soffice exit {completed.returncode}")

        produced = list(Path(out_dir).glob("*.docx"))
        if not produced:
            raise RuntimeError("LibreOffice 未生成 .docx")
        # 挪到独立临时文件，便于调用方单独清理
        dest = tempfile.NamedTemporaryFile(delete=False, suffix=".docx", prefix="tabtin-doc-")
        dest.close()
        shutil.move(str(produced[0]), dest.name)
        return dest.name
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        shutil.rmtree(profile_dir, ignore_errors=True)


# Office MsoAutomationSecurity：3 = msoAutomationSecurityForceDisable
_MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3


def _ps_literal(value: str) -> str:
    """PowerShell 单引号字面量；内部单引号加倍。"""
    return "'" + value.replace("'", "''") + "'"


def _build_word_com_ps_script(src: str, dest: str) -> str:
    """生成 Word COM 转换脚本。

    必须在 Documents.Open 前将 AutomationSecurity 设为 ForceDisable，
    避免不可信 .doc 宏继承本机 Word 策略而执行；finally 中恢复原值。
    """
    src_lit = _ps_literal(src)
    dest_lit = _ps_literal(dest)
    force_disable = _MSO_AUTOMATION_SECURITY_FORCE_DISABLE
    return f"""
$ErrorActionPreference = 'Stop'
$src = {src_lit}
$dst = {dest_lit}
$word = $null
$doc = $null
$prevAutomationSecurity = $null
try {{
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # P1: 导入不可信文档时强制禁用宏，勿继承本机 Trust Center 策略
  $prevAutomationSecurity = $word.AutomationSecurity
  $word.AutomationSecurity = {force_disable}
  $doc = $word.Documents.Open($src, $false, $true)
  # 12 = wdFormatXMLDocument (.docx)
  $null = $doc.SaveAs2($dst, 12)
}} finally {{
  # Word 偶发在 Quit 时抛 RPC 失败，只要目标文件已写出就视为成功
  try {{ if ($null -ne $doc) {{ $doc.Close($false) | Out-Null }} }} catch {{ }}
  try {{
    if ($null -ne $word -and $null -ne $prevAutomationSecurity) {{
      $word.AutomationSecurity = $prevAutomationSecurity
    }}
  }} catch {{ }}
  try {{ if ($null -ne $word) {{ $word.Quit() | Out-Null }} }} catch {{ }}
  try {{ if ($null -ne $doc) {{ [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }} }} catch {{ }}
  try {{ if ($null -ne $word) {{ [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) }} }} catch {{ }}
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}}
if (-not (Test-Path -LiteralPath $dst)) {{
  throw 'Word 未生成 .docx 文件'
}}
if ((Get-Item -LiteralPath $dst).Length -le 0) {{
  throw 'Word 生成的 .docx 为空'
}}
"""


def _convert_with_word_com(file_path: str) -> str:
    """Windows：用本机 Word 另存为 .docx（wdFormatXMLDocument = 12）。"""
    src = str(Path(file_path).resolve())
    dest_file = tempfile.NamedTemporaryFile(delete=False, suffix=".docx", prefix="tabtin-doc-")
    dest_file.close()
    dest = str(Path(dest_file.name).resolve())

    script = _build_word_com_ps_script(src, dest)
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        # 即使进程非 0，只要产物有效也算成功（Quit COM 抖动）
        if os.path.isfile(dest) and os.path.getsize(dest) > 0:
            if completed.returncode != 0:
                logger.warning(
                    "Word COM 转换已生成 .docx，但进程退出码非 0: %s",
                    (completed.stderr or completed.stdout or "").strip()[:500],
                )
            return dest
        stderr = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(stderr or f"Word COM exit {completed.returncode}")
    except Exception:
        Path(dest).unlink(missing_ok=True)
        raise
