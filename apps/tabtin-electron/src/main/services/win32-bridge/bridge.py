#!/usr/bin/env python3
"""
TabDesktop Win32 Bridge — 常驻 Python 子进程。

Electron 主进程通过 stdio JSONL 与本进程通信。
本进程负责：
  1. bound window 模式（SendMessage → HWND，不抢焦点）
  2. UIAutomation 按名定位 + InvokePattern / ValuePattern 操作
  3. 窗口截图（PrintWindow）
  4. 窗口枚举（EnumWindows）

协议：每行一条 JSON 消息（\\n 分隔）
  请求：{"id": <int>, "method": "<str>", "params": {…}}
  响应：{"id": <int>, "result": {…}}
  错误：{"id": <int>, "error": {"code": "<str>", "message": "<str>"}}
"""
# FIXME(Win真机验): bridge.py 整体在 Windows 真机验证前都是"盲写"，
# 以下 Win32 API 调用仅靠接口契约 + Mac 侧 mock 测试保证协议正确性。
# GA 真机验收时逐方法验证。

import sys
import json
import traceback

# ---------------------------------------------------------------------------
# 平台依赖延迟导入（Mac 上不可用，但协议层仍可测试）
# ---------------------------------------------------------------------------

_ctypes_loaded = False
_uia_loaded = False

def _ensure_ctypes():
    """延迟加载 ctypes + user32.dll。"""
    global _ctypes_loaded
    if _ctypes_loaded:
        return
    # FIXME(Win真机验): ctypes 加载 user32.dll 在某些 Windows Server 版本可能需要
    # 额外的 DLL 搜索路径设置
    try:
        import ctypes  # noqa: F811
        import ctypes.wintypes  # noqa: F811
        globals()['ctypes'] = ctypes
        globals()['user32'] = ctypes.windll.user32
        globals()['kernel32'] = ctypes.windll.kernel32
        _ctypes_loaded = True
    except (ImportError, AttributeError, OSError):
        pass


def _ensure_uia():
    """延迟加载 UIAutomation COM 接口。"""
    global _uia_loaded
    if _uia_loaded:
        return
    # FIXME(Win真机验): UIAutomation COM 初始化在部分 Windows 版本可能需要
    # CoInitialize，且 comtypes 需要 pip install
    try:
        import comtypes  # noqa: F811
        import comtypes.client  # noqa: F811
        globals()['comtypes'] = comtypes

        # 确保 UIAutomationClient type library wrapper 已生成
        # （comtypes.gen.UIAutomationClient 在首次使用时需要 GetModule 触发生成）
        try:
            from comtypes.gen import UIAutomationClient  # noqa: F811
        except ImportError:
            comtypes.client.GetModule('UIAutomationCore.dll')
            from comtypes.gen import UIAutomationClient  # noqa: F811

        uia = comtypes.client.CreateObject(
            '{ff48dba4-60ef-4201-aa87-54103eef594e}',
            interface=UIAutomationClient.IUIAutomation,
        )
        globals()['_uia_client'] = uia
        globals()['UIAutomationClient'] = UIAutomationClient
        _uia_loaded = True
    except Exception:
        try:
            from uiautomation import uiautomation as auto  # noqa: F811
            globals()['uiauto'] = auto
            _uia_loaded = True
        except ImportError:
            pass


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------

_bound_hwnd = None  # 当前绑定的窗口句柄（int | None）
_bound_title = None  # 绑定时的窗口标题（用于诊断）

# ---------------------------------------------------------------------------
# Win32 常量
# ---------------------------------------------------------------------------

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_CHAR = 0x0102
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
MK_LBUTTON = 0x0001
PW_RENDERFULLCONTENT = 2

# ---------------------------------------------------------------------------
# 方法实现
# ---------------------------------------------------------------------------


def handle_ping(params):
    """健康检查。"""
    return {"status": "ok", "version": "1.0.0"}


