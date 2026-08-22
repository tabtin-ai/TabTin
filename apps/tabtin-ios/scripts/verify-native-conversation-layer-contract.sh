#!/usr/bin/env bash
set -euo pipefail

ios_root="$(cd "$(dirname "$0")/.." && pwd)"
conversation="$ios_root/Tabtin/Features/Conversation/ConversationScreen.swift"
coordinator="$ios_root/Tabtin/Features/Conversation/TaskSurfaceCoordinator.swift"
workbench="$ios_root/Tabtin/Features/Workbench/WorkbenchSheet.swift"
capsule="$ios_root/Tabtin/Features/Workbench/AgentStatusCapsule.swift"
regular_floating="$ios_root/Tabtin/Features/Conversation/RegularConversationFloatingWindow.swift"

failures=0

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

require_text() {
  local text="$1"
  local needle="$2"
  local message="$3"
  if rg -Fq -- "$needle" <<<"$text"; then
    pass "$message"
  else
    fail "$message"
  fi
}

forbid_text() {
  local text="$1"
  local needle="$2"
  local message="$3"
  if rg -Fq -- "$needle" <<<"$text"; then
    fail "$message"
  else
    pass "$message"
  fi
}

conversation_source="$(<"$conversation")"
coordinator_source="$(<"$coordinator")"
workbench_source="$(<"$workbench")"
capsule_source="$(<"$capsule")"
regular_floating_source="$(<"$regular_floating")"

picker_section="$(awk '
  /struct CompactTaskSurfacePicker/ { capture = 1 }
  capture { print }
  capture && /struct CompactConversationOverlayHost/ { exit }
' "$conversation")"
if rg -q '^[[:space:]]*Picker\(' <<<"$picker_section"; then
  pass '顶部工作面切换使用 SwiftUI 原生 Picker'
else
  fail '顶部工作面切换使用 SwiftUI 原生 Picker'
fi
require_text "$picker_section" '.pickerStyle(.segmented)' '顶部工作面切换使用原生 segmented 样式'
forbid_text "$picker_section" 'Button' '没有用自绘 Button 冒充原生 segmented control'

require_text "$workbench_source" '.sheet(item: compactPresentedPageBinding)' 'compact Workbench App/detail 继续由系统 sheet 承载'
forbid_text "$workbench_source" '.fullScreenCover(' 'regular iPad Workbench App/detail 不再使用 fullScreenCover'
if rg -Fq -- 'private var shouldPresentPagesModally' <<<"$workbench_source" \
  && rg -Fq -- 'isTaskWorkbenchPane && presentedPageIsCompactLayout' <<<"$workbench_source" \
  && rg -Fq -- 'presentsPagesModally: shouldPresentPagesModally' <<<"$workbench_source"; then
  pass 'taskPane 只有 compact 使用系统 modal；regular 导航留在 Workbench pane'
else
  fail 'taskPane 只有 compact 使用系统 modal；regular 导航留在 Workbench pane'
fi

embedded_pane_section="$(awk '
  /private var embeddedTaskPane/ { capture = 1 }
  capture { print }
  capture && /private func activateApp/ { exit }
' "$workbench")"
require_text "$embedded_pane_section" 'navigationState.appHome' 'regular Workbench pane 原位承载 App Home'
require_text "$embedded_pane_section" 'navigationState.path.last' 'regular Workbench pane 原位承载 App detail'

presented_page_policy_section="$(awk '
  /enum WorkbenchPresentedPageConversationHostPlacement/ { capture = 1 }
  capture { print }
  capture && /private struct WorkbenchPresentedPageSheet/ { exit }
' "$workbench")"
require_text "$presented_page_policy_section" 'case compactOverlay' 'compact App sheet 继续承载 overlay conversation'
forbid_text "$regular_floating_source" 'horizontalSizeClass' '浮窗组件不再另设 sheet-local regular 门禁'
require_text "$regular_floating_source" 'CGSize(width: 420, height: 560)' 'iPad 根 pane 浮窗保持 Electron 420×560 尺寸'

presented_page_section="$(awk '
  /private struct WorkbenchPresentedPageSheet/ { capture = 1 }
  capture { print }
  capture && /private extension View/ { exit }
' "$workbench")"
if rg -iq 'conversation.?layer' <<<"$presented_page_section"; then
  pass '对话层在顶层原生 App sheet 的 hosting controller 内重新挂载'
else
  fail '对话层在顶层原生 App sheet 的 hosting controller 内重新挂载'
