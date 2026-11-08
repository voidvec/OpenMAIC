// 阿里云盘交付 sidecar
//
// 职责只有三件：把本地文件传到云盘、给云端路径建分享链接、报健康状态。
// 之所以不做更多（队列 / 重试 / 数据库），是因为这些属于 Next 侧的交付状态机，
// sidecar 一旦有状态，重启就要恢复，反而更难维护。
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve as resolvePath, sep } from 'node:path';

const BIN = '/usr/local/bin/aliyunpan';
const PORT = Number(process.env.DELIVER_PORT || 8099);
const TOKEN = process.env.DELIVER_SIDECAR_TOKEN || '';
const DATA_ROOT = process.env.DELIVER_DATA_ROOT || '/data';
const UPLOAD_TIMEOUT_MS = Number(process.env.DELIVER_UPLOAD_TIMEOUT_MS || 30 * 60 * 1000);
const SHARE_TIMEOUT_MS = Number(process.env.DELIVER_SHARE_TIMEOUT_MS || 3 * 60 * 1000);

const SHARE_URL_RE = /https?:\/\/[^\s"'<>]*alipan\.com\/s\/[A-Za-z0-9-]+/;
const SHARE_PWD_RE = /提取码[：:]\s*([A-Za-z0-9]+)/;
// 秒传和正常上传的结论文案不同，两只都要认：
//   正常上传 → "上传文件成功, 保存到网盘路径: ..."  + "文件上传结果： 成功！"
//   秒传命中 → "秒传成功, 保存到网盘路径: ..."      + "文件上传结果： 成功！"
const UPLOAD_OK_RE = /(文件上传结果|上传文件结果)[：:]\s*成功|上传文件成功|秒传成功/;
const SHARE_FAIL_RE = /分享失败|不支持|只有资源库|分享文件失败/;

/** 调 aliyunpan 子命令。它对 stdout 和 stderr 都用，所以合并后再判断。 */
function run(args, timeoutMs) {
  return new Promise((done) => {
    execFile(
      BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        const killed = Boolean(err && (err.killed || err.signal));
        done({ ok: !err, killed, out });
      },
    );
  });
}

/**
 * 上传大文件时 aliyunpan 会刷几千行进度条（\r 分隔），原样回传会让响应体爆掉，
 * 所以丢掉进度片段只留结论行。
 */
function compact(output) {
  const lines = output
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.filter(
    (line) => !line.includes('B/s') && !line.includes('↑') && !line.includes('↓'),
  );
  const text = (meaningful.length ? meaningful : lines).join('\n');
  return text.length > 2000 ? `…${text.slice(-2000)}` : text;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** 只允许操作 DATA_ROOT 之下的路径，避免 localPath 被用来读取宿主任意文件 */
function assertInsideDataRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('localPath is required');
  const abs = resolvePath(input);
  const root = resolvePath(DATA_ROOT);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`localPath must stay inside ${DATA_ROOT}`);
  }
  return abs;
}

/** 网盘路径必须是绝对路径，且不带尾部斜杠（aliyunpan 对尾部斜杠处理不一致） */
function normalizeCloudPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('cloudPath is required');
  const p = input.trim();
  if (!p.startsWith('/')) throw new Error('cloudPath must be absolute (start with /)');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

async function handleUpload(payload) {
  const localPath = assertInsideDataRoot(payload.localPath);
  const cloudDir = normalizeCloudPath(payload.cloudDir);

  const result = await run(['upload', localPath, cloudDir], UPLOAD_TIMEOUT_MS);
  const succeeded = result.ok && UPLOAD_OK_RE.test(result.out);
  const remotePath = `${cloudDir === '/' ? '' : cloudDir}/${localPath.split(/[\\/]/).pop()}`;

  return succeeded
    ? { ok: true, remotePath, output: compact(result.out) }
    : {
        ok: false,
        reason: result.killed ? 'upload timed out' : 'upload failed',
        remotePath: null,
        output: compact(result.out),
      };
}

async function handleShare(payload) {
  const cloudPath = normalizeCloudPath(payload.cloudPath);
  const mode = String(payload.mode ?? 1);
  const expire = String(payload.expire ?? 0);

  if (mode !== '1' && mode !== '2') {
    // 3 是快传，一条链接只能被一个买家保存，卖课件场景下等同链接失效，所以直接拒绝
    throw new Error('only share mode 1 (private) and 2 (public) are allowed');
  }

  const args = ['share', 'set', '-mode', mode, '-time', expire];
  if (payload.pwd) args.push('-sharePwd', String(payload.pwd));
  args.push(cloudPath);

  const result = await run(args, SHARE_TIMEOUT_MS);
  const url = result.out.match(SHARE_URL_RE)?.[0] ?? null;
  const pwd = result.out.match(SHARE_PWD_RE)?.[1] ?? null;

  if (!url || SHARE_FAIL_RE.test(result.out)) {
    return {
      ok: false,
      reason: SHARE_FAIL_RE.test(result.out)
        ? 'aliyun drive rejected this file type'
        : 'share url not found',
      url: null,
      pwd: null,
      output: compact(result.out),
    };
  }

  return { ok: true, url, pwd, output: compact(result.out) };
}

const routes = {
  'GET /health': async () => {
    const probe = await run(['ls', '/'], 30_000);
    return probe.ok
      ? { ok: true, loggedIn: true }
      : { ok: false, loggedIn: false, output: compact(probe.out) };
  },
  'POST /upload': handleUpload,
  'POST /share': handleShare,
};

const server = createServer(async (req, res) => {
  if (TOKEN && req.headers['x-deliver-token'] !== TOKEN) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  const key = `${req.method} ${new URL(req.url, 'http://localhost').pathname}`;

  if (key === 'GET /health') {
    const body = await routes[key]();
    return json(res, body.ok ? 200 : 503, body);
  }

  const handler = routes[key];
  if (!handler) return json(res, 404, { ok: false, error: 'not found' });

  try {
    const payload = await readJson(req);
    const body = await handler(payload);
    json(res, body.ok ? 200 : 422, body);
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[deliver-sidecar] listening on :${PORT}, data root ${DATA_ROOT}`);
});
