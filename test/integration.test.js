import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PointwiseDemo } from '../src/demo.js';
import { Downloader, TransferInterruptedError } from '../src/downloader.js';
import { KIND_MAP, KIND_TABLE, StationGoneError } from '../src/station.js';

let demo;
let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointwise-'));
  demo = new PointwiseDemo(root);
  await demo.reset();
});

async function readPublished() {
  return fs.readdir(demo.publishDir);
}

test('正常路径：空目录开始采集，图、表成套发布且只保留一份', async () => {
  const result = await demo.collectOnce();
  assert.equal(result.ok, true);
  assert.equal(result.after.assembly.verdict, 'READY_TO_PUBLISH');
  assert.equal(result.after.assembly.matched, true);
  assert.equal(result.after.assembly.pairVersion, 'v1');

  const files = await readPublished();
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith('-map.svg')));
  assert.ok(files.some((f) => f.endsWith('-table.csv')));

  // 分片与侧车在转正后被清理
  assert.equal(result.after.downloads.map.partBytes, 0);
  assert.equal(result.after.downloads.table.partBytes, 0);
  assert.equal(result.report.downloads.every((d) => d.resumed === false), true);
});

test('正常路径：重复采集不会产生多份发布物（同线路只保留一份）', async () => {
  await demo.collectOnce();
  const second = await demo.collectOnce();
  assert.equal(second.ok, true);
  const files = await readPublished();
  assert.equal(files.length, 2);
});

test('断点续传：站点未修订时，重试按原版本标记从断点续传', async () => {
  // 制造掉线现场（站点保持 v1）
  const dl = new Downloader(demo.station, demo.workDir, demo.finalDir);
  await assert.rejects(() => dl.download(KIND_MAP, { failAfterChunks: 2 }), TransferInterruptedError);
  const partBefore = await fs.readFile(path.join(demo.workDir, `${KIND_MAP}.part`));
  assert.ok(partBefore.length > 0);

  const result = await demo.retryResume();
  assert.equal(result.ok, true);
  const mapReport = result.report.downloads.find((d) => d.kind === KIND_MAP);
  assert.equal(mapReport.resumed, true);
  assert.equal(mapReport.decision.action, 'resume');
  assert.equal(mapReport.decision.reason, 'OK');
  assert.equal(result.after.assembly.verdict, 'READY_TO_PUBLISH');
});

test('异常路径（题眼）：断点后站点修订，重试校验发现版本漂移，从头取新版本', async () => {
  const broken = await demo.breakAndRevise();
  assert.equal(broken.ok, true);
  assert.equal(broken.after.station.version, 'v2');
  // 分片仍记录着掉线时的 v1 原版本标记
  assert.equal(broken.after.downloads.map.sidecarVersion, 'v1');
  assert.equal(broken.after.downloads.table.sidecarVersion, 'v1');
  assert.ok(broken.after.downloads.map.partBytes > 0);

  const retry = await demo.retryResume();
  assert.equal(retry.ok, true);
  for (const d of retry.report.downloads) {
    assert.equal(d.resumed, false, `${d.kind} 不应续传旧分片`);
    assert.equal(d.decision.action, 'restart');
    assert.equal(d.decision.reason, 'VERSION_REVISED');
    assert.equal(d.version, 'v2');
  }
  // 装配器只发布配得上的 v2 一份，v1 分片被丢弃
  assert.equal(retry.after.assembly.verdict, 'READY_TO_PUBLISH');
  assert.equal(retry.after.assembly.pairVersion, 'v2');
  const files = await readPublished();
  assert.ok(files.every((f) => f.includes('-v2-')));
});

test('异常路径：弱版本标记下，即便版本号相同也不敢续传，从头取', async () => {
  const dl = new Downloader(demo.station, demo.workDir, demo.finalDir);
  await assert.rejects(() => dl.download(KIND_MAP, { failAfterChunks: 2 }), TransferInterruptedError);

  // 切弱标记：站点当前标记不再携带内容哈希
  await demo.setMarkerMode('weak');
  const result = await demo.retryResume();
  assert.equal(result.ok, true);
  const mapReport = result.report.downloads.find((d) => d.kind === KIND_MAP);
  assert.equal(mapReport.decision.action, 'restart');
  assert.equal(mapReport.decision.reason, 'CURRENT_MARKER_UNRELIABLE');
  assert.equal(mapReport.resumed, false);
});

test('异常路径（题眼）：配套表缺失时装配器拒绝发布，线路图单独不得上线', async () => {
  const collected = await demo.collectOnce();
  assert.equal(collected.after.assembly.verdict, 'READY_TO_PUBLISH');
  const publishedBefore = await readPublished();
  assert.equal(publishedBefore.length, 2);

  const missing = await demo.simulateMissingTable();
  assert.equal(missing.ok, true);
  assert.equal(missing.after.station.withdrawn.includes(KIND_TABLE), true);
  assert.equal(missing.after.assembly.verdict, 'BLOCKED');
  assert.equal(missing.after.assembly.matched, false);
  const codes = missing.after.assembly.checks.map((c) => c.code);
  assert.ok(codes.includes('TABLE_GONE'));

  // 发布目录维持上一份有效资料，不会出现只有图的半成品
  const publishedAfter = await readPublished();
  assert.deepEqual(publishedAfter.sort(), publishedBefore.sort());
});

test('恢复路径：站点恢复站点表后补齐，图、表重新配得上并发布', async () => {
  await demo.collectOnce();
  await demo.simulateMissingTable();
  const restored = await demo.restoreTable();
  assert.equal(restored.ok, true);
  assert.equal(restored.after.assembly.verdict, 'READY_TO_PUBLISH');
  assert.equal(restored.after.assembly.matched, true);
  const files = await readPublished();
  assert.equal(files.length, 2);
});

test('异常路径：手工强制重试忽略分片，两个附件全部从头取', async () => {
  await demo.breakAndRevise();
  const result = await demo.retryResume({ forceRestart: true });
  assert.equal(result.ok, true);
  assert.ok(result.report.downloads.every((d) => d.resumed === false));
  assert.equal(result.after.assembly.pairVersion, 'v2');
});

test('异常路径：向已撤回附件直接下载会收到 410 Gone 语义错误', async () => {
  const dl = new Downloader(demo.station, demo.workDir, demo.finalDir);
  demo.station.withdraw(KIND_TABLE);
  await assert.rejects(() => dl.download(KIND_TABLE), (err) => {
    return err instanceof StationGoneError && err.code === 'STATION_GONE';
  });
});

test('证据：每个写操作都带 before/after 快照与逐项变化', async () => {
  const result = await demo.breakAndRevise();
  assert.ok(result.before && result.after);
  assert.ok(Array.isArray(result.changes) && result.changes.length > 0);
  const changePaths = result.changes.map((c) => c.path);
  assert.ok(changePaths.includes('station.version'));
  const versionChange = result.changes.find((c) => c.path === 'station.version');
  assert.equal(versionChange.before, 'v1');
  assert.equal(versionChange.after, 'v2');
});
