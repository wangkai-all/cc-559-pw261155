// 本地网页服务器：仅使用 Node.js 内置模块。
// 启动：node server.js（端口取环境变量 PORT，默认 8080，绑定 127.0.0.1）
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PointwiseDemo } from './src/demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_DATA_ROOT = path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const err = new Error('请求体过大');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res, urlPath, baseDir) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(baseDir, decodeURIComponent(rel)));
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const type = MIME[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function createServer(options = {}) {
  const demo = options.demo ?? new PointwiseDemo(options.dataRoot ?? DEFAULT_DATA_ROOT);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    try {
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST' && pathname !== '/api/state') {
          return sendJson(res, 405, { ok: false, message: '仅支持 POST' });
        }

        if (req.method === 'GET' && pathname === '/api/state') {
          return sendJson(res, 200, { ok: true, state: await demo.snapshot(), log: demo.station.getLog() });
        }

        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        let result;
        switch (pathname) {
          case '/api/collect':
            result = await demo.collectOnce();
            break;
          case '/api/break-revise':
            result = await demo.breakAndRevise();
            break;
          case '/api/break-only':
            result = await demo.breakOnly();
            break;
          case '/api/retry':
            result = await demo.retryResume({ forceRestart: body.forceRestart === true });
            break;
          case '/api/missing-table':
            result = await demo.simulateMissingTable();
            break;
          case '/api/restore-table':
            result = await demo.restoreTable();
            break;
          case '/api/marker-mode':
            result = await demo.setMarkerMode(body.mode === 'weak' ? 'weak' : 'strong');
            break;
          case '/api/reset':
            result = { ok: true, operation: 'reset', message: '已重置为空目录初始状态', state: await demo.reset() };
            return sendJson(res, 200, result);
          default:
            return sendJson(res, 404, { ok: false, message: '未知接口' });
        }
        return sendJson(res, result.ok ? 200 : 409, { ...result, log: demo.station.getLog() });
      }

      if (pathname.startsWith('/published/')) {
        return serveStatic(res, pathname.slice('/published'.length), demo.publishDir);
      }

      if (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/styles.css') {
        return serveStatic(res, pathname, PUBLIC_DIR);
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message, errorCode: err.code ?? 'UNKNOWN' });
    }
  });

  return server;
}

async function start() {
  const demo = new PointwiseDemo(DEFAULT_DATA_ROOT);
  await demo.reset(); // 从空目录开始
  const server = createServer({ demo });
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '127.0.0.1', () => {
    console.log(`线路资料断点续传演示已启动: http://127.0.0.1:${port}/`);
    console.log(`数据目录: ${DEFAULT_DATA_ROOT}`);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