def handle_find_window(params):
    """按标题子串查找窗口，返回 HWND + 窗口信息。"""
    _ensure_ctypes()
    if not _ctypes_loaded:
        return {"error": {"code": "AX_UNAVAILABLE", "message": "Win32 API 不可用：ctypes 加载失败"}}

    title_search = params.get("title", "")
    process_name = params.get("processName", "")

    # FIXME(Win真机验): EnumWindows 回调在高 DPI 环境下 GetWindowRect 返回的可能是
    # 物理像素而非逻辑像素，需要 SetProcessDpiAwarenessContext 调用
    results = []

    import ctypes
    import ctypes.wintypes

    EnumWindows = user32.EnumWindows
    GetWindowTextW = user32.GetWindowTextW
    GetWindowTextLengthW = user32.GetWindowTextLengthW
    IsWindowVisible = user32.IsWindowVisible
    GetWindowRect = user32.GetWindowRect
    GetWindowThreadProcessId = user32.GetWindowThreadProcessId

    WNDENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM
    )

    def enum_callback(hwnd, _lparam):
        if not IsWindowVisible(hwnd):
            return True
        length = GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        GetWindowTextW(hwnd, buf, length + 1)
        win_title = buf.value

        title_match = (not title_search) or (title_search.lower() in win_title.lower())
        if not title_match:
            return True

        rect = ctypes.wintypes.RECT()
        GetWindowRect(hwnd, ctypes.byref(rect))

        pid = ctypes.wintypes.DWORD()
        GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        results.append({
            "hwnd": int(hwnd),
            "title": win_title,
            "pid": pid.value,
            "bounds": {
                "x": rect.left, "y": rect.top,
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top,
            },
        })
        return True

    EnumWindows(WNDENUMPROC(enum_callback), 0)
    return {"windows": results}


def handle_bind_window(params):
    """绑定到指定窗口的 HWND。后续操作走 SendMessage 而非全局事件。"""
    global _bound_hwnd, _bound_title

    hwnd = params.get("hwnd")
    title = params.get("title")

    if hwnd is not None:
        _bound_hwnd = int(hwnd)
        _bound_title = title or f"HWND:{hwnd}"
        return {"ok": True, "hwnd": _bound_hwnd, "title": _bound_title}

    if title:
        result = handle_find_window({"title": title})
        if "error" in result:
            return result
        windows = result.get("windows", [])
        if not windows:
            return {"error": {
                "code": "ELEMENT_NOT_FOUND",
                "message": f"找不到标题包含「{title}」的窗口",
            }}
        best = windows[0]
        _bound_hwnd = best["hwnd"]
        _bound_title = best["title"]
        return {"ok": True, "hwnd": _bound_hwnd, "title": _bound_title}

    return {"error": {
        "code": "VALIDATION_ERROR",
        "message": "bind_window 需要 hwnd 或 title 参数",
    }}


def handle_unbind_window(params):
    """解除窗口绑定。"""
    global _bound_hwnd, _bound_title
    _bound_hwnd = None
    _bound_title = None
    return {"ok": True}


def handle_click(params):
    """
    在 bound window 内发送点击消息。
    不抢焦点、不动用户真实鼠标。
    """
    _ensure_ctypes()
    if not _ctypes_loaded:
        return {"error": {"code": "AX_UNAVAILABLE", "message": "Win32 API 不可用"}}

    if _bound_hwnd is None:
        return {"error": {
            "code": "VALIDATION_ERROR",
            "message": "未绑定窗口，请先调用 bind_window",
        }}

    x = int(params.get("x", 0))
    y = int(params.get("y", 0))
    button = params.get("button", "left")
    count = int(params.get("count", 1))

    # FIXME(Win真机验): SendMessage 的坐标是相对于窗口客户区左上角的，
    # 而上层传过来的可能是屏幕逻辑坐标 → 需要 ScreenToClient 转换
    import ctypes
    lparam = (y << 16) | (x & 0xFFFF)

    if button == "left":
        down_msg, up_msg = WM_LBUTTONDOWN, WM_LBUTTONUP
    elif button == "right":
        down_msg, up_msg = WM_RBUTTONDOWN, WM_RBUTTONUP
    elif button == "middle":
        down_msg, up_msg = WM_MBUTTONDOWN, WM_MBUTTONUP
    else:
        down_msg, up_msg = WM_LBUTTONDOWN, WM_LBUTTONUP

    SendMessageW = user32.SendMessageW
    for _ in range(count):
        SendMessageW(_bound_hwnd, down_msg, MK_LBUTTON if button == "left" else 0, lparam)
        SendMessageW(_bound_hwnd, up_msg, 0, lparam)

    return {"ok": True, "x": x, "y": y, "button": button, "count": count}


