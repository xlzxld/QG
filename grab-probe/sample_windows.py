# -*- coding: utf-8 -*-
"""
采样 Windows 可见顶层窗口，找出「采样期内新出现」的窗口。

用途：验证脚本 spawn 子进程时会不会弹出控制台黑窗口。
  对照用法：
    A 组（旧代码）：后台跑本脚本 → 触发采集 → 看 new_windows 里有没有
       ConsoleWindowClass / CASCADIA 之类的窗口冒出来；
    B 组（新代码）：同样步骤 → new_windows 应为空（或只有无关窗口）。

用法：
  python sample_windows.py [duration_seconds] [out_json]
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

user32 = ctypes.windll.user32
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

CONSOLE_CLASS_HINTS = ("consolewindowclass", "cascadia", "conhost", "windowsterminal")


def enum_visible_windows():
    out = []

    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = wt.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            out.append({
                "hwnd": int(hwnd),
                "class": cls.value,
                "title": buf.value,
                "pid": int(pid.value),
            })
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    outpath = sys.argv[2] if len(sys.argv) > 2 else "window_samples.json"

    t0 = time.time()
    baseline = enum_visible_windows()
    base_hwnds = {w["hwnd"] for w in baseline}

    seen_new = {}  # hwnd -> {first_seen, last_seen, class, title, pid}
    counts = []

    while time.time() - t0 < duration:
        now = round(time.time() - t0, 2)
        wins = enum_visible_windows()
        counts.append({"t": now, "count": len(wins)})
        for w in wins:
            h = w["hwnd"]
            if h in base_hwnds:
                continue
            if h not in seen_new:
                seen_new[h] = dict(w, first_seen=now, last_seen=now)
            else:
                seen_new[h]["last_seen"] = now
        time.sleep(0.25)

    new_list = sorted(seen_new.values(), key=lambda x: x["first_seen"])
    console_like = [w for w in new_list if any(h in w["class"].lower() for h in CONSOLE_CLASS_HINTS)]

    result = {
        "duration": duration,
        "baseline_count": len(baseline),
        "max_count": max(c["count"] for c in counts) if counts else 0,
        "min_count": min(c["count"] for c in counts) if counts else 0,
        "new_windows": new_list,
        "new_console_like": console_like,
        "verdict_new_windows": len(new_list),
        "verdict_console_windows": len(console_like),
    }
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "baseline_count": result["baseline_count"],
        "new_windows": len(new_list),
        "new_console_like": len(console_like),
        "out": outpath,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
