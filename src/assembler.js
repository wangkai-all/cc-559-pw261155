// 装配器：只发布「线路图和站点表配得上」的一份。
// 核验条件：
//   1. 两个附件都已完整下载（不能只有图、没有表）
//   2. 图、表内嵌版本一致，且等于站点当前版本（掉线期间修订过的旧件一律拒绝）
//   3. 字节哈希与站点当前清单一致
// 通过后原子写入 published/，并保证该线路在发布目录中只保留最新一份。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KIND_MAP, KIND_TABLE, ROUTE_ID, StationGoneError } from './station.js';

function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 从附件内容中提取内嵌版本（虚构数据里写死的注释/表头）
export function extractEmbeddedVersion(kind, text) {
  if (kind === KIND_MAP) {
    const m = text.match(/version:\s*(v\d+)/);
    return m ? m[1] : null;
  }
  const m = text.match(/^version:\s*(v\d+)/m);
  return m ? m[1] : null;
}

export class Assembler {
  // station 用于取当前版本与权威哈希；finalDir 是下载器完整附件目录；publishDir 是发布目录
  constructor(station, finalDir, publishDir) {
    this.station = station;
    this.finalDir = finalDir;
    this.publishDir = publishDir;
  }

  // 只读评估，不落盘：供页面「查看配套附件状态」和测试使用
  async evaluate() {
    const checks = [];
    const fail = (code, message) => checks.push({ ok: false, code, message });
    const pass = (code, message) => checks.push({ ok: true, code, message });

    const loaded = {};
    let dirEntries = [];
    try {
      dirEntries = await fs.readdir(this.finalDir);
    } catch {
      dirEntries = [];
    }
    for (const kind of [KIND_MAP, KIND_TABLE]) {
      let marker;
      try {
        marker = this.station.getMarker(kind);
      } catch (err) {
        if (err instanceof StationGoneError) {
          fail(
            `${kind.toUpperCase()}_GONE`,
            `${kind === KIND_MAP ? '线路图' : '站点表'}已被站点撤回（410 Gone），配套不完整，拒绝装配`,
          );
          continue;
        }
        throw err;
      }
      let fileName = marker.fileName;
      let buf;
      try {
        buf = await fs.readFile(path.join(this.finalDir, fileName));
      } catch {
        // 当前标记文件名不在本地：再找该线路该类型的历史附件（修订后留下的旧版本件）
        const staleFile = dirEntries
          .filter((name) => name.startsWith(`${ROUTE_ID}-`) && name.includes(`-${kind}.`))
          .sort()
          .pop();
        if (!staleFile) {
          fail(`${kind.toUpperCase()}_MISSING`, `${kind === KIND_MAP ? '线路图' : '站点表'}尚未下载完成（缺少 ${marker.fileName}）`);
          continue;
        }
        fileName = staleFile;
        try {
          buf = await fs.readFile(path.join(this.finalDir, fileName));
        } catch {
          fail(`${kind.toUpperCase()}_MISSING`, `${kind === KIND_MAP ? '线路图' : '站点表'}尚未下载完成（缺少 ${marker.fileName}）`);
          continue;
        }
      }
      const text = buf.toString('utf8');
      const embedded = extractEmbeddedVersion(kind, text);
      loaded[kind] = { marker, fileName, buf, text, embedded };
      pass(`${kind.toUpperCase()}_PRESENT`, `已取得 ${fileName}（${buf.length} 字节）`);

      if (embedded !== marker.version) {
        fail(
          `${kind.toUpperCase()}_STALE`,
          `附件内嵌版本 ${embedded ?? '未知'} 与站点当前版本 ${marker.version} 不一致，属于掉线前的旧版本`,
        );
      } else {
        pass(`${kind.toUpperCase()}_VERSION_CURRENT`, `附件版本 ${embedded} 与站点当前版本一致`);
      }

      const actualHash = hashBuffer(buf);
      if (marker.hash === undefined) {
        // 弱标记：站点不给权威哈希，只能做内嵌版本核验，记录该风险
        checks.push({
          ok: true,
          code: `${kind.toUpperCase()}_HASH_SKIPPED`,
          message: '站点为弱版本标记，无权威哈希可比对（仅完成内嵌版本核验）',
        });
      } else if (actualHash !== marker.hash) {
        fail(`${kind.toUpperCase()}_HASH_BAD`, `哈希与站点清单不一致（期望 ${marker.hash.slice(0, 12)}…）`);
      } else {
        pass(`${kind.toUpperCase()}_HASH_OK`, '内容哈希与站点清单一致');
      }
    }

    let matched = false;
    if (loaded[KIND_MAP] && loaded[KIND_TABLE]) {
      const v1 = loaded[KIND_MAP].embedded;
      const v2 = loaded[KIND_TABLE].embedded;
      if (v1 && v1 === v2) {
        matched = true;
        pass('PAIR_MATCHED', `线路图与站点表同属版本 ${v1}，成套配得上`);
      } else {
        fail('PAIR_MISMATCHED', `图版本 ${v1 ?? '未知'} 与表版本 ${v2 ?? '未知'} 配不上，拒绝装配`);
      }
    } else {
      fail('PAIR_INCOMPLETE', '配套附件不完整，无法装配');
    }

    const verdict = checks.every((c) => c.ok) ? 'READY_TO_PUBLISH' : 'BLOCKED';
    return {
      verdict,
      matched,
      checks,
      pair: matched
        ? {
            routeId: ROUTE_ID,
            version: loaded[KIND_MAP].embedded,
            map: { fileName: loaded[KIND_MAP].fileName, hash: hashBuffer(loaded[KIND_MAP].buf) },
            table: { fileName: loaded[KIND_TABLE].fileName, hash: hashBuffer(loaded[KIND_TABLE].buf) },
          }
        : null,
    };
  }

  // 评估通过才发布；发布目录中该线路只保留一份
  async publish() {
    const evaluation = await this.evaluate();
    if (evaluation.verdict !== 'READY_TO_PUBLISH') {
      return { published: false, evaluation };
    }
    await fs.mkdir(this.publishDir, { recursive: true });

    // 清掉该线路的旧发布件（只保留配得上的一份）
    const entries = await fs.readdir(this.publishDir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${ROUTE_ID}-`))
        .map((name) => fs.rm(path.join(this.publishDir, name), { force: true })),
    );

    const pair = evaluation.pair;
    for (const kind of [KIND_MAP, KIND_TABLE]) {
      const marker = this.station.getMarker(kind);
      const src = path.join(this.finalDir, marker.fileName);
      const tmp = path.join(this.publishDir, `.tmp-${marker.fileName}`);
      const dst = path.join(this.publishDir, marker.fileName);
      await fs.copyFile(src, tmp);
      await fs.rename(tmp, dst); // 同目录 rename 为原子操作
    }
    return { published: true, evaluation, pair };
  }
}