def handle_type_text(params):
    """
    在 bound window 内逐字符发送 WM_CHAR。
    不抢焦点。
    """
    _ensure_ctypes()
    if not _ctypes_loaded:
        return {"error": {"code": "AX_UNAVAILABLE", "message": "Win32 API 不可用"}}

    if _bound_hwnd is None:
        return {"error": {
            "code": "VALIDATION_ERROR",
            "message": "未绑定窗口，请先调用 bind_window",
        }}

    text = params.get("text", "")
    # FIXME(Win真机验): WM_CHAR 对非 BMP 字符（emoji 等）可能需要走 surrogate pair
    SendMessageW = user32.SendMessageW
    for ch in text:
        SendMessageW(_bound_hwnd, WM_CHAR, ord(ch), 0)

    return {"ok": True, "length": len(text)}


def handle_key_press(params):
    """发送按键到 bound window。"""
    _ensure_ctypes()
    if not _ctypes_loaded:
        return {"error": {"code": "AX_UNAVAILABLE", "message": "Win32 API 不可用"}}

    if _bound_hwnd is None:
        return {"error": {
            "code": "VALIDATION_ERROR",
            "message": "未绑定窗口，请先调用 bind_window",
        }}

    # FIXME(Win真机验): VkKeyScan 映射在非英文键盘布局下可能不正确
    key = params.get("key", "")
    import ctypes
    vk = user32.VkKeyScanW(ord(key[0])) if key else 0
    SendMessageW = user32.SendMessageW
    SendMessageW(_bound_hwnd, WM_KEYDOWN, vk & 0xFF, 0)
    SendMessageW(_bound_hwnd, WM_KEYUP, vk & 0xFF, 0)

    return {"ok": True, "key": key}


def handle_capture_accessibility_tree(params):
    """
    UIAutomation 抓取窗口 AX 树。
    返回 AccessibilityNode[] 兼容格式。
    """
    _ensure_uia()

    hwnd = params.get("hwnd", _bound_hwnd)
    max_depth = params.get("maxDepth", 4)
    interactive_only = params.get("interactiveOnly", True)
    window_title = params.get("window")

    if hwnd is None and window_title:
        find_result = handle_find_window({"title": window_title})
        if "error" in find_result:
            return find_result
        windows = find_result.get("windows", [])
        if not windows:
            return {"error": {
                "code": "ELEMENT_NOT_FOUND",
                "message": f"找不到标题包含「{window_title}」的窗口",
            }}
        hwnd = windows[0]["hwnd"]

    if hwnd is None:
        # FIXME(Win真机验): GetForegroundWindow 在无窗口绑定时的行为需要验证
        _ensure_ctypes()
        if _ctypes_loaded:
            hwnd = int(user32.GetForegroundWindow())
        else:
            return {"error": {
                "code": "AX_UNAVAILABLE",
                "message": "无法确定目标窗口：未绑定窗口且 ctypes 不可用",
            }}

    # FIXME(Win真机验): UIAutomation COM 调用的整体超时机制 —— 如果目标窗口
    # 的 UIA provider 卡死，Python 侧会无限等待。需要加 threading + timeout
    if not _uia_loaded:
        return _capture_ax_tree_powershell(hwnd, max_depth, interactive_only)

    return _capture_ax_tree_com(hwnd, max_depth, interactive_only)


# UIA 交互角色白名单（与 macOS INTERACTIVE_ROLES 对齐）
INTERACTIVE_CONTROL_TYPES = {
    'Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton',
    'MenuItem', 'Menu', 'MenuBar', 'Hyperlink', 'Slider',
    'Spinner', 'TabItem', 'Tab', 'List', 'ListItem',
    'TreeItem', 'Tree', 'DataGrid', 'DataItem', 'Document',
    'ScrollBar', 'ToolBar', 'SplitButton', 'ToggleButton',
    'Text', 'Image', 'Group', 'Pane', 'Window',
}


