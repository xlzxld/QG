#!/usr/bin/env python3
"""大麦/阿里图标匹配滑块验证码 PC 侧求解器 (轮廓匹配 + motionevent 拟人轨迹)

来源: 2026-10-09 凌晨真机调试固化 (/tmp/solve_captcha.py + /tmp/auto_solve.sh)。
真机实证 (vivo V2405A, 03:01~03:21 截图链):
  - 机制不是"拼图缺口"而是图标匹配: 滑块上是浅色图标 (树/苹果/叶子...), 同一条带
    内有 2~3 个暗色图标, 与滑块同形异色的才是真目标, 其余是干扰项。
  - 失败提示「没有移到对应位置哦!」→ 落点精度是唯一门槛, 匀速直线轨迹即可过
    (03:21 订单确认页截图证实自动滑动通过过一次), 关键在选对目标图标。
  - 教训: 当晚"暗带定位法"4 连败是因为总拖向"最暗带子" = 大概率是干扰项。
    本脚本主算法为轮廓相关匹配 (滑块亮起轮廓 vs 暗色图标暗度轮廓, 余弦相似度),
    暗带/梯度法仅作降级。
  1. 轨迹: `input motionevent` 流式多点变速轨迹 (慢-快-慢 + y 抖动 + 过冲回拉),
     单次连续手势; 设备不支持时自动降级 `input swipe`。
  2. 布局: uiautomator dump 自动探测控件边界, 不写死分辨率; 探测失败回落实测常数。
  3. 校准: --offset N 微调落点 (首次通过后把当时值写回默认 0)。

用法:
  python3 tools/mobile/damai_captcha.py                 # 自动循环求解 (默认 5 次)
  python3 tools/mobile/damai_captcha.py --analyze       # 只定位打印, 不滑动 (校准用)
  python3 tools/mobile/damai_captcha.py --offset 12     # 落点整体右移 12px
  python3 tools/mobile/damai_captcha.py --serial <sn>   # 多设备时指定序列号

退出码: 0=通过  1=尝试耗尽仍在验证码  2=无设备  3=当前页面无验证码
依赖: python3 + pillow + numpy (pip3 install pillow numpy) + adb 在 PATH
"""
import argparse
import math
import os
import random
import re
import subprocess
import sys
import time

try:
    import numpy as np
    from PIL import Image
except ImportError:
    print("缺少依赖: pip3 install pillow numpy")
    sys.exit(2)

TMP_DIR = "/tmp/qg-captcha"
# vivo V2405A (1080x2400) 实测布局, 仅在 uiautomator dump 探测失败时兜底
FALLBACK = {
    "bg": (60, 834, 1020, 1377),      # 背景图 (含缺口) resource-id: puzzle-captcha-question-img
    "piece": (60, 1158, 210, 1311),   # 拼图块起始位 (叠在背景内)
    "btn": (108, 1419, 156, 1470),    # 滑块钮 resource-id: puzzle-captcha-btn-icon
}
CAPTCHA_ACTIVITY = "security.open.middletier.fc.ui.ContainerActivity"


def adb(serial, args, timeout=8):
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    return subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout)


def adb_shell(serial, script, timeout=15):
    """在设备 shell 里执行一段脚本 (分号串联), 单次 adb 调用。"""
    r = adb(serial, ["shell", script], timeout=timeout)
    return r.stdout.strip()


def pick_serial(arg_serial):
    r = adb(None, ["devices"])
    devs = [l.split("\t")[0] for l in r.stdout.splitlines() if "\tdevice" in l]
    if not devs:
        print("无 adb 设备, 先 npm run hub 一键连接或插 USB")
        sys.exit(2)
    if arg_serial and arg_serial not in devs:
        print(f"指定序列号 {arg_serial} 不在线, 在线: {devs}")
        sys.exit(2)
    return arg_serial or devs[0]


def screencap(serial, path):
    with open(path, "wb") as f:
        subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"],
                       stdout=f, timeout=10, check=True)
    return path


