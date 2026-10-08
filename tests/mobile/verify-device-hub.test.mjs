import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TEST_PORT = 3129; // 专属测试端口

describe('Device Hub (:3129) API 自动化验证', () => {
  let hubProc;

  beforeAll(async () => {
    // 启动测试 Hub 进程
    hubProc = spawn(process.execPath, [path.join(ROOT, 'core', 'device-hub.mjs')], {
      env: { ...process.env, DEVICE_HUB_PORT: String(TEST_PORT) },
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
      mode: 'rush',
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
});
