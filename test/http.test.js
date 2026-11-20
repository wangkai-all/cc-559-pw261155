import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.js';
import { PointwiseDemo } from '../src/demo.js';

let base;
let server;
let demoRoot;

function api(p, body) {
  return fetch(new URL(p, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

before(async () => {
  demoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pointwise-http-'));
  const demo = new PointwiseDemo(demoRoot);
  await demo.reset();
  server = createServer({ demo });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
    }),
);

test('页面可访问，业务结果区带 data-evidence-result 属性', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-evidence-result'));
  assert.ok(html.includes('开始采集线路资料'));
  assert.ok(html.includes('模拟断点后修订'));
  assert.ok(html.includes('查看配套附件状态'));
});

test('GET /api/state 返回空目录初始快照', async () => {
  const res = await fetch(base + '/api/state');
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.state.station.version, 'v1');
  assert.deepEqual(payload.state.published, []);
});

test('端到端：采集 → 断点修订 → 重试（版本漂移从头取 v2）→ 成套发布', async () => {
  const reset = await api('/api/reset');
  assert.equal(reset.status, 200);

  const collect = await api('/api/collect');
  assert.equal(collect.status, 200);
  assert.equal(collect.json.after.assembly.verdict, 'READY_TO_PUBLISH');
  assert.equal(collect.json.after.published.length, 2);

  const broken = await api('/api/break-revise');
  assert.equal(broken.json.after.station.version, 'v2');
  assert.ok(broken.json.after.downloads.map.partBytes > 0);

  const retry = await api('/api/retry', { forceRestart: false });
  assert.equal(retry.status, 200);
  assert.ok(retry.json.report.downloads.every((d) => d.decision.reason === 'VERSION_REVISED'));
  assert.equal(retry.json.after.assembly.pairVersion, 'v2');
  assert.ok(retry.json.after.published.every((f) => f.includes('-v2-')));
});

test('端到端异常：配套表缺失后装配 BLOCKED 且不新增发布物', async () => {
  await api('/api/reset');
  await api('/api/collect');
  const missing = await api('/api/missing-table');
  // 操作本身执行成功（200），业务结论体现在装配裁决中
  assert.equal(missing.status, 200);
  assert.equal(missing.json.ok, true);
  assert.equal(missing.json.after.assembly.verdict, 'BLOCKED');
  assert.equal(missing.json.after.station.withdrawn.includes('table'), true);
  assert.ok(missing.json.after.assembly.checks.some((c) => c.code === 'TABLE_GONE' && !c.ok));
});

test('弱标记切换后重试，同版本号下也因标记不可靠而从头取', async () => {
  await api('/api/reset');
  // 只掉线、不修订：分片与站点同属 v1
  const broken = await api('/api/break-only');
  assert.equal(broken.status, 200);
  assert.ok(broken.json.after.downloads.map.partBytes > 0);

  await api('/api/marker-mode', { mode: 'weak' });
  const retry = await api('/api/retry');
  assert.equal(retry.json.after.station.markerMode, 'weak');
  assert.ok(retry.json.report.downloads.every((d) => d.decision.reason === 'CURRENT_MARKER_UNRELIABLE'));
  assert.ok(retry.json.report.downloads.every((d) => d.resumed === false));
});

test('强标记同版本掉线后重试，决策为 OK 并走断点续传', async () => {
  await api('/api/reset');
  await api('/api/break-only');
  const retry = await api('/api/retry');
  const mapReport = retry.json.report.downloads.find((d) => d.kind === 'map');
  assert.equal(mapReport.decision.reason, 'OK');
  assert.equal(mapReport.resumed, true);
  assert.equal(retry.json.after.assembly.verdict, 'READY_TO_PUBLISH');
});

test('发布目录中的附件可通过 /published/ 直接访问', async () => {
  await api('/api/reset');
  const collect = await api('/api/collect');
  const fileName = collect.json.after.published.find((f) => f.endsWith('.svg'));
  const res = await fetch(base + '/published/' + fileName);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('<svg'));
});

test('未知接口返回 404，静态目录穿越被拒绝', async () => {
  const r1 = await api('/api/nope');
  assert.equal(r1.status, 404);
  const r2 = await fetch(base + '/../package.json');
  // URL 规范化后 /../ 会被折叠，服务端对未列出的路径返回 404
  assert.equal(r2.status, 404);
});