def _get_value_com(element):
    """从 UIAutomation 元素读取 ValuePattern 的当前值。"""
    try:
        # UIA_ValuePatternId = 10002
        vp = element.GetCurrentPatternAs(10002, globals().get('UIAutomationClient', __import__('comtypes').gen.UIAutomationClient).IUIAutomationValuePattern)
        if vp:
            return vp.CurrentValue
    except Exception:
        pass
    # fallback: 读 element.CurrentValue（某些控件暴露为属性而非 pattern）
    try:
        val = element.CurrentValue
        if val is not None:
            return str(val)
    except Exception:
        pass
    return None


def _capture_ax_tree_com(hwnd, max_depth, interactive_only):
    """通过 comtypes UIAutomation COM 接口采集 AX 树。"""
    # FIXME(Win真机验): comtypes UIAutomation 绑定在不同 Windows 版本上的
    # 接口 GUID 可能不同，需要 fallback 到 powershell 方案
    try:
        uia = globals().get('_uia_client')
        if not uia:
            return _capture_ax_tree_powershell(hwnd, max_depth, interactive_only)

        import ctypes
        root = uia.ElementFromHandle(ctypes.wintypes.HWND(hwnd))
        if not root:
            return {"error": {
                "code": "ELEMENT_NOT_FOUND",
                "message": f"UIAutomation 无法获取 HWND={hwnd} 的元素",
            }}

        node_id = [0]

        def traverse(element, depth):
            if depth > max_depth:
                return None
            try:
                name = element.CurrentName or ""
                control_type = element.CurrentLocalizedControlType or ""
                auto_id = element.CurrentAutomationId or ""
                is_enabled = bool(element.CurrentIsEnabled)

                if interactive_only and depth > 0:
                    if control_type not in INTERACTIVE_CONTROL_TYPES:
                        children = _get_children_com(element, depth + 1, max_depth, interactive_only, node_id)
                        if not children:
                            return None
                        return {"_passthrough": True, "children": children}

                nid = f"win#{node_id[0]}"
                node_id[0] += 1

                rect = element.CurrentBoundingRectangle
                bounds = None
                if rect:
                    bx, by = int(rect.left), int(rect.top)
                    bw, bh = int(rect.right - rect.left), int(rect.bottom - rect.top)
                    if bw <= 0 or bh <= 0:
                        return None
                    if bx < -10000:
                        return None
                    bounds = {"x": bx, "y": by, "width": bw, "height": bh}

                node = {
                    "id": nid,
                    "role": control_type,
                    "enabled": is_enabled,
                    "visible": True,
                }
                if name:
                    node["name"] = name
                if auto_id:
                    node["automationId"] = auto_id

                value = _get_value_com(element)
                if value is not None:
                    node["value"] = value[:200] if len(value) > 200 else value

                if bounds:
                    node["bounds"] = bounds

                if depth < max_depth:
                    children = _get_children_com(element, depth + 1, max_depth, interactive_only, node_id)
                    if children:
                        node["children"] = children

                return node
            except Exception:
                return None

        def _get_children_com(parent, depth, max_d, inter_only, nid):
            kids = []
            try:
                tree_walker = uia.ControlViewWalker
                child = tree_walker.GetFirstChildElement(parent)
                while child:
                    c = traverse(child, depth)
                    if c:
                        if c.get("_passthrough"):
                            kids.extend(c["children"])
                        else:
                            kids.append(c)
                    child = tree_walker.GetNextSiblingElement(child)
            except Exception:
                pass
            return kids

        nodes = []
        result = traverse(root, 0)
        if result:
            if result.get("_passthrough"):
                nodes = result["children"]
            else:
                nodes = [result]

        return {"rootNodes": nodes, "hwnd": hwnd}

    except Exception as e:
        return _capture_ax_tree_powershell(hwnd, max_depth, interactive_only)