fi
forbid_text "$presented_page_section" 'CompactTaskSurfacePicker' '原生 App sheet 不显示遮挡内容的工作面 Picker'
forbid_text "$presented_page_section" '.fullScreenCover(' '原生 App sheet 不创建多余的完整对话 presentation'
forbid_text "$presented_page_section" 'presentsFullConversation' '原生 App sheet 只保留胶囊与 overlay 状态'
require_text "$presented_page_section" '.interactiveDismissDisabled(' '原生 App sheet 禁用与 layer 冲突的下拉 dismiss'
require_text "$presented_page_section" 'WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss' '原生 App sheet 按 layer 档位决定下拉 dismiss 策略'
require_text "$presented_page_section" 'conversationLayerDetent: taskSurfaceCoordinator.conversationLayerDetent' 'layer 收起时恢复原生 App sheet 下滑关闭'
require_text "$presented_page_section" 'hidesCapsule:' '对话层展开后隐藏 sheet 顶层胶囊'
if rg -q 'static let expandedTopRatio: CGFloat = 0[.]09[[:space:]]*$' <<<"$coordinator_source"; then
  pass 'EXPANDED overlay 保留卡片顶部层级，不冒充全屏'
else
  fail 'EXPANDED overlay 保留卡片顶部层级，不冒充全屏'
fi
require_text "$coordinator_source" 'conversationLayerDragOriginDetent' '拖拽按起始 detent 决定是否允许进入 EXPANDED'
require_text "$coordinator_source" 'allowsExpanded: allowsExpanded' 'settle 显式接收 origin-derived EXPANDED 权限'
detent_section="$(awk '
  /enum ConversationLayerDetent/ { capture = 1 }
  capture { print }
  capture && /enum ConversationLayerGeometry/ { exit }
' "$coordinator")"
forbid_text "$detent_section" 'case full' 'overlay detent 不再复用 full conversation 语义'

compact_layout_section="$(awk '
  /private var compactLayout/ { capture = 1 }
  capture { print }
  capture && /三态：/ { exit }
' "$conversation")"
require_text "$compact_layout_section" 'coordinator.compactSurface == .conversation' '独立全屏对话按主工作面分支直出'
require_text "$compact_layout_section" 'CompactConversationOverlayHost' '工作台 overlay 使用独立卡片宿主'
require_text "$compact_layout_section" 'if hostsConversationContent' 'App sheet 活跃时根层 direct 与 overlay 都不挂载'
regular_layout_section="$(awk '
  /private func regularLayout/ { capture = 1 }
  capture { print }
  capture && /private var regularFloatingConversationPlacement/ { exit }
' "$conversation")"
require_text "$regular_layout_section" 'if hostsConversationContent' 'compact App sheet 活跃时 regular 根会话树不重复挂载'
require_text "$regular_layout_section" 'RegularConversationFloatingWindow(' 'regular embedded App 继续由根 pane 承载独立浮窗'
require_text "$conversation_source" 'hostsConversationContent: workbenchNavigationState.presentedPage == nil' 'compact presentedPage 仍是根 host 与 sheet host 的 ownership gate'
layer_section="$(awk '
  /struct CompactConversationOverlayHost/ { capture = 1 }
  capture { print }
  capture && /iPad 三态切换器/ { exit }
' "$conversation")"
require_text "$layer_section" '.clipShape(' '半屏内容与背景裁进同一张圆角卡片'
require_text "$layer_section" 'return VStack(spacing: 0)' '抓手使用卡片内独立 44pt chrome，不覆盖消息'
require_text "$layer_section" '.shadow(' '半屏卡片具有明确层级阴影'
forbid_text "$layer_section" 'conversationLayerDetent == .full' 'EXPANDED overlay 仍保留卡片圆角和 grabber'

capsule_return_section="$(awk '
  /private func handleCapsuleReturnToConversation\(\)/ { capture = 1 }
  capture { print }
  capture && /private func resolveCapsuleFocusMessageId/ { exit }
' "$conversation")"
forbid_text "$capsule_return_section" 'dismissPresentedPage' '胶囊打开浮窗不会清理当前 App 导航'
require_text "$capsule_return_section" 'taskSurfaceCoordinator.viewMode == .appFocus' 'iPad App Focus 胶囊在当前 pane 上打开浮窗'
require_text "$capsule_return_section" 'openRegularFloatingConversation()' 'iPad embedded App 复用根 420×560 浮窗意图'
forbid_text "$capsule_source" '&& !forcesWorkbenchVisibility' '原生 App sheet 内的胶囊仍能驱动对话层'

if (( failures > 0 )); then
  echo "native conversation layer contract: $failures failure(s)"
  exit 1
fi

echo 'native conversation layer contract: all checks passed'