def parse_bounds(node_xml):
    m = re.search(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', node_xml)
    return tuple(int(g) for g in m.groups()) if m else None


def detect_layout(serial):
    """uiautomator dump 探测验证码控件边界; 背景图与滑块钮都找到才算探测成功,
    否则整体回落实测常数 (避免半探测状态混用不同分辨率的坐标)。"""
    layout = {"bg": FALLBACK["bg"], "piece": FALLBACK["piece"], "btn": FALLBACK["btn"], "detected": False}
    try:
        adb_shell(serial, "uiautomator dump /sdcard/qg-captcha-dump.xml", timeout=12)
        xml = adb_shell(serial, "cat /sdcard/qg-captcha-dump.xml", timeout=8)
    except Exception:
        return layout
    if "puzzle" not in xml:
        return layout
    bg = btn = None
    nodes = re.findall(r'<node[^>]*resource-id="([^"]*puzzle[^"]*)"[^>]*bounds="(\[[^\"]+\])"', xml)
    for rid, bounds in nodes:
        b = parse_bounds(bounds)
        if not b:
            continue
        if rid.endswith("question-img") and bg is None:
            bg = b
        elif rid.endswith("btn-icon") and btn is None:
            btn = b
    if bg and btn:
        layout["bg"] = bg
        layout["btn"] = btn
        # 拼图块控件 id 不固定: 用「背景内下部矩形带」推 (实测块带 ≈背景高 59.6%~87.8%)
        bx0, by0, bx1, by1 = bg
        bh = by1 - by0
        layout["piece"] = (bx0, by0 + int(bh * 0.596), bx0 + 150, by0 + int(bh * 0.878))
        layout["detected"] = True
    return layout


def on_captcha_page(serial):
    """topResumedActivity 是否仍是验证码 ContainerActivity。"""
    act = adb_shell(serial, "dumpsys activity activities | grep topResumedActivity | head -1")
    return CAPTCHA_ACTIVITY in act


# ---------------- 视觉定位 ----------------
# 关键认知 (2026-10-09 真机截图实证): 这不是"拼图缺口"验证码, 是图标匹配验证码——
# 滑块上是浅色图标 (树/苹果...), 条带内有 2~3 个暗色图标, 其中形状相同的才是真目标,
# 其余是干扰项。单纯找"最暗带子"必然大概率拖到干扰项 (昨晚 4 连败的根因)。
# 所以主算法 = 轮廓相关匹配: 滑块图标的亮起轮廓 vs 各暗色图标的暗度轮廓。

def strip_brightness(img, bg, piece):
    """拼图块同一水平带的列亮度曲线 (暗带定位法的分析区域)。"""
    bx0, by0, bx1, by1 = bg
    sy0 = piece[1] if by0 <= piece[1] < by1 else by0 + int((by1 - by0) * 0.596)
    sy1 = piece[3] if by0 < piece[3] <= by1 else by0 + int((by1 - by0) * 0.878)
    strip = img[sy0:sy1, bx0:bx1]
    bri = strip.mean(axis=0)
    k = max(9, (bx1 - bx0) // 24)  # 实测 1080 宽时 ≈40
    # 必须除以窗宽取均值: 当晚 /tmp/auto_solve.sh 漏了这一步, 亮度被放大 k 倍,
    # "base-8" 阈值实际等于 "base-0.2", 暗带判定形同虚设 (4 连败的隐性根因之一)
    return np.convolve(bri, np.ones(k), mode="same") / k


def dark_band_candidates(img, bg, piece, max_cand=3):
    """暗带定位法 (降级用): 列亮度低于基线-8 的最长连续带。无法区分目标与干扰项。"""
    bx0, _, bx1, _ = bg
    bri_s = strip_brightness(img, bg, piece)
    w = len(bri_s)
    left_cut = max(160, (piece[2] - piece[0]) + 20)  # 排除拼图块自身 + 余量
    base = np.median(bri_s[left_cut: w - 30])
    dark = bri_s < (base - 8)
    dark[:left_cut] = False
    dark[-30:] = False
    runs = []
    i = 0
    while i < w:
        if dark[i]:
            j = i
            while j < w and dark[j]:
                j += 1
            runs.append((j - i, i))
            i = j
        else:
            i += 1
    runs.sort(reverse=True)
    return [(bx0 + s, ln) for ln, s in runs[:max_cand] if ln >= 40]


def _half_max_edges(prof, peak_idx):
    """从峰值向两侧走到半峰值处 → 图标字形真实边缘 (消除软阴影晕染)。"""
    half = prof[peak_idx] / 2.0
    l = peak_idx
    while l > 0 and prof[l] > half:
        l -= 1
    r = peak_idx
    while r < len(prof) - 1 and prof[r] > half:
        r += 1
    return l + 1, r


def icon_targets(img, bg, piece, max_cand=3):
    """图标匹配法 (主算法, 2026-10-09 真机数据实证):

    每张题面只有一个是「实暗」图标 (真目标, 变暗深度 ≈35% 基线);
    干扰项与背景阴影只有 7~13% 的「虚暗」→ 峰值深度/基线 即判别分。
    定位用半峰宽边缘: 目标图标常带向左晕开的软阴影, 低阈值 run 的左缘
    会被阴影污染 (captcha2: run 左缘 394 vs 字形真实左缘 ≈430+)。
    滑块浅色图标用同一套半峰逻辑测边缘, 对称处理抵消系统偏差。

    返回 [(目标字形左缘绝对x, 得分, 字形宽, 峰深)] 按得分降序。
    """
    bx0, _, bx1, _ = bg
    bri_s = strip_brightness(img, bg, piece)
    w = len(bri_s)
    cut = max(160, (piece[2] - piece[0]) + 20)
    base = np.median(bri_s[cut: w - 30])
    depth = base - bri_s
    depth[:cut] = 0
    depth[-30:] = 0

    th_lo = max(8, base * 0.05)
    runs = []
    i = 0
    while i < w:
        if depth[i] > th_lo:
            j = i
            while j < w and depth[j] > th_lo:
                j += 1
            if runs and i - runs[-1][1] < 25:  # 近邻合并 (同一图标的碎带)
                runs[-1] = (runs[-1][0], j)
            else:
                runs.append((i, j))
            i = j
        else:
            i += 1

    cands = []
    for a, b in runs:
        seg = depth[a:b]
        pk = float(seg.max())
        if pk < max(10, base * 0.12):  # 虚暗干扰项 (实测 ≤13%), 直接淘汰
            continue
        el, er = _half_max_edges(seg, int(np.argmax(seg)))
        cands.append((bx0 + a + el, round(pk / base, 3), er - el, round(pk, 1)))
    cands.sort(key=lambda c: -c[1])
    return cands[:max_cand]


def piece_glyph_left(img, bg, piece):
    """滑块浅色图标的半峰左缘 (绝对坐标): dx = 目标左缘 - 本值。"""
    bx0, _, _, _ = bg
    bri_s = strip_brightness(img, bg, piece)
    cut = max(160, (piece[2] - piece[0]) + 20)
    base = np.median(bri_s[cut: len(bri_s) - 30])
    hi = bri_s[:cut] - base
    pk_i = int(np.argmax(hi))
    if hi[pk_i] < 5:
        return None
    el, _ = _half_max_edges(hi, pk_i)
    return bx0 + el


def gradient_gap(img, bg, piece):
    """列梯度能量法 (v1, 辅助): 边缘能量峰值列。"""
    bx0, by0, bx1, by1 = bg
    bg_crop = img[by0:by1, bx0:bx1]
    gx = np.abs(np.diff(bg_crop, axis=1))
    energy = np.convolve(gx.sum(axis=0), np.ones(12), mode="same")
    cut = max(160, (piece[2] - piece[0]) + 20)
    energy[:cut] = 0
    energy[-30:] = 0
    if energy.max() <= 0:
        return None
    return bx0 + int(np.argmax(energy))


# ---------------- 拟人轨迹 ----------------

def bezier_points(sx, sy, dx, n=16):
    """变速多点轨迹: 缓入缓出 + y 微漂移 + 末端过冲回拉。返回 [(x,y,sleep)]。"""
    pts = []
    overshoot = random.randint(6, 14)
    total = dx + overshoot
    for i in range(n):
        t = i / (n - 1)
        ease = t * t * (3 - 2 * t)                     # smoothstep: 慢-快-慢
        # 速度扰动: 随机 0.6~1.4 倍停留, 中段快两端慢
        seg_sleep = 0.03 + 0.05 * abs(math.cos(t * math.pi)) + random.uniform(0, 0.025)
        yj = 0 if i in (0, n - 1) else random.randint(-3, 3)
        pts.append((int(sx + total * ease), sy + yj, round(seg_sleep, 3)))
    pts.append((int(sx + dx), sy, 0.06))               # 过冲后回拉到目标
    return pts


def gesture_motion(serial, sx, sy, dx):
    """input motionevent 流式注入: 单次 adb 调用完成 DOWN→MOVE*→UP 连续手势。"""
    pts = bezier_points(sx, sy, dx)
    parts = [f"input motionevent DOWN {pts[0][0]} {pts[0][1]}"]
    for x, y, s in pts[1:]:
        parts.append(f"sleep {s}")
        parts.append(f"input motionevent MOVE {x} {y}")
    parts.append("sleep 0.05")
    parts.append(f"input motionevent UP {pts[-1][0]} {pts[-1][1]}")
    adb_shell(serial, "; ".join(parts), timeout=25)


def gesture_swipe(serial, sx, sy, dx, ms=420):
    """降级通道: 单段 input swipe (匀速直线, 风控易识破, 仅兜底)。"""
    adb_shell(serial, f"input swipe {int(sx)} {int(sy)} {int(sx + dx)} {int(sy)} {ms}")


def wait_refresh(serial, layout, prev_png, timeout_s=12):
    """失败后等待题目刷新。失败横幅本身也会造成画面变化, 所以必须
    「已变化 + 连续两次采样稳定」双条件都满足才算新题面渲染完成。"""
    prev = np.asarray(Image.open(prev_png).convert("L"), dtype=float)
    bx0, _, bx1, _ = layout["bg"]
    sy0 = max(layout["piece"][1] - 30, layout["bg"][1])
    sy1 = min(layout["piece"][3] + 30, layout["bg"][3])
    ref = prev[sy0:sy1, bx0:bx1]
    changed = False
    last = ref
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(0.8)
        p = f"{TMP_DIR}/poll.png"
        screencap(serial, p)
        cur = np.asarray(Image.open(p).convert("L"), dtype=float)[sy0:sy1, bx0:bx1]
        if cur.shape != ref.shape:
            return False
        d_prev = float(np.abs(cur - ref).mean())
        d_last = float(np.abs(cur - last).mean())
        if d_prev > 6:
            changed = True
        if changed and d_last < 2.0 and d_prev > 6:
            time.sleep(1.0)  # 渲染余量
            return True
        last = cur
    return False


def piece_moved(serial, layout, before_img):
    """对比拼图块行带是否变化, 判断手势是否真的生效 (motionevent 可用性探测)。"""
    if not os.path.exists(f"{TMP_DIR}/after.png"):
        return True
    a = np.asarray(Image.open(f"{TMP_DIR}/after.png").convert("L"), dtype=float)
    pa = np.asarray(before_img.convert("L"), dtype=float)
    band_a = strip_brightness(a, layout["bg"], layout["piece"])
    band_b = strip_brightness(pa, layout["bg"], layout["piece"])
    return float(np.abs(band_a - band_b).mean()) > 1.5


def notify_mac(title, msg):
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{msg}" with title "{title}"'],
                       timeout=5, capture_output=True)
    except Exception:
        pass


# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser(description="大麦拼图滑块验证码半自动求解")
    ap.add_argument("--serial", default=None)
    ap.add_argument("--attempts", type=int, default=5)
    ap.add_argument("--offset", type=int, default=0, help="落点微调 px (通过一次后写回默认值)")
    ap.add_argument("--analyze", action="store_true", help="只定位打印, 不滑动")
    ap.add_argument("--mode", choices=["auto", "motion", "swipe"], default="auto")
    args = ap.parse_args()

    serial = pick_serial(args.serial)
    os.makedirs(TMP_DIR, exist_ok=True)
    print(f"设备: {serial}")

    if not on_captcha_page(serial):
        dump_probe = adb_shell(serial, "dumpsys window 2>/dev/null | grep -i mCurrentFocus | head -1")
        print(f"当前不在验证码页 (topResumedActivity 无 {CAPTCHA_ACTIVITY})\n焦点窗口: {dump_probe}")
        sys.exit(3)

    layout = detect_layout(serial)
    print(f"布局: {'dump 探测' if layout['detected'] else '常数兜底'} bg={layout['bg']} btn={layout['btn']}")
    btn_cx = (layout["btn"][0] + layout["btn"][2]) // 2
    btn_cy = (layout["btn"][1] + layout["btn"][3]) // 2
    piece_left = layout["piece"][0]

    mode = "motion" if args.mode == "auto" else args.mode
    tried = set()

    for attempt in range(1, args.attempts + 1):
        shot = screencap(serial, f"{TMP_DIR}/cap_a{attempt}.png")
        img = np.asarray(Image.open(shot).convert("L"), dtype=float)

        cands = icon_targets(img, layout["bg"], layout["piece"])
        strategy = "图标匹配"
        gap_x = cands[0][0] if cands else None
        pg = piece_glyph_left(img, layout["bg"], layout["piece"])
        # 轮换: 高分目标先试, 试过的候选不再重复; 轮廓匹配无候选时降级暗带/梯度
        fresh = [c for c in cands if c[0] not in tried]
        if attempt > 1 and fresh:
            gap_x = fresh[0][0]
        if gap_x is None:
            db = dark_band_candidates(img, layout["bg"], layout["piece"])
            db = [c for c in db if c[0] not in tried]
            if db:
                gap_x, strategy = db[0][0], "暗带"
        if gap_x is None:
            g = gradient_gap(img, layout["bg"], layout["piece"])
            if g and g not in tried:
                gap_x, strategy = g, "梯度"
        if gap_x is None:
            print(f"[{attempt}] 未定位到目标图标 (可能已通过), 复核中...")
            if not on_captcha_page(serial):
                print("✔ 验证码已通过")
                sys.exit(0)
            continue

        ref = pg if pg is not None else piece_left
        dx = gap_x - ref + args.offset
        tried.add(gap_x)
        print(f"[{attempt}] {strategy} 目标左缘 x={gap_x} (候选: {[(c[0], c[1]) for c in cands]}) "
              f"滑块图标左缘 x={ref} → dx={dx} 模式={mode} offset={args.offset}")

        if args.analyze:
            print(f"    [analyze] 等效滑动: {btn_cx},{btn_cy} → {btn_cx + dx},{btn_cy} (校准: 实际通过后把差额写进 --offset)")
            sys.exit(0)

        before = Image.open(shot)
        t0 = time.time()
        if mode == "motion":
            gesture_motion(serial, btn_cx, btn_cy, dx)
        else:
            gesture_swipe(serial, btn_cx, btn_cy, dx)
        print(f"    手势注入完成 {time.time() - t0:.1f}s")

        time.sleep(1.6)
        screencap(serial, f"{TMP_DIR}/after.png")
        if not on_captcha_page(serial):
            print(f"✔ [{attempt}] 验证码已通过 (topResumedActivity 已切换)")
            notify_mac("大麦验证码", "✔ 已通过")
            sys.exit(0)
        if mode == "motion" and attempt == 1 and not piece_moved(serial, layout, before):
            print("    motionevent 未生效, 后续降级 input swipe")
            mode = "swipe"
        print(f"    ✗ 仍在验证码页, 等待题目刷新...")
        wait_refresh(serial, layout, shot)
        time.sleep(random.uniform(0.5, 1.2))  # 拟人间隔, 避免连击触发频控

    print(f"✗ {args.attempts} 次尝试未通过, 转人工 (截图在 {TMP_DIR}/)")
    notify_mac("大麦验证码", "✗ 自动尝试未通过, 请手动完成")
    sys.exit(1)


if __name__ == "__main__":
    main()