def _capture_ax_tree_powershell(hwnd, max_depth, interactive_only):
    """通过 PowerShell + UIAutomationClient 采集 AX 树（fallback 方案）。"""
    # FIXME(Win真机验): PowerShell 脚本在 Windows Server Core 上可能不可用，
    # 需要检测 powershell.exe 是否存在
    import subprocess

    ps_script = f'''
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$auto = [System.Windows.Automation.AutomationElement]
$root = $auto::FromHandle([IntPtr]{hwnd})
if (-not $root) {{ Write-Output '[]'; exit 0 }}

$nodeId = 0
$maxDepth = {max_depth}
$interactiveOnly = ${str(interactive_only).lower()}
$interactiveTypes = @(
    'Button','Edit','ComboBox','CheckBox','RadioButton',
    'MenuItem','Menu','MenuBar','Hyperlink','Slider',
    'Spinner','TabItem','Tab','List','ListItem',
    'TreeItem','Tree','DataGrid','DataItem','Document',
    'ScrollBar','ToolBar','SplitButton','ToggleButton',
    'Text','Image','Group','Pane','Window'
)

function Traverse($el, $depth) {{
    if ($depth -gt $maxDepth) {{ return $null }}
    try {{
        $name = $el.Current.Name
        $ct = $el.Current.LocalizedControlType
        $aid = $el.Current.AutomationId
        $enabled = $el.Current.IsEnabled
        $rect = $el.Current.BoundingRectangle

        if ($interactiveOnly -and $depth -gt 0 -and $ct -notin $interactiveTypes) {{
            $kids = @()
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            while ($child) {{
                $c = Traverse $child ($depth+1)
                if ($c) {{ $kids += $c }}
                $child = $walker.GetNextSibling($child)
            }}
            if ($kids.Count -eq 0) {{ return $null }}
            return @{{ _passthrough=$true; children=$kids }}
        }}

        $nid = "win#$nodeId"
        $script:nodeId++

        $bw = [int]$rect.Width
        $bh = [int]$rect.Height
        $bx = [int]$rect.X
        $by = [int]$rect.Y
        if ($bw -le 0 -or $bh -le 0) {{ return $null }}
        if ($bx -lt -10000) {{ return $null }}

        $node = [ordered]@{{
            id = $nid
            role = $ct
            enabled = $enabled
            visible = $true
        }}
        if ($name) {{ $node['name'] = $name }}
        if ($aid) {{ $node['automationId'] = $aid }}
        $node['bounds'] = [ordered]@{{ x=$bx; y=$by; width=$bw; height=$bh }}

        try {{
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp) {{
                $val = $vp.Current.Value
                if ($val.Length -gt 200) {{ $val = $val.Substring(0,200) }}
                $node['value'] = $val
            }}
        }} catch {{}}

        if ($depth -lt $maxDepth) {{
            $kids = @()
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            while ($child) {{
                $c = Traverse $child ($depth+1)
                if ($c) {{
                    if ($c._passthrough) {{ $kids += $c.children }}
                    else {{ $kids += $c }}
                }}
                $child = $walker.GetNextSibling($child)
            }}
            if ($kids.Count -gt 0) {{ $node['children'] = $kids }}
        }}

        return $node
    }} catch {{ return $null }}
}}

$result = Traverse $root 0
if ($result -and $result._passthrough) {{
    $result.children | ConvertTo-Json -Depth 20 -Compress
}} elseif ($result) {{
    @($result) | ConvertTo-Json -Depth 20 -Compress
}} else {{
    Write-Output '[]'
}}
'''

    try:
        proc = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps_script],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return {"error": {
                "code": "AX_UNAVAILABLE",
                "message": f"PowerShell UIAutomation 查询失败：{proc.stderr[:200]}",
            }}

        import json as _json
        nodes = _json.loads(proc.stdout.strip() or '[]')
        if not isinstance(nodes, list):
            nodes = [nodes]
        return {"rootNodes": nodes, "hwnd": hwnd}

    except subprocess.TimeoutExpired:
        return {"error": {
            "code": "INTERNAL_ERROR",
            "message": "UIAutomation PowerShell 查询超时（30 秒）",
        }}
    except Exception as e:
        return {"error": {
            "code": "AX_UNAVAILABLE",
            "message": f"PowerShell 调用失败：{str(e)[:200]}",
        }}


