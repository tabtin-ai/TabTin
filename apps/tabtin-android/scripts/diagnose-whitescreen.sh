#!/usr/bin/env bash
# 白屏抓现场：在看到白屏的当下运行，一次跑完区分三种情况并留证。
#
#   bash apps/tabtin-android/scripts/diagnose-whitescreen.sh
#
# 三种白，判据各不相同：
#   1) Compose 组合塌陷（真故障）— ComposeView 被 measure 成 0x0，而父容器尺寸正常。
#      2026-08-02 实测指纹：进程活着、窗口 surface 正常、主线程能响应输入、无崩溃无 ANR，
#      但内容区尺寸归零，画出的就是窗口白底。切后台 / 重进 Activity 都不恢复，只能重启 App。
#   2) 合法空状态页（不是故障）— 像素接近纯白但 ComposeView 尺寸正常，如「暂无 Project」。
#      所以不能只靠像素比例判断，必须看 View 尺寸。
#   3) Studio 镜像流问题（App 没事）— screencap 直取正常，只有 Running Devices 面板白。
#      screencap 走 SurfaceFlinger，与面板的 gRPC 视频流是两条独立通道。

set -uo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="${PKG:-com.tabtin.mobile}"
OUT="${OUT:-/tmp/tabtin-whitescreen-$(date +%H%M%S)}"
mkdir -p "$OUT"

command -v "$ADB" >/dev/null 2>&1 || { echo "找不到 adb: $ADB"; exit 1; }

echo "=== 1. 进程状态 ==="
PID="$($ADB shell pidof "$PKG" | tr -d '\r')"
if [ -z "$PID" ]; then
  echo "❌ 进程已死 —— 是真崩溃，看下面的 crash 日志"
else
  echo "✅ 进程活着 (pid=$PID) —— 不是崩溃"
fi

echo
echo "=== 2. 前台 Activity ==="
$ADB shell dumpsys activity activities 2>/dev/null | grep -E "topResumedActivity" | head -2

echo
echo "=== 3. Compose 内容区尺寸（确定性判据）==="
# 真白屏的指纹：父容器 ContentFrameLayout 尺寸正常，但 ComposeView 被 measure 成 0x0。
# 这个判据不会被「合法空状态页」误判 —— 像素统计会。
CV="$($ADB shell dumpsys activity top 2>/dev/null \
      | awk '/DecorView@.*\['"${PKG##*.}"'|DecorView@.*\[MainActivity\]/,/Looper/' \
      | grep -E "ContentFrameLayout|platform.ComposeView" | tail -2)"
echo "$CV"
if echo "$CV" | grep -q "platform.ComposeView.* 0,0-0,0"; then
  echo "🔴 确诊：ComposeView 被 measure 成 0x0 —— Compose 组合塌成空，画出的是窗口白底"
  echo "   这就是白屏根因所在层。属持久故障，切后台/重进 Activity 都不会恢复，只能重启 App。"
  COMPOSE_DEAD=1
else
  echo "🟢 ComposeView 尺寸正常 —— 不是组合塌陷。若仍看到白，多半是某个页面的空状态"
  COMPOSE_DEAD=0
fi

echo
echo "=== 4. 真实屏幕内容（辅助判据）==="
$ADB exec-out screencap -p > "$OUT/screen.png" 2>/dev/null
if [ ! -s "$OUT/screen.png" ]; then
  echo "⚠️  截图失败"
else
  # 统计非白像素比例。跳过顶部状态栏和底部手势条——那两处白屏时也有内容，会干扰判定。
  WHITE_RATIO="$(python3 - "$OUT/screen.png" <<'PY'
import sys
try:
    from PIL import Image
except ImportError:
    print("NA"); raise SystemExit
try:
    im = Image.open(sys.argv[1]).convert("RGB")
    w, h = im.size
    im = im.crop((0, int(h*0.06), w, int(h*0.94)))   # 去掉状态栏 / 手势条
    px = im.load()
    cw, ch = im.size
    nonwhite = total = 0
    for y in range(0, ch, 4):
        for x in range(0, cw, 4):
            r, g, b = px[x, y]
            total += 1
            if r < 240 or g < 240 or b < 240:
                nonwhite += 1
    print(f"{100*nonwhite/total:.1f}" if total else "NA")
except Exception:
    print("NA")
PY
)"
  echo "截图已存: $OUT/screen.png"
  echo "非白像素占比: ${WHITE_RATIO}%"
  echo
  case "$WHITE_RATIO" in
    NA) echo "→ 无法自动判定，请手动打开截图看" ;;
    *)  if [ "${WHITE_RATIO%%.*}" -lt 3 ] 2>/dev/null; then
          if [ "$COMPOSE_DEAD" = "1" ]; then
            echo "→ 与第 3 段一致：App 真的画了一张白"
          else
            echo "⚠️  画面接近纯白，但 ComposeView 尺寸正常 —— 很可能是某个 tab 的"
            echo "   合法空状态页（如「暂无 Project」），不是故障。看一眼截图确认。"
          fi
        else
          echo "🟢 真实屏幕内容正常。若 Studio 面板显示白，那是「Running Devices」镜像流的问题，"
          echo "   App 没有 bug。改用独立窗口跑可绕开："
          echo "   \$HOME/Library/Android/sdk/emulator/emulator -avd tabphone_default"
        fi ;;
  esac
fi

echo
echo "=== 5. 崩溃 / ANR 历史 ==="
$ADB shell dumpsys activity exit-info "$PKG" 2>/dev/null | grep -E "timestamp=|reason=" | head -8

echo
echo "=== 6. 最近异常日志 ==="
$ADB logcat -b crash -d -t 40 > "$OUT/crash.log" 2>/dev/null
if [ -s "$OUT/crash.log" ]; then echo "⚠️ 有 crash 记录: $OUT/crash.log"; tail -20 "$OUT/crash.log"
else echo "✅ crash buffer 为空"; fi
$ADB logcat -d -t 600 2>/dev/null | grep -iE "FATAL|AndroidRuntime|ANR |RenderProcessGone|OutOfMemory" | tail -10

echo
echo "=== 7. 渲染层证据（判定「窗口在不在、有没有画」）==="
$ADB shell dumpsys window windows 2>/dev/null \
  | grep -A25 "Window{.*$PKG/.*MainActivity" \
  | grep -iE "mHasSurface|isReadyForDisplay|mViewVisibility|Requested w=|mFrame=|mAppOp" | head -8
echo "--- 帧统计（Janky 比例高 = 渲染管线阻塞）---"
$ADB shell dumpsys gfxinfo "$PKG" 2>/dev/null \
  | grep -iE "Total frames|Janky frames|50th|90th|99th|Number Missed Vsync|Number High input|Number Slow UI thread|Number Slow draw" | head -10

echo
echo "=== 8. 主线程是否卡住（连抓两次栈对比）==="
if [ -n "$PID" ]; then
  $ADB shell "kill -3 $PID" 2>/dev/null && sleep 2
  $ADB shell "cat /data/anr/traces.txt 2>/dev/null || true" > "$OUT/anr_trace.txt" 2>/dev/null
  if [ -s "$OUT/anr_trace.txt" ]; then echo "主线程栈已存: $OUT/anr_trace.txt"
  else echo "（取不到 traces，需 root；可改用 Studio 的 Debug > Dump Java stack）"; fi
fi

echo
echo "证据目录: $OUT"
echo "把整个目录发出来即可定位。"
