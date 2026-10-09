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
      grab: { dryRun: true, button: { x: 682, y: 2305 }, submit: { x: -1, y: 0 }, maxChainMs: 1, evilField: 'x' }
    });
    expect(r4.status).toBe(200);
    const d4 = await r4.json();
    expect(d4.status).toBe('dispatched');
    expect(d4.task.grab.dryRun).toBe(true);
    expect(d4.task.grab.button).toEqual({ x: 682, y: 2305 });
    expect(d4.task.grab.submit).toBe(null);            // 非法坐标被丢弃, 不兜底
    expect(d4.task.grab.maxChainMs).toBe(3000);        // clamp 下限
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
});