def handle_click_element(params):
    """
    按 Name / AutomationId / ControlType 定位元素并操作。
    优先走 InvokePattern，fallback 到取 BoundingRect 中心 SendMessage 点击。
    """
    name = params.get("name", "")
    role = params.get("role")
    automation_id = params.get("automationId")
    nth = params.get("nth", 0)

    hwnd = params.get("hwnd", _bound_hwnd)
    if hwnd is None:
        _ensure_ctypes()
        if _ctypes_loaded:
            hwnd = int(user32.GetForegroundWindow())

    tree_result = handle_capture_accessibility_tree({
        "hwnd": hwnd,
        "maxDepth": params.get("maxDepth", 4),
        "interactiveOnly": False,
    })

    if "error" in tree_result:
        return tree_result

    nodes = tree_result.get("rootNodes", [])
    matches = _find_nodes(nodes, name, role, automation_id)

    if not matches:
        return {"error": {
            "code": "ELEMENT_NOT_FOUND",
            "message": f"未找到名为「{name}」的元素",
        }}

    if nth >= len(matches):
        return {"error": {
            "code": "ELEMENT_NOT_FOUND",
            "message": f"名为「{name}」的元素只有 {len(matches)} 个，但请求第 {nth} 个",
        }}

    target = matches[nth]

    # FIXME(Win真机验): InvokePattern 在某些控件（如 WPF 自定义控件）上
    # 可能不响应，需要 fallback 到坐标点击
    invoke_tried = False
    if _uia_loaded and hwnd:
        try:
            invoke_tried = _try_invoke_uia(hwnd, name, role, automation_id, nth)
        except Exception:
            pass

    if not invoke_tried and target.get("bounds"):
        b = target["bounds"]
        cx = b["x"] + b["width"] // 2
        cy = b["y"] + b["height"] // 2
        if _bound_hwnd:
            handle_click({"x": cx, "y": cy, "button": "left", "count": 1})
        elif _ctypes_loaded:
            # FIXME(Win真机验): 全局 SendInput 点击路径未测试
            import ctypes
            user32.SetCursorPos(cx, cy)
            user32.mouse_event(0x0002, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTDOWN
            user32.mouse_event(0x0004, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTUP

    return {
        "matched": {
            "id": target.get("id", ""),
            "role": target.get("role", ""),
            "name": target.get("name"),
            "bounds": target.get("bounds"),
        },
    }


def handle_type_into_element(params):
    """按名字定位输入框并输入文本。"""
    name = params.get("name", "")
    role = params.get("role")
    automation_id = params.get("automationId")
    text = params.get("text", "")

    hwnd = params.get("hwnd", _bound_hwnd)
    if hwnd is None:
        _ensure_ctypes()
        if _ctypes_loaded:
            hwnd = int(user32.GetForegroundWindow())

    tree_result = handle_capture_accessibility_tree({
        "hwnd": hwnd,
        "maxDepth": params.get("maxDepth", 4),
        "interactiveOnly": False,
    })

    if "error" in tree_result:
        return tree_result

    nodes = tree_result.get("rootNodes", [])
    matches = _find_nodes(nodes, name, role, automation_id)

    if not matches:
        return {"error": {
            "code": "ELEMENT_NOT_FOUND",
            "message": f"未找到名为「{name}」的输入元素",
        }}

    target = matches[0]

    # FIXME(Win真机验): ValuePattern.SetValue 在某些控件上可能不触发
    # change 事件，需要额外发送 EN_CHANGE 通知
    value_set = False
    if _uia_loaded and hwnd:
        try:
            value_set = _try_set_value_uia(hwnd, name, role, automation_id, text)
        except Exception:
            pass

    if not value_set and target.get("bounds"):
        b = target["bounds"]
        cx = b["x"] + b["width"] // 2
        cy = b["y"] + b["height"] // 2
        if _bound_hwnd:
            handle_click({"x": cx, "y": cy, "button": "left", "count": 1})
            handle_type_text({"text": text})
        elif _ctypes_loaded:
            import ctypes
            user32.SetCursorPos(cx, cy)
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
            for ch in text:
                user32.SendMessageW(hwnd, WM_CHAR, ord(ch), 0)

    return {
        "matched": {
            "id": target.get("id", ""),
            "role": target.get("role", ""),
            "name": target.get("name"),
            "bounds": target.get("bounds"),
        },
    }


def handle_screenshot_window(params):
    """PrintWindow 截取 bound window（不受遮挡影响）。"""
    _ensure_ctypes()
    if not _ctypes_loaded:
        return {"error": {"code": "AX_UNAVAILABLE", "message": "Win32 API 不可用"}}

    hwnd = params.get("hwnd", _bound_hwnd)
    if hwnd is None:
        return {"error": {
            "code": "VALIDATION_ERROR",
            "message": "screenshot_window 需要 hwnd 或已绑定窗口",
        }}

    # FIXME(Win真机验): PrintWindow + BitBlt 截图链路在 Windows 上的完整验证，
    # 包括 DPI 缩放、多显示器偏移、窗口最小化状态
    import ctypes
    import ctypes.wintypes
    import base64
    import io

    gdi32 = ctypes.windll.gdi32

    rect = ctypes.wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    if width <= 0 or height <= 0:
        return {"error": {
            "code": "INTERNAL_ERROR",
            "message": f"窗口尺寸异常：{width}x{height}",
        }}

    hdc_screen = user32.GetDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    gdi32.SelectObject(hdc_mem, hbm)

    user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

    # BMP → base64（实际生产中会用 PIL 转 PNG，这里给基础数据）
    bmp_size = width * height * 4
    buf = (ctypes.c_byte * bmp_size)()

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32),
            ('biHeight', ctypes.c_int32), ('biPlanes', ctypes.c_uint16),
            ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
            ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32),
            ('biYPelsPerMeter', ctypes.c_int32), ('biClrUsed', ctypes.c_uint32),
            ('biClrImportant', ctypes.c_uint32),
        ]

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = width
    bmi.biHeight = -height  # top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0

    gdi32.GetDIBits(hdc_mem, hbm, 0, height, buf, ctypes.byref(bmi), 0)

    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_screen)

    raw_bytes = bytes(buf)
    b64 = base64.b64encode(raw_bytes).decode('ascii')

    return {
        "width": width,
        "height": height,
        "format": "raw_bgra",
        "data_base64": b64[:100] + "..." if len(b64) > 100 else b64,
        "data_length": len(raw_bytes),
    }


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------

