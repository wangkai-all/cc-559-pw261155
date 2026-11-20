// 下载器：从模拟站点分块拉取附件，掉线时保留 .part 分片和 .sidecar 侧车标记；
// 恢复前先校验「原版本标记 vs 站点当前标记」，由 resumePolicy 决定续传或重取。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decideResume, REASON_TEXT } from './resumePolicy.js';
import { StationGoneError, ROUTE_ID } from './station.js';

function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function partPath(workDir, kind) {
  return path.join(workDir, `${kind}.part`);
}

function sidecarPath(workDir, kind) {
  return path.join(workDir, `${kind}.sidecar.json`);
}

async function readSidecar(workDir, kind) {
  try {
    return JSON.parse(await fs.readFile(sidecarPath(workDir, kind), 'utf8'));
  } catch {
    return null;
  }
}

async function readPart(workDir, kind) {
  try {
    return await fs.readFile(partPath(workDir, kind));
  } catch {
    return null;
  }
}

/**
 * 模拟传输掉线：在已下载 failAfterChunks 个分块后抛出
 */
export class TransferInterruptedError extends Error {
  constructor(kind, downloadedBytes) {
    super(`传输中途掉线：${kind} 已下载 ${downloadedBytes} 字节`);
    this.code = 'TRANSFER_INTERRUPTED';
    this.kind = kind;
    this.downloadedBytes = downloadedBytes;
  }
}

export class Downloader {
  // station: SimulatedStation 实例；workDir: 分片工作目录；finalDir: 完整附件落盘目录
  constructor(station, workDir, finalDir) {
    this.station = station;
    this.workDir = workDir;
    this.finalDir = finalDir;
  }

  // 查看某个附件的本地状态（供「查看配套附件状态」页面使用）
  async inspect(kind) {
    const [sidecar, partBuf, dirEntries] = await Promise.all([
      readSidecar(this.workDir, kind),
      readPart(this.workDir, kind),
      fs.readdir(this.finalDir).catch(() => []),
    ]);
    let marker = null;
    let stationGone = false;
    try {
      marker = this.station.getMarker(kind);
    } catch (err) {
      if (err instanceof StationGoneError) stationGone = true;
      else throw err;
    }
    // 完整附件：优先站点当前文件名，其次目录中该类型的历史附件（修订后留作旧件证据）
    let finalFileName = null;
    if (marker && dirEntries.includes(marker.fileName)) {
      finalFileName = marker.fileName;
    } else {
      const historical = dirEntries
        .filter((name) => name.startsWith(`${ROUTE_ID}-`) && name.includes(`-${kind}.`))
        .sort()
        .pop();
      if (historical) finalFileName = historical;
    }
    let finalHashOk = null;
    if (finalFileName) {
      try {
        const buf = await fs.readFile(path.join(this.finalDir, finalFileName));
        if (marker?.hash) finalHashOk = hashBuffer(buf) === marker.hash;
      } catch {
        finalFileName = null;
      }
    }
    return {
      kind,
      stationGone,
      stationMarker: marker,
      sidecar,
      partBytes: partBuf ? partBuf.length : 0,
      partHash: partBuf ? hashBuffer(partBuf) : null,
      finalFileName,
      finalHashOk,
    };
  }

  /**
   * 启动一次下载。
   * options.failAfterChunks: 传数字则模拟掉线（下载该数量分块后中断，保留分片）
   * options.forceRestart: 忽略本地分片，强制从头取
   */
  async download(kind, options = {}) {
    await ensureDir(this.workDir);
    await ensureDir(this.finalDir);
    const trace = [];

    // 1. 先向站点索取当前版本标记（附件若已撤回，这里直接得到 410）
    const currentMarker = this.station.getMarker(kind);
    trace.push({ phase: 'marker', marker: currentMarker });

    // 2. 读取掉线现场
    const [sidecar, partBuf0] = await Promise.all([readSidecar(this.workDir, kind), readPart(this.workDir, kind)]);
    let localBytes = partBuf0 ? partBuf0.length : 0;

    // 3. 对本地分片做哈希核验：强标记下，分片必须与站点当前内容的同长度前缀一致
    let localHashVerified;
    if (partBuf0 && currentMarker.hash) {
      const prefix = this.station.readPrefix(kind, partBuf0.length);
      localHashVerified = partBuf0.length === prefix.length && hashBuffer(partBuf0) === hashBuffer(prefix);
    }

    // 4. 决策：续传旧文件还是从头取新版本
    let decision;
    if (options.forceRestart) {
      decision = { action: 'restart', reason: 'MANUAL_FORCE_RESTART' };
    } else {
      decision = decideResume({
        sidecar,
        currentMarker,
        localBytes,
        localHashVerified,
      });
    }
    trace.push({
      phase: 'decide',
      action: decision.action,
      reason: decision.reason,
      reasonText: REASON_TEXT[decision.reason] || '手工强制重取',
      oldVersion: sidecar?.marker?.version ?? null,
      currentVersion: currentMarker.version,
    });

    // 5. 按决策准备分片缓冲区与写入偏移
    let buffer;
    let startOffset;
    if (decision.action === 'resume' && partBuf0) {
      buffer = Buffer.from(partBuf0);
      startOffset = decision.resumeFrom;
    } else {
      buffer = Buffer.alloc(0);
      startOffset = 0;
    }

    // 6. 分块拉取
    let chunks = 0;
    let interrupted = false;
    while (startOffset < currentMarker.bytes) {
      if (
        options.failAfterChunks !== undefined &&
        options.failAfterChunks !== null &&
        chunks >= options.failAfterChunks
      ) {
        interrupted = true;
        break;
      }
      const { chunk, range } = this.station.fetchChunk(kind, startOffset);
      if (chunk.length === 0) break;
      buffer = Buffer.concat([buffer, chunk]);
      startOffset = range.end + 1;
      chunks += 1;
      trace.push({ phase: 'chunk', start: range.start, end: range.end, total: range.total });
    }

    // 7. 掉线：落盘分片与侧车（保留原版本标记），等待恢复
    if (interrupted) {
      await fs.writeFile(partPath(this.workDir, kind), buffer);
      await fs.writeFile(
        sidecarPath(this.workDir, kind),
        JSON.stringify(
          {
            kind,
            savedAt: new Date().toISOString(),
            marker: currentMarker,
            downloadedBytes: buffer.length,
          },
          null,
          2,
        ),
      );
      throw new TransferInterruptedError(kind, buffer.length);
    }

    // 8. 完整下载后做整体哈希核验，再原子转正
    const finalHash = hashBuffer(buffer);
    if (currentMarker.hash && finalHash !== currentMarker.hash) {
      throw new Error(`哈希校验失败：${kind} 期望 ${currentMarker.hash}，实得 ${finalHash}`);
    }
    const finalFile = path.join(this.finalDir, currentMarker.fileName);
    await fs.writeFile(finalFile, buffer);
    await fs.rm(partPath(this.workDir, kind), { force: true });
    await fs.rm(sidecarPath(this.workDir, kind), { force: true });

    return {
      kind,
      fileName: currentMarker.fileName,
      version: currentMarker.version,
      bytes: buffer.length,
      hash: finalHash,
      resumed: decision.action === 'resume',
      decision,
      trace,
    };
  }

  // 清理某个附件的本地分片/侧车（重置演示用）
  async purge(kind) {
    await Promise.all([
      fs.rm(partPath(this.workDir, kind), { force: true }),
      fs.rm(sidecarPath(this.workDir, kind), { force: true }),
    ]);
  }
}
