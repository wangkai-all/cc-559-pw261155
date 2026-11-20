import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SimulatedStation, KIND_MAP, KIND_TABLE } from '../src/station.js';
import { Downloader } from '../src/downloader.js';
import { Assembler, extractEmbeddedVersion } from '../src/assembler.js';

let root;
let station;
let downloader;
let assembler;
let finalDir;
let publishDir;
let workDir;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointwise-asm-'));
  workDir = path.join(root, 'staging');
  finalDir = path.join(root, 'downloads');
  publishDir = path.join(root, 'published');
  station = new SimulatedStation();
  downloader = new Downloader(station, workDir, finalDir);
  assembler = new Assembler(station, finalDir, publishDir);
});

test('内嵌版本提取：SVG 与 CSV 均可解析出版本号', () => {
  const release = station.releases.v1;
  assert.equal(extractEmbeddedVersion(KIND_MAP, release.attachments.map.text), 'v1');
  assert.equal(extractEmbeddedVersion(KIND_TABLE, release.attachments.table.text), 'v1');
});

test('正常装配：同版本且哈希一致 → READY_TO_PUBLISH，发布后目录只有图、表各一份', async () => {
  await downloader.download(KIND_MAP);
  await downloader.download(KIND_TABLE);
  const evaluation = await assembler.evaluate();
  assert.equal(evaluation.verdict, 'READY_TO_PUBLISH');
  assert.equal(evaluation.matched, true);

  const pub = await assembler.publish();
  assert.equal(pub.published, true);
  const files = await fs.readdir(publishDir);
  assert.deepEqual(files.sort(), [evaluation.pair.map.fileName, evaluation.pair.table.fileName].sort());
});

test('异常装配：只有线路图、缺站点表 → BLOCKED 且不发布', async () => {
  await downloader.download(KIND_MAP);
  const evaluation = await assembler.evaluate();
  assert.equal(evaluation.verdict, 'BLOCKED');
  assert.equal(evaluation.matched, false);
  assert.ok(evaluation.checks.some((c) => c.code === 'TABLE_MISSING' && !c.ok));

  const pub = await assembler.publish();
  assert.equal(pub.published, false);
  await assert.rejects(fs.readdir(publishDir), /ENOENT/);
});

test('异常装配：本地是旧版本、站点已修订 → 内嵌版本与站点不一致，拒绝装配', async () => {
  // 先在 v1 下完整下载
  await downloader.download(KIND_MAP);
  await downloader.download(KIND_TABLE);
  // 站点修订为 v2：finalDir 里留下的 v1 文件全部变成过期件
  station.reviseTo('v2');

  const evaluation = await assembler.evaluate();
  assert.equal(evaluation.verdict, 'BLOCKED');
  const codes = evaluation.checks.filter((c) => !c.ok).map((c) => c.code);
  assert.ok(codes.includes('MAP_STALE'));
  assert.ok(codes.includes('TABLE_STALE'));
  const pub = await assembler.publish();
  assert.equal(pub.published, false);
});

test('异常装配：文件被篡改导致哈希不符 → HASH_BAD，拒绝发布', async () => {
  await downloader.download(KIND_MAP);
  await downloader.download(KIND_TABLE);
  const marker = station.getMarker(KIND_MAP);
  const target = path.join(finalDir, marker.fileName);
  await fs.appendFile(target, '<!-- tampered -->');

  const evaluation = await assembler.evaluate();
  assert.equal(evaluation.verdict, 'BLOCKED');
  assert.ok(evaluation.checks.some((c) => c.code === 'MAP_HASH_BAD' && !c.ok));
});

test('重新发布新版本时，旧版本发布物被清理，始终只保留配得上的一份', async () => {
  await downloader.download(KIND_MAP);
  await downloader.download(KIND_TABLE);
  await assembler.publish();
  const first = (await fs.readdir(publishDir)).sort();
  assert.ok(first.every((f) => f.includes('-v1-')));

  station.reviseTo('v2');
  await downloader.download(KIND_MAP);
  await downloader.download(KIND_TABLE);
  const pub2 = await assembler.publish();
  assert.equal(pub2.published, true);
  const second = (await fs.readdir(publishDir)).sort();
  assert.equal(second.length, 2);
  assert.ok(second.every((f) => f.includes('-v2-')));
});