def _find_nodes(nodes, name, role=None, automation_id=None):
    """在 AX 节点树中按 name/role/automationId 查找。"""
    results = []
    name_lower = name.lower()

    def walk(node_list):
        for node in node_list:
            if not isinstance(node, dict):
                continue
            node_name = (node.get("name") or "").lower()
            name_match = name_lower in node_name
            role_match = (not role) or (node.get("role", "").lower() == role.lower())
            aid_match = (not automation_id) or (node.get("automationId", "") == automation_id)

            if name_match and role_match and aid_match:
                results.append(node)

            children = node.get("children", [])
            if children:
                walk(children)

    walk(nodes)
    return results


def _try_invoke_uia(hwnd, name, role, automation_id, nth):
    """
    尝试通过 UIA InvokePattern 直接激活元素。
    成功返回 True，不支持或失败返回 False。
    """
    # FIXME(Win真机验): comtypes UIA InvokePattern 在 WPF 自定义控件 / UWP 上的兼容性
    if not _uia_loaded:
        return False
    uia = globals().get('_uia_client')
    if not uia:
        return False
    try:
        import ctypes as _ct
        root = uia.ElementFromHandle(_ct.wintypes.HWND(hwnd))
        if not root:
            return False

        # 按 name/role/automationId 在 UIA 树上找目标元素
        condition_parts = []
        if name:
            cond_name = uia.CreatePropertyCondition(30005, name)  # UIA_NamePropertyId
            condition_parts.append(cond_name)
        if automation_id:
            cond_aid = uia.CreatePropertyCondition(30011, automation_id)  # UIA_AutomationIdPropertyId
            condition_parts.append(cond_aid)

        if not condition_parts:
            return False

        condition = condition_parts[0]
        for c in condition_parts[1:]:
            condition = uia.CreateAndCondition(condition, c)

        found = root.FindAll(4, condition)  # TreeScope_Descendants = 4
        if not found or found.Length <= nth:
            return False

        target = found.GetElement(nth)
        # UIA_InvokePatternId = 10000
        invoke = target.GetCurrentPatternAs(
            10000,
            globals().get('UIAutomationClient', __import__('comtypes').gen.UIAutomationClient).IUIAutomationInvokePattern,
        )
        if invoke:
            invoke.Invoke()
            return True
    except Exception:
        pass
    return False


