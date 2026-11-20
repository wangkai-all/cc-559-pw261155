// 断点恢复决策（纯函数，便于测试）：
// 下载器恢复前，先用「掉线时侧车保存的原版本标记」对比站点当前标记，
// 再结合本地分片实际情况，决定续传旧文件还是从头取新版本。
//
// 返回 { action: 'resume' | 'restart', reason, resumeFrom? }
export function decideResume({ sidecar, currentMarker, localBytes, localHashVerified }) {
  // 本地没有任何分片，谈不上续传
  if (!localBytes || localBytes <= 0) {
    return { action: 'restart', reason: 'NO_LOCAL_PART' };
  }

  // 没有侧车标记 = 无法证明分片来自哪个版本，标记不可靠，从头取
  if (!sidecar || !sidecar.marker) {
    return { action: 'restart', reason: 'SIDE_CAR_MISSING' };
  }

  const oldMarker = sidecar.marker;

  // 站点当前标记本身不可靠（弱标记只有版本号，没有内容哈希），
  // 无法证明旧分片仍与当前内容逐字节一致，按不可靠处理，从头取
  if (!currentMarker || currentMarker.hash === undefined) {
    return { action: 'restart', reason: 'CURRENT_MARKER_UNRELIABLE' };
  }

  // 版本漂移：站点已修订，旧分片属于被替换的旧版本
  if (oldMarker.version !== currentMarker.version) {
    return { action: 'restart', reason: 'VERSION_REVISED' };
  }
  if (oldMarker.fileName !== currentMarker.fileName) {
    return { action: 'restart', reason: 'FILE_NAME_CHANGED' };
  }

  // 同版本但内容哈希变化（标记声称的内容已不是同一份字节）
  if (oldMarker.hash !== undefined && oldMarker.hash !== currentMarker.hash) {
    return { action: 'restart', reason: 'CONTENT_HASH_CHANGED' };
  }

  // 分片长度异常：超出当前文件总长，或已等于总长（应已转正，属残留）
  if (localBytes > currentMarker.bytes) {
    return { action: 'restart', reason: 'PART_LARGER_THAN_FILE' };
  }
  if (localBytes === currentMarker.bytes) {
    // 长度恰好等于完整文件：只有哈希校验通过才能直接转正，否则重取
    if (localHashVerified === true) {
      return { action: 'resume', reason: 'PART_ALREADY_COMPLETE', resumeFrom: localBytes };
    }
    return { action: 'restart', reason: 'COMPLETE_BUT_HASH_MISMATCH' };
  }

  // 本地分片的哈希（对已下载字节计算）与完整文件哈希前缀不一致：分片被篡改/损坏
  if (localHashVerified === false) {
    return { action: 'restart', reason: 'LOCAL_PART_CORRUPT' };
  }

  return { action: 'resume', reason: 'OK', resumeFrom: localBytes };
}

export const REASON_TEXT = {
  NO_LOCAL_PART: '本地没有分片，从头下载',
  SIDE_CAR_MISSING: '缺少侧车版本标记，无法证明分片来源，从头下载',
  CURRENT_MARKER_UNRELIABLE: '站点版本标记不可靠（无内容哈希），不敢续传，从头下载',
  VERSION_REVISED: '站点已修订为新版本，旧分片作废，从头下载新版本',
  FILE_NAME_CHANGED: '附件文件名已变化，从头下载',
  CONTENT_HASH_CHANGED: '同版本号但内容哈希变化，旧分片作废，从头下载',
  PART_LARGER_THAN_FILE: '本地分片大于当前文件，数据异常，从头下载',
  COMPLETE_BUT_HASH_MISMATCH: '分片长度等于完整文件但哈希不符，从头下载',
  LOCAL_PART_CORRUPT: '本地分片哈希校验失败，分片损坏，从头下载',
  OK: '原版本标记一致，从断点续传',
  PART_ALREADY_COMPLETE: '分片实际已完整且哈希一致，直接转正',
};
