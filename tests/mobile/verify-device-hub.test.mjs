import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TEST_PORT = 3129; // 专属测试端口

describe('Device Hub (:3129) API 自动化验证', () => {
  let hubProc;
  let tmpDataDir;

  beforeAll(async () => {
    // 独立临时数据目录: 测试不污染生产 data/grab/ (结果/事件/PID 文件)
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
    // 启动测试 Hub 进程
    hubProc = spawn(process.execPath, [path.join(ROOT, 'core', 'device-hub.mjs')], {
      env: { ...process.env, DEVICE_HUB_PORT: String(TEST_PORT), DEVICE_HUB_DATA_DIR: tmpDataDir },
      stdio: 'pipe'
    });

    // 等待服务启动
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
        if (res.ok) break;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    if (hubProc) {
      hubProc.kill('SIGTERM');
    }
    if (tmpDataDir) {
      try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  });

  it('1. GET /health 正常响应服务状态', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('device-hub');
  });

  it('2. POST /api/device/hello 设备握手与上线注册', async () => {
    const payload = {
      deviceId: 'test-phone-01',
      agentVersion: '1.0.0',
      autoX: '7.2.4',
      screen: [1080, 2400],
      accessibility: true,
      shizuku: 'active'
    };

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/hello`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(200);
    const ret = await res.json();
    expect(ret.status).toBe('registered');
    expect(ret.deviceId).toBe('test-phone-01');

    // 检查列表
    const listRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/devices`);
    const listData = await listRes.json();
    const found = listData.devices.find(d => d.deviceId === 'test-phone-01');
    expect(found).toBeDefined();
    expect(found.isAlive).toBe(true);
  });

  it('3. POST /api/device/heartbeat 心跳上报与状态刷新', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'test-phone-01',
        state: 'idle',
        battery: 95,
        charging: true,
        accessibility: true
      })
    });

    expect(res.status).toBe(200);
    const ret = await res.json();
    expect(ret.status).toBe('ok');
  });

  it('4. 长轮询与任务派发 (poll-task & dispatch)', async () => {
    // 启动长轮询异步等待
    const pollPromise = fetch(`http://127.0.0.1:${TEST_PORT}/api/device/poll-task?deviceId=test-phone-01`)
      .then(r => r.json());

    // 稍等 100ms 后从 PC 端派发任务
    await new Promise(r => setTimeout(r, 100));

    const testTask = {
      taskId: 't-test-damai-001',
      platform: 'damai',
      mode: 'test',
      target: {
        name: '周杰伦演唱会',
        session: '10.15 19:30',
        priceText: '内场 1280'
      },
      timing: {
        fireAtEpochMs: Date.now() + 10000,
        leadMs: 40
      }
    };

    const dispatchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task: testTask })
    });

    expect(dispatchRes.status).toBe(200);

    // 验证长轮询被成功唤醒并收到任务
    const pollResult = await pollPromise;
    expect(pollResult.status).toBe('task');
    expect(pollResult.task.taskId).toBe('t-test-damai-001');
  });

  it('5. 结果上报与幂等去重 (result deduplication)', async () => {
    const uniqueTaskId = `t-test-damai-${Date.now()}`;
    const reportData = {
      deviceId: 'test-phone-01',
      taskId: uniqueTaskId,
      seq: 1,
      outcome: 'ordered',
      orderNo: 'DM202610080001',
      evidence: '订单提交成功',
      ts: Date.now()
    };

    // 第一次上报
    const res1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportData)
    });
    expect(res1.status).toBe(200);
    const ret1 = await res1.json();
    expect(ret1.status).toBe('ack');
    expect(ret1.recorded).toBe(true);

    // 第二次重复上报相同 taskId + seq
    const res2 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportData)
    });
    expect(res2.status).toBe(200);
    const ret2 = await res2.json();
    expect(ret2.status).toBe('ack');
    expect(ret2.deduplicated).toBe(true);
  });

  it('6. 排队中任务取消 → 队列移除并合成已取消结果', async () => {
    const taskId = `t-test-cancel-queued-${Date.now()}`;
    // 派发 (无挂起轮询 → 入队)
    const dispatchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task: { taskId, platform: 'damai', mode: 'test', target: { name: '取消测试' } } })
    });
    expect(dispatchRes.status).toBe(200);
    const dp = await dispatchRes.json();
    expect(dp.dispatchedImmediately).toBe(false);

    // 取消
    const cancelRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    expect(cancelRes.status).toBe(200);
    const cr = await cancelRes.json();
    expect(cr.status).toBe('cancelled');
    expect(cr.scope).toBe('queued');

    // 状态列表应显示已取消
    const stateRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/state`);
    const stateData = await stateRes.json();
    const item = stateData.tasks.find(t => t.taskId === taskId);
    expect(item).toBeDefined();
    expect(item.result.outcome).toBe('cancelled');
    expect(item.result.reason).toBe('manual_abort');
  });

  it('7. 执行中任务取消 → 心跳回带 control 指令 → 手机回报 cancelled', async () => {
    const taskId = `t-test-cancel-running-${Date.now()}`;
    // 先挂长轮询再派发 → 手机(模拟)立即领取
    const pollPromise = fetch(`http://127.0.0.1:${TEST_PORT}/api/device/poll-task?deviceId=test-phone-01`).then(r => r.json());
    await new Promise(r => setTimeout(r, 100));
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task: { taskId, platform: 'damai', mode: 'test', target: { name: '回带测试' } } })
    });
    const polled = await pollPromise;
    expect(polled.status).toBe('task');
    expect(polled.task.taskId).toBe(taskId);

    // 手机开始执行: 心跳携带 taskId
    const hb1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', state: 'busy', taskId })
    }).then(r => r.json());
    expect(hb1.control).toBeUndefined(); // 未取消前不带指令

    // 控制台请求取消 → 设备正在执行 → cancelling
    const cancelRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    }).then(r => r.json());
    expect(cancelRes.status).toBe('cancelling');
    expect(cancelRes.scope).toBe('running');

    // 下一个心跳应回带取消指令
    const hb2 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', state: 'busy', taskId })
    }).then(r => r.json());
    expect(hb2.control).toBeDefined();
    expect(hb2.control.cancelTaskId).toBe(taskId);

    // 手机停下并回报 cancelled 结果
    const resultRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', taskId, seq: 1, outcome: 'cancelled', reason: 'manual_abort', evidence: '用户手动终止' })
    }).then(r => r.json());
    expect(resultRes.recorded).toBe(true);

    // 结果到达后不再回带
    const hb3 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', state: 'idle', taskId })
    }).then(r => r.json());
    expect(hb3.control).toBeUndefined();
  });

  it('8. 已完成任务取消 → already_done 提示', async () => {
    const taskId = `t-test-cancel-done-${Date.now()}`;
    const pollPromise = fetch(`http://127.0.0.1:${TEST_PORT}/api/device/poll-task?deviceId=test-phone-01`).then(r => r.json());
    await new Promise(r => setTimeout(r, 100));
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task: { taskId, platform: 'damai', mode: 'test', target: { name: '已完成测试' } } })
    });
    await pollPromise;

    // 手机完成上报
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', taskId, seq: 1, outcome: 'success', evidence: '演练完成' })
    });

    const cancelRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    }).then(r => r.json());
    expect(cancelRes.status).toBe('already_done');
  });

  it('9. 取消后收到真实结果 → 真实结果权威覆盖合成取消', async () => {
    const taskId = `t-test-cancel-late-${Date.now()}`;
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task: { taskId, platform: 'damai', mode: 'test', target: { name: '竞态测试' } } })
    });

    // 取消 (设备当前未执行它 → 本地合成 cancelled)
    const cr = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    }).then(r => r.json());
    expect(cr.status).toBe('cancelled');

    // 手机实际上还是把任务跑完了并上报真实结果 (seq=1, 与合成 seq=0 不同)
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', taskId, seq: 1, outcome: 'ordered', evidence: '取消太晚, 订单已提交' })
    });

    const stateData = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/state`).then(r => r.json());
    const item = stateData.tasks.find(t => t.taskId === taskId);
    expect(item.result.outcome).toBe('ordered'); // 真实结果覆盖
    expect(item.cancelRequested).toBe(false);    // 取消标记已清
  });

  it('10. grab 模式派发校验与字段透传 (闸门)', async () => {
    const dispatch = (task) => fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', task })
    });

    // 10a. 未知/已下线模式 (旧 rush) → 400
    const r1 = await dispatch({ mode: 'rush', target: { name: '旧模式', itemId: '1085142029424' }, timing: { fireAtEpochMs: Date.now() + 60000 } });
    expect(r1.status).toBe(400);

    // 10b. grab 缺 itemId → 400 (副作用之前被闸门拦下)
    const r2 = await dispatch({ mode: 'grab', target: {}, timing: { fireAtEpochMs: Date.now() + 60000 } });
    expect(r2.status).toBe(400);

    // 10c. grab 缺开抢时间 → 400
    const r3 = await dispatch({ mode: 'grab', target: { itemId: '1085142029424' } });
    expect(r3.status).toBe(400);

    // 10d. 合法 grab → 200, 白名单字段透传 + clamp + 未知字段丢弃
    const taskId = `t-test-grab-${Date.now()}`;
    const r4 = await dispatch({
      taskId, mode: 'grab',
      target: { name: 'grab透传测试', itemId: '1085142029424', expectKeywords: ['薛之谦', '  ', '贵阳', 'x'.repeat(30)] },
      timing: { fireAtEpochMs: Date.now() + 120000, highFreqLeadMs: 99999 },
      grab: { dryRun: true, blindFire: true, doubleReadMs: 42, popupPollMs: 50, watchPollMs: 400, popupDelayMs: 300, button: { x: 682, y: 2305 }, submit: { x: -1, y: 0 }, popup: { x: 540, y: 1382 }, deadField: 1, evilField: 'x' }
    });
    expect(r4.status).toBe(200);
    const d4 = await r4.json();
    expect(d4.status).toBe('dispatched');
    expect(d4.task.grab.dryRun).toBe(true);
    expect(d4.task.grab.button).toEqual({ x: 682, y: 2305 });
    expect(d4.task.grab.submit).toBe(null);            // 非法坐标被丢弃, 不兜底
    expect(d4.task.grab.popup).toEqual({ x: 540, y: 1382 }); // 弹窗按钮坐标透传 (2026-10-10)
    expect(d4.task.grab.blindFire).toBe(true);         // 到点盲点开关透传
    expect(d4.task.grab.doubleReadMs).toBe(42);        // 双读确认延迟透传
    expect(d4.task.grab.popupPollMs).toBe(50);         // 弹窗探测间隔透传
    expect(d4.task.grab.watchPollMs).toBe(400);        // 终态看护间隔透传
    expect(d4.task.grab.deadField).toBeUndefined();    // 已删死字段丢弃 (旧 maxChainMs 已移除)
    expect(d4.task.grab.maxChainMs).toBeUndefined();   // 旧死字段不得复活
    expect(d4.task.grab.humanMs).toBeUndefined();
    expect(d4.task.grab.hammer).toBeUndefined();       // 无脑高频模式已移除
    expect(d4.task.grab.evilField).toBeUndefined();    // 未知字段丢弃
    expect(d4.task.timing.highFreqLeadMs).toBe(10000); // clamp 上限
    expect(d4.task.target.expectKeywords).toEqual(['薛之谦', '贵阳', 'x'.repeat(24)]);

    // 清理队列 (避免残留影响后续)
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/tasks/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
  });

  it('11. /api/adb/open-item 白名单闸门 (在触碰设备之前拦下)', async () => {
    // 非法 ID → 400
    const r1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/adb/open-item`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'abc' })
    });
    expect(r1.status).toBe(400);

    // 纯数字但不在探针库 → 403 (测试数据目录为空库, 确定性成立)
    const r2 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/adb/open-item`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: '123456789012' })
    });
    expect(r2.status).toBe(403);
  });

  it('12. /api/adb/tap-burst 入参校验 (在触碰设备之前拦下)', async () => {
    const r1 = await fetch(`http://127.0.0.1:${TEST_PORT}/api/adb/tap-burst`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'bad' })
    });
    expect(r1.status).toBe(400);
  });

  it('13. /api/device/verify-script 脚本校验 (体积对账 + 手机侧提示)', async () => {
    const hb = (body) => fetch(`http://127.0.0.1:${TEST_PORT}/api/device/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', state: 'idle', ...body })
    }).then(r => r.json());
    const verify = () => fetch(`http://127.0.0.1:${TEST_PORT}/api/device/verify-script`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.json());

    const hubSize = (await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/devices`)).json()).hubAgentScriptSize;
    expect(hubSize).toBeGreaterThan(1000);            // 电脑上确实有 main.js 可对账

    // 13a. 手机报一个明显不同的体积 → stale, 且明细齐全 ("提示要全面")
    await hb({ scriptSize: 1234 });
    const r1 = await verify();
    expect(r1.verdict).toBe('stale');
    expect(r1.size.phone).toBe(1234);
    expect(r1.size.hub).toBe(hubSize);
    expect(r1.hub.version).toMatch(/^\d+\.\d+\.\d+$/);      // 电脑端版本从脚本里认出来
    expect(r1.steps.length).toBeGreaterThanOrEqual(4);
    expect(r1.hint).toContain('更新手机脚本');
    expect(r1.phonePrompt.delivered).toBe(false);           // 假手机 v1.0.0 不认 self-check 指令 → 只能兜底
    expect(['none', 'adb-notification', 'adb-notification-exec', 'adb-failed']).toContain(r1.phonePrompt.via);
    expect(r1.phonePrompt.note.length).toBeGreaterThan(0);  // 兜底失败也要如实说明, 不假装成功

    // 13b. 体积完全一致 → latest
    await hb({ scriptSize: hubSize });
    const r2 = await verify();
    expect(r2.verdict).toBe('latest');
    expect(r2.size.exact).toBe(true);
    expect(r2.headline).toContain('完全一致');
    // ★ 2026-10-10: 体积字节级一致 ⇒ 同一份代码, 必然认识 phone_op ——
    //   即使版本号字符串是旧的, 也要按"可以手机自检"处理 (这正是用户遇到的那个误报)
    expect(r2.steps.find(s => s.name.includes('手机认识「自检版本」指令')).ok).toBe(true);
    expect(r2.steps.find(s => s.name.includes('版本对账')).ok).toBe(true);
    expect(r2.phonePrompt.via).toBe('no-ack');   // 测试里没有真手机应答 (但通道已经走上 phone_op, 不再走兜底通知)
    // 顺手应答掉这次下发的手机自检任务, 免得它堆在队列里被后面的 13e 抢先领走
    {
      const q = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/poll-task?deviceId=test-phone-01`).then(r => r.json());
      expect(q.status).toBe('task');
      expect(q.task.op).toBe('verify_script');
      await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'test-phone-01', taskId: q.task.taskId, seq: 1, outcome: 'success', message: '(测试自动应答)', evidence: '测试模拟手机回执', data: { exact: true } }),
      });
    }

    // 13c. 体积接近但不完全一致 → near (不谎报"就是最新版")
    await hb({ scriptSize: hubSize - 100 });
    const r3 = await verify();
    expect(r3.verdict).toBe('near');
    expect(r3.size.diff).toBe(-100);

    // 13d. 体积没上报 → unknown (不当成最新)
    await hb({ scriptSize: 0 });
    const r4 = await verify();
    expect(r4.verdict).toBe('unknown');
    expect(r4.headline).toContain('无法判定');

    // 13e. 端侧 v1.3.0 (认自检指令) → 走 phone_op: 手机侧应收到指令并回执, 中枢把手机的话带回来
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/hello`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-phone-01', agentVersion: '1.3.0', screen: [1080, 2400] })
    });
    await hb({ scriptSize: hubSize - 5000 });          // 仍是旧版 → 手机侧应提示"不是最新"
    const pollPromise = fetch(`http://127.0.0.1:${TEST_PORT}/api/device/poll-task?deviceId=test-phone-01`).then(r => r.json());
    await new Promise(r => setTimeout(r, 100));
    const verifyPromise = verify();
    const polled = await pollPromise;
    expect(polled.status).toBe('task');
    expect(polled.task.mode).toBe('phone_op');
    expect(polled.task.op).toBe('verify_script');
    expect(polled.task.params.hubSize).toBe(hubSize);   // 手机据此自己判断, 不需要自己算电脑端体积
    // 冒充手机回报自检结果
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'test-phone-01', taskId: polled.task.taskId, seq: 1, outcome: 'success',
        message: '手机本地自检脚本是否最新',
        evidence: '手机脚本与电脑不一致: 手机 100B / 电脑 999B',
        data: { mySize: 100, myVersion: '1.3.0', hubSize, exact: false }
      })
    });
    const r5 = await verifyPromise;
    expect(r5.verdict).toBe('stale');
    expect(r5.phonePrompt.delivered).toBe(true);         // 手机侧提示已送达
    expect(r5.phonePrompt.via).toBe('agent-toast');
    expect(r5.phonePrompt.phoneSaid.exact).toBe(false);  // 手机自己算出的结论也带回来了
  });

  it('14. ★停止脚本: 指令即时送达 → 手机回报「我要退了」→ 状态立刻刷新; 复探发现还在响应则撤回', async () => {
    const U = `http://127.0.0.1:${TEST_PORT}`;
    const hello = (deviceId, extra = {}) => fetch(`${U}/api/device/hello`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, agentVersion: '1.5.2', screen: [1080, 2400], shizuku: 'active', ...extra }),
    }).then(r => r.json());
    const hb = (deviceId) => fetch(`${U}/api/device/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, state: 'idle', scriptSize: 123 }),
    }).then(r => r.json());
    const chan = () => fetch(`${U}/api/channel`).then(r => r.json());
    const devs = () => fetch(`${U}/api/devices`).then(r => r.json());
    const row = async (id) => (await devs()).devices.find(d => d.deviceId === id);

    const D = 'stop-test-phone';
    await hello(D);
    await hb(D);
    expect((await chan()).channel.wifi).toBe(true);
    expect((await row(D)).isAlive).toBe(true);

    // (a) 手机闲着挂长轮询时: 停止指令必须**即时**塞进那个响应 (秒级, 不等心跳)
    const pendingPoll = fetch(`${U}/api/device/poll-task?deviceId=${D}`).then(r => r.json());
    await new Promise(r => setTimeout(r, 120));
    const stopRes = await fetch(`${U}/api/device/stop-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: D }),
    }).then(r => r.json());
    expect(stopRes.status).toBe('pending');
    expect(stopRes.delivered).toBe(true);                  // 经长轮询即时送达
    const polled = await pendingPoll;
    expect(polled.status).toBe('control');
    expect(polled.control.stopAgent).toBe(true);
    // ★ 关键: 手机还没回报之前, 中枢**不假设**它停了 (不谎报)
    expect((await row(D)).isAlive).toBe(true);
    expect((await row(D)).stoppingAt).toBeUndefined();

    // (b) 手机退出前回报「我要退了」→ 状态**立刻**刷新, 不用等 20 秒心跳超时
    const ack = await fetch(`${U}/api/device/stopping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: D, reason: '收到控制台停止指令', version: '1.5.2' }),
    }).then(r => r.json());
    expect(ack.status).toBe('ok');
    const r2 = await row(D);
    expect(r2.isAlive).toBe(false);                        // ★ 控制台就按这个判"未在线"
    expect(!!r2.stoppingAt).toBe(true);
    // 清场: 把剩下所有 Agent 设备也按"已回报停止"处理, 之后通道里就真的没有活 Agent 了
    for (const d of (await devs()).devices.filter(x => !x.isAdbOnly)) {
      await fetch(`${U}/api/device/stopping`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: d.deviceId, reason: '测试清场' }),
      });
    }
    const c2 = (await chan()).channel;
    expect(c2.wifi).toBe(false);
    expect(c2.mode).not.toBe('wifi');
    expect(c2.shizukuReady).toBe(false);

    // (c) 复探: 手机回报过停止却还在发心跳 → 判定"停止未生效", 撤回标记恢复在线
    await new Promise(r => setTimeout(r, 3200));           // 越过 3 秒宽限期
    await hb(D);
    const r3 = await row(D);
    expect(r3.stoppingAt).toBeUndefined();
    expect(r3.isAlive).toBe(true);
    expect((await chan()).channel.wifi).toBe(true);

    // (d) 脚本重开 (hello) → 正常在线
    await hello(D);
    expect((await row(D)).isAlive).toBe(true);
  });

  it('15. ★更新脚本(Wi-Fi 路径)必须回 ok:true — 曾因缺 ok 字段让控制台必然误报"更新未完成"', async () => {
    const U = `http://127.0.0.1:${TEST_PORT}`;
    await fetch(`${U}/api/device/hello`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'update-test-phone', agentVersion: '1.5.2', screen: [1080, 2400] }),
    });
    const r = await fetch(`${U}/api/device/update-script-lan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'update-test-phone' }),
    }).then(x => x.json());
    expect(r.ok).toBe(true);            // ★ 关键: 必须有 ok, 否则控制台走"更新未完成"分支
    expect(r.pending).toBe(true);       // 语义: 已下发, 手机自己去下载
    expect(Number(r.localSize)).toBeGreaterThan(0);
    expect(String(r.note || '')).toContain('下载');
  });

  it('16. ★中枢重启后: 心跳补报版本号 + 通知手机补注册; 体积一致时不许把"版本号缺失"判成旧脚本', async () => {
    const U = `http://127.0.0.1:${TEST_PORT}`;
    const D = 'restart-test-phone';
    const hb = (extra) => fetch(`${U}/api/device/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: D, state: 'idle', ...extra }),
    }).then(r => r.json());
    const rowOf = async (id) => (await fetch(`${U}/api/devices`).then(r => r.json())).devices.find(d => d.deviceId === id);

    // 模拟"中枢刚重启, 手机第一次心跳进来" —— 心跳必须带 agentVersion (以前只有 hello 带)
    const hb1 = await hb({ agentVersion: '1.5.4', scriptSize: 1 });
    expect(hb1.registered).toBe(false);                   // ★ 中枢不认识它 → 手机据此补发 hello
    const row = await rowOf(D);
    expect(row.agentVersion).toBe('1.5.4');               // ★ 心跳里的版本号必须存下来
    expect(row.isAlive).toBe(true);

    const hb2 = await hb({ agentVersion: '1.5.4', scriptSize: 1 });
    expect(hb2.registered).toBe(true);                    // 已认识, 不用再补注册

    // ★ 用户遇到的误报: 体积与电脑端字节级一致, 但版本号没上报 → 以前判"旧脚本不认识 phone_op"(3 个❌)
    const hubSize = Number((await fetch(`${U}/api/devices`).then(r => r.json())).hubAgentScriptSize);
    expect(hubSize).toBeGreaterThan(1000);
    await fetch(`${U}/api/device/hello`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: D, screen: [1080, 2400] }),   // 刻意不带 agentVersion
    });
    await hb({ scriptSize: hubSize });                    // 刻意不带 agentVersion
    const v = await fetch(`${U}/api/device/verify-script`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: D }),
    }).then(r => r.json());
    expect(v.verdict).toBe('latest');
    expect(v.size.exact).toBe(true);
    const rowOfStep = (kw) => v.steps.find(s => s.name.includes(kw));
    expect(rowOfStep('手机端版本号').ok).toBe(true);        // 体积一致 → 版本号缺失不算❌
    expect(rowOfStep('版本对账').ok).toBe(true);            // 版本对账也不该❌
    expect(rowOfStep('手机认识「自检版本」指令').ok).toBe(true);   // 体积一致 = 同一份代码, 必然认识 phone_op
    expect(v.steps.filter(s => !s.ok).length).toBe(0);    // ★ 用户截图里那 3 个❌ 必须全部消失
    expect(v.phone.deviceId).toBe(D);                     // 指定设备校验 (多台在线时不再随机)
  });
});
