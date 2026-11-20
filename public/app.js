// 前端逻辑：调用本地 API，把操作前后的计算结果渲染为证据区与状态面板。
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { map: '线路图', table: '站点表' };

async function callApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await res.json();
  if (!res.ok && payload.ok === undefined) payload.ok = false;
  return payload;
}

function badge(ok, text) {
  const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'info';
  return `<span class="badge ${cls}">${text}</span>`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '<em>null</em>';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderChecks(checks) {
  if (!checks || !checks.length) return '';
  const items = checks
    .map(
      (c) =>
        `<li>${badge(c.ok, c.ok ? '通过' : '拦截')} <code>${escapeHtml(c.code)}</code> — ${escapeHtml(c.message)}</li>`,
    )
    .join('');
  return `<ul class="checks">${items}</ul>`;
}

function renderChanges(changes) {
  if (!changes || !changes.length) return '<p class="placeholder">快照无差异。</p>';
  const rows = changes
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.path)}</td><td class="before">${escapeHtml(JSON.stringify(c.before))}</td>` +
        `<td class="after">${escapeHtml(JSON.stringify(c.after))}</td></tr>`,
    )
    .join('');
  return `
    <div class="section-title">处理前后逐项变化（before → after）</div>
    <table class="changes">
      <thead><tr><th>字段</th><th>操作前</th><th>操作后</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderDownloadDetail(report) {
  if (!report) return '';
  const blocks = [];
  if (report.downloads?.length) {
    const rows = report.downloads
      .map(
        (d) =>
          `<tr><td>${KIND_LABEL[d.kind] ?? d.kind}</td><td>${escapeHtml(d.version)}</td>` +
          `<td>${escapeHtml(d.fileName)}</td><td>${d.bytes}</td>` +
          `<td>${badge(d.resumed, d.resumed ? '断点续传' : '从头下载')}</td>` +
          `<td>${escapeHtml(d.decision?.reasonText ?? d.decision?.reason ?? '')}</td></tr>`,
      )
      .join('');
    blocks.push(`
      <div class="section-title">下载器决策与结果</div>
      <table>
        <thead><tr><th>附件</th><th>版本</th><th>文件</th><th>字节</th><th>方式</th><th>决策原因</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }
  if (report.interrupted?.length) {
    blocks.push(`
      <div class="section-title">掉线现场（保留的分片）</div>
      <table><thead><tr><th>附件</th><th>已下载字节</th></tr></thead><tbody>
      ${report.interrupted.map((i) => `<tr><td>${KIND_LABEL[i.kind] ?? i.kind}</td><td>${i.downloadedBytes}</td></tr>`).join('')}
      </tbody></table>`);
  }
  if (report.revision) {
    blocks.push(
      `<div class="kv"><div><span class="k">站点修订</span><span>${escapeHtml(report.revision.from)} → ${escapeHtml(report.revision.to)}</span></div></div>`,
    );
  }
  if (report.gone?.length) {
    blocks.push(
      `<div class="kv">${report.gone
        .map((g) => `<div><span class="k">站点撤回</span><span class="badge bad">410 Gone</span> ${escapeHtml(g.message)}</div>`)
        .join('')}</div>`,
    );
  }
  if (report.publish) {
    blocks.push(
      `<div class="section-title">装配器核验</div>
       <div class="kv"><div><span class="k">是否发布</span>${badge(report.publish.published, report.publish.published ? '已发布唯一一份' : '拒绝发布')}</div>` +
        (report.publish.pair
          ? `<div><span class="k">成套版本</span><span>${escapeHtml(report.publish.pair.version)}</span></div>`
          : '') +
        `</div>${renderChecks(report.publish.checks)}`,
    );
  }
  if (report.change) {
    blocks.push(
      `<div class="kv"><div><span class="k">标记模式</span><span>${escapeHtml(report.change.from)} → ${escapeHtml(report.change.to)}</span></div></div>`,
    );
  }
  if (report.download) {
    blocks.push(
      `<div class="kv"><div><span class="k">补齐附件</span><span>${escapeHtml(report.download.fileName)}（${report.download.bytes} 字节，${escapeHtml(report.download.version)}）</span></div></div>`,
    );
  }
  return blocks.join('');
}

// 写入 data-evidence-* 供自动化核对，并渲染人类可读证据
function renderEvidence(result) {
  const el = $('evidence');
  const after = result.after ?? result.state ?? null;
  const compact = after
    ? [
        `op=${result.operation ?? 'snapshot'}`,
        `station=${after.station.version}/${after.station.markerMode}`,
        `mapPart=${after.downloads.map.partBytes}`,
        `mapFinal=${after.downloads.map.finalFileName ?? '-'}`,
        `tablePart=${after.downloads.table.partBytes}`,
        `tableFinal=${after.downloads.table.finalFileName ?? '-'}`,
        `verdict=${after.assembly.verdict}`,
        `matched=${after.assembly.matched}`,
        `published=${after.published.length ? after.published.join(',') : '-'}`,
      ].join('|')
    : `op=${result.operation ?? 'unknown'}|no-state`;

  el.setAttribute('data-evidence-result', compact);
  el.setAttribute('data-evidence-operation', result.operation ?? '');
  el.setAttribute('data-evidence-verdict', after?.assembly.verdict ?? '');
  el.setAttribute('data-evidence-published', after?.published?.join(',') ?? '');

  const errorCls = result.ok === false ? ' error' : '';
  el.innerHTML = `
    <div class="message${errorCls}">
      <strong>${escapeHtml(result.operation ?? '状态查询')}：</strong>${escapeHtml(result.message ?? '')}
      ${result.errorCode ? ` <span class="badge bad">${escapeHtml(result.errorCode)}</span>` : ''}
    </div>
    ${renderDownloadDetail(result.report)}
    ${result.before ? renderChanges(result.changes) : ''}`;
}

function renderStatus(state) {
  const panel = $('status-panel');
  const card = (title, d) => `
    <div class="mini-card">
      <h3>${title}</h3>
      <div class="kv">
        <div><span class="k">站点当前版本</span><span>${escapeHtml(d.stationVersion ?? '-')} ${d.stationGone ? badge(false, '已撤回 410') : ''}</span></div>
        <div><span class="k">站点文件大小</span><span>${d.stationBytes ?? '-'} 字节</span></div>
        <div><span class="k">本地分片</span><span>${d.partBytes} 字节 ${d.sidecarVersion ? `（侧车标记：${escapeHtml(d.sidecarVersion)}）` : '（无侧车）'}</span></div>
        <div><span class="k">完整附件</span><span>${d.finalFileName ? escapeHtml(d.finalFileName) : '—'}</span></div>
        <div><span class="k">完整件哈希</span><span>${d.finalHashOk === null ? '—' : badge(d.finalHashOk, d.finalHashOk ? '与站点一致' : '不一致')}</span></div>
        <div><span class="k">侧车哈希</span><code>${escapeHtml(d.sidecarHash ?? '-')}</code></div>
      </div>
    </div>`;

  panel.innerHTML = `
    <div class="grid-2">
      <div class="mini-card">
        <h3>站点发布信息</h3>
        <div class="kv">
          <div><span class="k">线路</span><span>${escapeHtml(state.station.routeId)}</span></div>
          <div><span class="k">当前版本</span><strong>${escapeHtml(state.station.version)}</strong></div>
          <div><span class="k">版本标记</span>${badge(state.station.markerMode === 'strong', state.station.markerMode === 'strong' ? '强（含哈希）' : '弱（仅版本号）')}</div>
          <div><span class="k">撤回附件</span><span>${state.station.withdrawn.length ? state.station.withdrawn.join('、') : '无'}</span></div>
          <div><span class="k">修订说明</span><span>${escapeHtml(state.station.note)}</span></div>
        </div>
      </div>
      ${card('线路图（SVG）', state.downloads.map)}
      ${card('站点表（CSV）', state.downloads.table)}
    </div>
    <div class="section-title">装配器结论</div>
    <div class="kv">
      <div><span class="k">结论</span>${badge(state.assembly.verdict === 'READY_TO_PUBLISH', state.assembly.verdict)}
        <span style="margin-left:8px">${badge(state.assembly.matched, state.assembly.matched ? '图/表配得上' : '图/表配不上')}</span></div>
      <div><span class="k">成套版本</span><span>${escapeHtml(state.assembly.pairVersion ?? '—')}</span></div>
      <div><span class="k">已发布文件</span><span>${state.published.length ? state.published.map(escapeHtml).join('、') : '发布目录为空'}</span></div>
    </div>
    ${renderChecks(state.assembly.checks)}`;
}

function renderLog(log) {
  $('event-log').innerHTML = log
    .slice()
    .reverse()
    .map((e) => {
      const detail = Object.entries(e)
        .filter(([k]) => !['at', 'event'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return `<li><span class="time">${escapeHtml(e.at.slice(11, 19))}</span><strong>${escapeHtml(e.event)}</strong> ${escapeHtml(detail)}</li>`;
    })
    .join('');
}

async function refreshState() {
  const res = await fetch('/api/state');
  const payload = await res.json();
  renderStatus(payload.state);
  renderLog(payload.log);
  return payload;
}

async function runButton(btn, path, body) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const result = await callApi(path, body);
    renderEvidence(result);
    await refreshState();
  } catch (err) {
    renderEvidence({ ok: false, operation: path, message: err.message, errorCode: 'FETCH_FAILED' });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('btn-collect').addEventListener('click', (e) => runButton(e.target, '/api/collect'));
$('btn-break').addEventListener('click', (e) => runButton(e.target, '/api/break-revise'));
$('btn-break-only').addEventListener('click', (e) => runButton(e.target, '/api/break-only'));
$('btn-status').addEventListener('click', async () => {
  const payload = await refreshState();
  renderEvidence({ ok: true, operation: 'status', message: '已按当前磁盘与站点状态重新计算配套附件状态', after: payload.state });
});
$('btn-retry').addEventListener('click', (e) => runButton(e.target, '/api/retry', { forceRestart: false }));
$('btn-retry-force').addEventListener('click', (e) => runButton(e.target, '/api/retry', { forceRestart: true }));
$('btn-missing').addEventListener('click', (e) => runButton(e.target, '/api/missing-table'));
$('btn-restore').addEventListener('click', (e) => runButton(e.target, '/api/restore-table'));
$('btn-mode-strong').addEventListener('click', (e) => runButton(e.target, '/api/marker-mode', { mode: 'strong' }));
$('btn-mode-weak').addEventListener('click', (e) => runButton(e.target, '/api/marker-mode', { mode: 'weak' }));
$('btn-reset').addEventListener('click', async (e) => {
  await runButton(e.target, '/api/reset');
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.id === 'btn-mode-strong'));
});

refreshState().then((payload) => {
  renderEvidence({ ok: true, operation: 'init', message: '空目录初始状态：站点发布 v1，强版本标记，本地无任何分片', after: payload.state });
});
