import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResume } from '../src/resumePolicy.js';

const marker = (overrides = {}) => ({
  routeId: 'R-LINE-101',
  version: 'v1',
  kind: 'map',
  fileName: 'R-LINE-101-v1-map.svg',
  bytes: 300,
  hash: 'abc123',
  ...overrides,
});

const sidecar = (overrides = {}) => ({ marker: marker(overrides), downloadedBytes: 128 });

test('决策：本地无分片 → 从头下载', () => {
  const r = decideResume({ sidecar: null, currentMarker: marker(), localBytes: 0 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'NO_LOCAL_PART');
});

test('决策：缺少侧车标记，无法证明分片来源 → 从头下载', () => {
  const r = decideResume({ sidecar: null, currentMarker: marker(), localBytes: 128 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'SIDE_CAR_MISSING');
});

test('决策：站点为弱标记（无哈希），标记不可靠 → 不敢续传，从头下载', () => {
  const weak = marker();
  delete weak.hash;
  const r = decideResume({ sidecar: sidecar(), currentMarker: weak, localBytes: 128 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'CURRENT_MARKER_UNRELIABLE');
});

test('决策：掉线后站点修订了版本，旧分片作废 → 从头下载新版本', () => {
  const r = decideResume({
    sidecar: sidecar({ version: 'v1', hash: 'old-hash' }),
    currentMarker: marker({ version: 'v2', hash: 'new-hash' }),
    localBytes: 128,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'VERSION_REVISED');
});

test('决策：同版本号但内容哈希变化 → 旧分片作废，从头下载', () => {
  const r = decideResume({
    sidecar: sidecar({ hash: 'old-hash' }),
    currentMarker: marker({ hash: 'new-hash' }),
    localBytes: 128,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'CONTENT_HASH_CHANGED');
});

test('决策：文件名变化 → 从头下载', () => {
  const r = decideResume({
    sidecar: sidecar({ fileName: 'old.svg' }),
    currentMarker: marker({ fileName: 'new.svg' }),
    localBytes: 128,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'FILE_NAME_CHANGED');
});

test('决策：分片大于当前文件 → 数据异常，从头下载', () => {
  const r = decideResume({
    sidecar: sidecar(),
    currentMarker: marker({ bytes: 100 }),
    localBytes: 128,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'PART_LARGER_THAN_FILE');
});

test('决策：本地分片哈希核验失败（损坏/被篡改）→ 从头下载', () => {
  const r = decideResume({
    sidecar: sidecar(),
    currentMarker: marker(),
    localBytes: 128,
    localHashVerified: false,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'LOCAL_PART_CORRUPT');
});

test('决策：原版本标记一致且分片有效 → 从断点续传', () => {
  const r = decideResume({
    sidecar: sidecar(),
    currentMarker: marker(),
    localBytes: 128,
    localHashVerified: true,
  });
  assert.equal(r.action, 'resume');
  assert.equal(r.reason, 'OK');
  assert.equal(r.resumeFrom, 128);
});

test('决策：分片恰好完整且哈希一致 → 直接转正', () => {
  const r = decideResume({
    sidecar: sidecar(),
    currentMarker: marker(),
    localBytes: 300,
    localHashVerified: true,
  });
  assert.equal(r.action, 'resume');
  assert.equal(r.reason, 'PART_ALREADY_COMPLETE');
});

test('决策：分片长度等于完整文件但哈希不符 → 从头下载', () => {
  const r = decideResume({
    sidecar: sidecar(),
    currentMarker: marker(),
    localBytes: 300,
    localHashVerified: false,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'COMPLETE_BUT_HASH_MISMATCH');
});