def _try_set_value_uia(hwnd, name, role, automation_id, text):
    """
    尝试通过 UIA ValuePattern 写入值。
    成功返回 True，不支持或失败返回 False。
    """
    # FIXME(Win真机验): comtypes UIA ValuePattern.SetValue 在某些控件上可能不触发 change 事件
    if not _uia_loaded:
        return False
    uia = globals().get('_uia_client')
    if not uia:
        return False
    try:
        import ctypes as _ct
        root = uia.ElementFromHandle(_ct.wintypes.HWND(hwnd))
        if not root:
            return False

        condition_parts = []
        if name:
            cond_name = uia.CreatePropertyCondition(30005, name)
            condition_parts.append(cond_name)
        if automation_id:
            cond_aid = uia.CreatePropertyCondition(30011, automation_id)
            condition_parts.append(cond_aid)

        if not condition_parts:
            return False

        condition = condition_parts[0]
        for c in condition_parts[1:]:
            condition = uia.CreateAndCondition(condition, c)

        found = root.FindAll(4, condition)
        if not found or found.Length == 0:
            return False

        target = found.GetElement(0)
        # UIA_ValuePatternId = 10002
        value_pat = target.GetCurrentPatternAs(
            10002,
            globals().get('UIAutomationClient', __import__('comtypes').gen.UIAutomationClient).IUIAutomationValuePattern,
        )
        if value_pat:
            value_pat.SetValue(text)
            return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# 方法路由
# ---------------------------------------------------------------------------

METHOD_MAP = {
    "ping": handle_ping,
    "find_window": handle_find_window,
    "bind_window": handle_bind_window,
    "unbind_window": handle_unbind_window,
    "click": handle_click,
    "type_text": handle_type_text,
    "key_press": handle_key_press,
    "capture_accessibility_tree": handle_capture_accessibility_tree,
    "click_element": handle_click_element,
    "type_into_element": handle_type_into_element,
    "screenshot_window": handle_screenshot_window,
}


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

def main():
    """stdio JSONL 主循环：逐行读 stdin，处理请求，写 stdout。"""
    # 禁用 stdout 缓冲，确保每行 JSON 立即 flush
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    # 启动就绪信号
    sys.stdout.write(json.dumps({"id": 0, "result": {"status": "ready", "version": "1.0.0"}}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"JSON 解析失败: {e}\n")
            continue

        req_id = msg.get("id", -1)
        method = msg.get("method", "")
        params = msg.get("params", {})

        handler = METHOD_MAP.get(method)
        if not handler:
            response = {
                "id": req_id,
                "error": {
                    "code": "UNKNOWN_ROUTE",
                    "message": f"未知方法: {method}",
                },
            }
        else:
            try:
                result = handler(params)
                if isinstance(result, dict) and "error" in result:
                    response = {"id": req_id, "error": result["error"]}
                else:
                    response = {"id": req_id, "result": result}
            except Exception as e:
                response = {
                    "id": req_id,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": f"内部错误: {str(e)[:300]}",
                    },
                }
                sys.stderr.write(f"方法 {method} 异常:\n{traceback.format_exc()}\n")

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
