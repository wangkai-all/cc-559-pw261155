// 模拟「本地公开数据站」：发布同一线路的线路图（SVG）与站点表（CSV），
// 两者同属一个发布版本，互相引用。站点支持：
//   1. 分块提供附件（供下载器模拟传输中途掉线）
//   2. 修订：旧版本被新版本整体替换（图、表、哈希全部变化）
//   3. 撤回某个附件（演示配套表缺失）
//   4. 版本标记在「强（含内容哈希）/弱（仅版本号）」之间切换
import { createHash } from 'node:crypto';

export const ROUTE_ID = 'R-LINE-101';
export const KIND_MAP = 'map';
export const KIND_TABLE = 'table';

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 虚构线路的两个版本：v1 为初版，v2 为掉线期间站点做出的修订
const V1_STOPS = [
  ['S01', '云栖湾', '0', '60'],
  ['S02', '梧桐里', '90', '60'],
  ['S03', '青石巷', '180', '60'],
  ['S04', '滨河公园', '270', '60'],
  ['S05', '老城门', '360', '60'],
];

const V2_STOPS = [
  ['S01', '云栖湾', '0', '60'],
  ['S02', '梧桐里', '90', '60'],
  ['S03', '青石巷', '180', '60'],
  ['S04', '滨河公园', '270', '60'],
  // 修订：施工绕行，新增两个站，老城门位置后移
  ['S041', '滨河东路', '320', '60'],
  ['S042', '施工绕行口', '370', '90'],
  ['S05', '老城门', '430', '110'],
];

function renderTable(version, stops) {
  const lines = [
    '# route-stop-table',
    `route: ${ROUTE_ID}`,
    `version: ${version}`,
    'stop_id,name,x,y',
    ...stops.map(([id, name, x, y]) => `${id},${name},${x},${y}`),
    '',
  ];
  return lines.join('\n');
}

