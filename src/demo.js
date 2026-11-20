// 演示编排器：把站点、下载器、装配器串成页面可调用的一组操作，
// 每个写操作都返回「操作前快照 / 操作后快照 / 逐项变化」，作为页面证据。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SimulatedStation, StationGoneError, KIND_MAP, KIND_TABLE, ROUTE_ID } from './station.js';
import { Downloader, TransferInterruptedError } from './downloader.js';
import { Assembler } from './assembler.js';
import { REASON_TEXT } from './resumePolicy.js';

function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix] = Array.isArray(obj) ? JSON.stringify(obj) : obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// 计算两个快照之间的逐项变化
export function diffSnapshots(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes = [];
  for (const key of keys) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) {
      changes.push({ path: key, before: a[key] ?? null, after: b[key] ?? null });
    }
  }
  return changes;
}

export class PointwiseDemo {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.workDir = path.join(dataRoot, 'staging'); // 掉线分片 + 侧车
    this.finalDir = path.join(dataRoot, 'downloads'); // 完整附件
    this.publishDir = path.join(dataRoot, 'published'); // 装配发布
    this.station = new SimulatedStation();
    this.downloader = new Downloader(this.station, this.workDir, this.finalDir);
    this.assembler = new Assembler(this.station, this.finalDir, this.publishDir);
  }

  async reset() {
    await fs.rm(this.dataRoot, { recursive: true, force: true });
    await Promise.all([
      fs.mkdir(this.workDir, { recursive: true }),
      fs.mkdir(this.finalDir, { recursive: true }),
      fs.mkdir(this.publishDir, { recursive: true }),
    ]);
    this.station.reset();
    return this.snapshot();
  }

  async safeEvaluate() {
    try {
      return await this.assembler.evaluate();
    } catch (err) {
      if (err instanceof StationGoneError) {
        return {
          verdict: 'BLOCKED',
          matched: false,
          pair: null,
          checks: [
            {
              ok: false,
              code: 'STATION_GONE',
              message: `站点已撤回附件 ${err.kind}（410 Gone），配套不完整，拒绝装配`,
            },
          ],
        };
      }
      throw err;
    }
  }

  async snapshot() {
    const manifest = this.station.getManifest();
    const [mapState, tableState, evaluation] = await Promise.all([
      this.downloader.inspect(KIND_MAP),
      this.downloader.inspect(KIND_TABLE),
      this.safeEvaluate(),
    ]);

    const normalizeDownload = (s) => ({
      stationGone: s.stationGone,
      partBytes: s.partBytes,
      sidecarVersion: s.sidecar?.marker?.version ?? null,
      sidecarHash: s.sidecar?.marker?.hash ?? null,
      finalFileName: s.finalFileName,
      finalHashOk: s.finalHashOk,
      stationVersion: s.stationMarker?.version ?? null,
      stationBytes: s.stationMarker?.bytes ?? null,
    });

    let published = [];
    try {
      published = (await fs.readdir(this.publishDir)).filter((n) => n.startsWith(`${ROUTE_ID}-`)).sort();
    } catch {
      published = [];
    }

    return {
      station: {
        routeId: manifest.routeId,
        version: manifest.version,
        note: manifest.note,
        markerMode: manifest.markerMode,
        withdrawn: [...this.station.withdrawn].sort(),
      },
      downloads: {
        map: normalizeDownload(mapState),
        table: normalizeDownload(tableState),
      },
      assembly: {
        verdict: evaluation.verdict,
        matched: evaluation.matched,
        pairVersion: evaluation.pair?.version ?? null,
        checks: evaluation.checks,
      },
      published,
    };
  }

  async _runMutation(name, fn) {
    const before = await this.snapshot();
    let report;
    try {
      report = await fn();
    } catch (err) {
      const after = await this.snapshot();
      return {
        ok: false,
        operation: name,
        message: err.message,
        errorCode: err.code ?? 'UNKNOWN',
        report: null,
        before,
        after,
        changes: diffSnapshots(before, after),
      };
    }
    const after = await this.snapshot();
    return {
      ok: true,
      operation: name,
      message: report?.message ?? '操作完成',
      report: report ?? null,
      before,
      after,
      changes: diffSnapshots(before, after),
    };
  }

  // 操作 1：开始采集线路资料（图、表全量下载 + 装配发布）
  collectOnce() {
    return this._runMutation('collect', async () => {
      const downloads = [];
      for (const kind of [KIND_MAP, KIND_TABLE]) {
        const r = await this.downloader.download(kind);
        downloads.push({
          kind,
          version: r.version,
          fileName: r.fileName,
          bytes: r.bytes,
          resumed: r.resumed,
          decision: r.decision,
        });
      }
      const pub = await this.assembler.publish();
      return {
        message: pub.published
          ? `采集完成：图、表均为 ${pub.pair.version}，哈希核验通过，已发布唯一一份成套资料`
          : '采集完成但装配被拦截（详见核验项）',
        downloads,
        publish: {
          published: pub.published,
          pair: pub.pair,
          checks: pub.evaluation.checks,
        },
      };
    });
  }

  // 操作 2：模拟断点后修订（先制造掉线现场，再让站点发布修订版）
  breakAndRevise() {
    return this._runMutation('break-and-revise', async () => {
      // 清掉旧现场，保证演示确定性
      await Promise.all([this.downloader.purge(KIND_MAP), this.downloader.purge(KIND_TABLE)]);
      const interrupted = [];
      for (const kind of [KIND_MAP, KIND_TABLE]) {
        try {
          await this.downloader.download(kind, { failAfterChunks: 2 });
        } catch (err) {
          if (err instanceof TransferInterruptedError) {
            interrupted.push({ kind, downloadedBytes: err.downloadedBytes });
          } else {
            throw err;
          }
        }
      }
      const revision = this.station.reviseTo('v2');
      return {
        message:
          `传输在第 2 个分块后掉线，本地保留 v1 分片与侧车标记；随后站点修订为 ${revision.to}，` +
          `旧分片仍挂在 ${revision.from} 上，恢复时必须先比对版本标记`,
        interrupted,
        revision,
      };
    });
  }

  // 仅制造掉线现场（站点不修订），用于演示同版本下弱标记的不可靠分支
  breakOnly() {
    return this._runMutation('break-only', async () => {
      await Promise.all([this.downloader.purge(KIND_MAP), this.downloader.purge(KIND_TABLE)]);
      const interrupted = [];
      for (const kind of [KIND_MAP, KIND_TABLE]) {
        try {
          await this.downloader.download(kind, { failAfterChunks: 2 });
        } catch (err) {
          if (err instanceof TransferInterruptedError) {
            interrupted.push({ kind, downloadedBytes: err.downloadedBytes });
          } else {
            throw err;
          }
        }
      }
      return {
        message: '传输在第 2 个分块后掉线，本地保留分片与侧车标记；站点未修订，版本号保持不变',
        interrupted,
      };
    });
  }

  // 操作 3：断点重试（手工触发）。forceRestart=true 时忽略分片强制重取
  retryResume({ forceRestart = false } = {}) {
    return this._runMutation('retry-resume', async () => {
      const downloads = [];
      const gone = [];
      for (const kind of [KIND_MAP, KIND_TABLE]) {
        try {
          const r = await this.downloader.download(kind, forceRestart ? { forceRestart: true } : {});
          downloads.push({
            kind,
            version: r.version,
            fileName: r.fileName,
            bytes: r.bytes,
            resumed: r.resumed,
            decision: {
              action: r.decision.action,
              reason: r.decision.reason,
              reasonText: REASON_TEXT[r.decision.reason] ?? r.decision.reason,
            },
          });
        } catch (err) {
          if (err instanceof StationGoneError) {
            gone.push({ kind, code: err.code, message: err.message });
          } else if (err instanceof TransferInterruptedError) {
            throw err;
          } else {
            throw err;
          }
        }
      }
      const pub = await this.assembler.publish();
      const parts = [];
      parts.push(
        forceRestart
          ? '手工强制重取：忽略本地分片，两个附件均从头下载'
          : '断点重试：下载器恢复前先比对原版本标记与站点当前标记',
      );
      if (gone.length) parts.push(`站点撤回：${gone.map((g) => g.kind).join('、')}（410 Gone）`);
      parts.push(
        pub.published
          ? `装配通过，已发布 ${pub.pair.version} 成套资料`
          : '装配被拦截，未发布新版本（保留上一份有效发布）',
      );
      return {
        message: parts.join('；'),
        downloads,
        gone,
        publish: {
          published: pub.published,
          pair: pub.pair,
          checks: pub.evaluation.checks,
        },
      };
    });
  }

  // 操作 4：模拟配套表缺失（站点撤回站点表，并清掉本地表文件）
  simulateMissingTable() {
    return this._runMutation('missing-table', async () => {
      await this.downloader.purge(KIND_TABLE);
      this.station.withdraw(KIND_TABLE);
      return {
        message: '站点撤回了站点表（410 Gone），本地表文件已移除；线路图即使完好，装配器也不得发布配不上的一份',
      };
    });
  }

  // 操作 5：站点恢复站点表后补采并重新装配
  restoreTable() {
    return this._runMutation('restore-table', async () => {
      this.station.restore(KIND_TABLE);
      const r = await this.downloader.download(KIND_TABLE);
      const pub = await this.assembler.publish();
      return {
        message: pub.published
          ? `站点表已恢复并补齐（${r.version}），图、表重新配得上，已发布成套资料`
          : '站点表已恢复，但装配仍未通过（详见核验项）',
        download: { kind: KIND_TABLE, version: r.version, fileName: r.fileName, bytes: r.bytes },
        publish: { published: pub.published, pair: pub.pair, checks: pub.evaluation.checks },
      };
    });
  }

  setMarkerMode(mode) {
    return this._runMutation('marker-mode', async () => {
      const change = this.station.setMarkerMode(mode);
      return {
        message:
          mode === 'strong'
            ? '已切换为强版本标记（含 SHA-256 内容哈希），恢复时可据此判断分片能否续传'
            : '已切换为弱版本标记（仅版本号），恢复时无法证明分片内容可靠，一律从头取',
        change,
      };
    });
  }
}