function renderMap(version, stops) {
  const width = 520;
  const height = 200;
  const margin = 40;
  const points = stops.map(([, , x, y]) => `${margin + Number(x)},${margin + Number(y)}`);
  const polyline = points.join(' ');
  const circles = stops
    .map(([id, , x, y]) => {
      const cx = margin + Number(x);
      const cy = margin + Number(y);
      return `    <circle cx="${cx}" cy="${cy}" r="5" class="stop"/><text x="${cx + 7}" y="${cy - 7}" class="label">${id}</text>`;
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- route-map',
    `route: ${ROUTE_ID}`,
    `version: ${version}`,
    '-->',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <title>${ROUTE_ID} 线路图 ${version}</title>`,
    '  <rect width="100%" height="100%" fill="#f8fafc"/>',
    `  <polyline points="${polyline}" fill="none" stroke="#2563eb" stroke-width="3"/>`,
    circles,
    '</svg>',
    '',
  ].join('\n');
}

function buildRelease(version, stops, note) {
  const mapText = renderMap(version, stops);
  const tableText = renderTable(version, stops);
  const mapHash = sha256Text(mapText);
  const tableHash = sha256Text(tableText);
  return {
    routeId: ROUTE_ID,
    version,
    note,
    attachments: {
      [KIND_MAP]: {
        kind: KIND_MAP,
        fileName: `${ROUTE_ID}-${version}-map.svg`,
        contentType: 'image/svg+xml',
        bytes: Buffer.byteLength(mapText, 'utf8'),
        hash: mapHash,
        text: mapText,
      },
      [KIND_TABLE]: {
        kind: KIND_TABLE,
        fileName: `${ROUTE_ID}-${version}-table.csv`,
        contentType: 'text/csv',
        bytes: Buffer.byteLength(tableText, 'utf8'),
        hash: tableHash,
        text: tableText,
      },
    },
  };
}

/**
 * 站点侧错误：附件已被撤回/不存在（HTTP 语义上接近 410 Gone）
 */
export class StationGoneError extends Error {
  constructor(kind) {
    super(`站点附件 ${kind} 已被撤回（410 Gone）`);
    this.code = 'STATION_GONE';
    this.kind = kind;
  }
}

export class SimulatedStation {
  constructor() {
    this.releases = {
      v1: buildRelease('v1', V1_STOPS, '初版发布'),
      v2: buildRelease('v2', V2_STOPS, '施工绕行修订：新增滨河东路、施工绕行口两站，老城门移位'),
    };
    this.currentVersion = 'v1';
    // strong：标记携带内容哈希，可据此判断旧分片是否仍属于当前版本
    // weak  ：标记只有版本号，无法证明分片内容未被悄悄替换，恢复时必须从头取
    this.markerMode = 'strong';
    // 被撤回的附件 kind 集合（仅影响当前版本的对外可见性）
    this.withdrawn = new Set();
    this.eventLog = [];
    this._log('station-init', { version: 'v1', markerMode: 'strong' });
  }

  _log(event, detail = {}) {
    this.eventLog.push({ at: new Date().toISOString(), event, ...detail });
  }

  getLog() {
    return this.eventLog.slice();
  }

  getManifest() {
    const release = this.releases[this.currentVersion];
    const attachments = {};
    for (const [kind, att] of Object.entries(release.attachments)) {
      attachments[kind] = {
        kind: att.kind,
        fileName: att.fileName,
        contentType: att.contentType,
        bytes: att.bytes,
      };
    }
    return {
      routeId: release.routeId,
      version: release.version,
      note: release.note,
      markerMode: this.markerMode,
      attachments,
    };
  }

  // 下载器在建立/恢复连接前索取的「版本标记」
  getMarker(kind) {
    if (this.withdrawn.has(kind)) throw new StationGoneError(kind);
    const release = this.releases[this.currentVersion];
    const att = release.attachments[kind];
    if (!att) throw new StationGoneError(kind);
    const marker = {
      routeId: release.routeId,
      version: release.version,
      kind,
      fileName: att.fileName,
      bytes: att.bytes,
    };
    if (this.markerMode === 'strong') marker.hash = att.hash;
    return marker;
  }

  // 分块读取，start 为字节偏移；返回 { chunk, range }
  fetchChunk(kind, start) {
    if (this.withdrawn.has(kind)) throw new StationGoneError(kind);
    const att = this.releases[this.currentVersion].attachments[kind];
    if (!att) throw new StationGoneError(kind);
    if (start >= att.bytes) {
      return { chunk: Buffer.alloc(0), range: { start, end: att.bytes - 1, total: att.bytes } };
    }
    const end = Math.min(start + SimulatedStation.CHUNK_SIZE, att.bytes);
    const chunk = Buffer.from(att.text, 'utf8').subarray(start, end);
    this._log('station-serve-chunk', { kind, start, end: end - 1, total: att.bytes });
    return { chunk, range: { start, end: end - 1, total: att.bytes } };
  }

  // 取当前附件完整内容的前 length 字节，用于核验本地分片是否与站点内容前缀一致
  readPrefix(kind, length) {
    if (this.withdrawn.has(kind)) throw new StationGoneError(kind);
    const att = this.releases[this.currentVersion].attachments[kind];
    return Buffer.from(att.text, 'utf8').subarray(0, Math.min(length, att.bytes));
  }

  // 装配器核验用：按 kind 给出当前版本的权威哈希
  expectedHash(kind) {
    if (this.withdrawn.has(kind)) throw new StationGoneError(kind);
    return this.releases[this.currentVersion].attachments[kind].hash;
  }

  // —— 以下为演示控制（模拟站点管理员的行为）——

  // 传输掉线后，站点把线路资料修订为新版本（旧版本整体下线）
  reviseTo(version) {
    if (!this.releases[version]) throw new Error(`未知版本 ${version}`);
    const from = this.currentVersion;
    this.currentVersion = version;
    this.withdrawn.clear();
    this._log('station-revised', { from, to: version });
    return { from, to: version };
  }

  // 撤回当前版本的某个附件（演示配套表缺失）
  withdraw(kind) {
    this.withdrawn.add(kind);
    this._log('station-withdraw', { kind, version: this.currentVersion });
  }

  restore(kind) {
    this.withdrawn.delete(kind);
    this._log('station-restore', { kind, version: this.currentVersion });
  }

  setMarkerMode(mode) {
    if (!['strong', 'weak'].includes(mode)) throw new Error('markerMode 仅支持 strong/weak');
    const from = this.markerMode;
    this.markerMode = mode;
    this._log('station-marker-mode', { from, to: mode });
    return { from, to: mode };
  }

  reset() {
    this.currentVersion = 'v1';
    this.markerMode = 'strong';
    this.withdrawn.clear();
    this.eventLog = [];
    this._log('station-init', { version: 'v1', markerMode: 'strong' });
  }
}

SimulatedStation.CHUNK_SIZE = 64;
