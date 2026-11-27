#!/usr/bin/env node
// セッションダッシュボードのローカルサーバー。Node の標準モジュールだけで動く。
//   node server/server.mjs            → http://127.0.0.1:7878
// 環境変数:
//   CC_DASHBOARD_PORT   ポート（既定 7878）
//   CC_DASHBOARD_DIR    状態ファイルの置き場（既定 ~/.claude/session-dashboard）
//   CC_DASHBOARD_NO_SUMMARY=1  Haiku での要約を行わない
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildSummaryPrompt,
  displayStatus,
  extractUserMessages,
  isClosable,
  isVisible,
  projectName,
  sortSessions,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CC_DASHBOARD_PORT || 7878);
const BASE_DIR = process.env.CC_DASHBOARD_DIR || path.join(os.homedir(), '.claude', 'session-dashboard');
const STATE_DIR = path.join(BASE_DIR, 'state');
const SUMMARY_FILE = path.join(BASE_DIR, 'summaries.json');
const SUMMARY_ENABLED = process.env.CC_DASHBOARD_NO_SUMMARY !== '1';
const SUMMARY_MIN_INTERVAL_MS = 60 * 1000;
const GIT_CACHE_MS = 15 * 1000;
const TICK_MS = 2000;

fs.mkdirSync(STATE_DIR, { recursive: true });

// ---- transcript ----------------------------------------------------------
/** @type {Map<string, {mtimeMs:number,size:number,messages:any[]}>} */
const transcriptCache = new Map();

function readTranscript(file) {
  if (!file) return { mtimeMs: 0, messages: [] };
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { mtimeMs: 0, messages: [] };
  }
  const hit = transcriptCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let messages = [];
  try {
    messages = extractUserMessages(fs.readFileSync(file, 'utf8'));
  } catch {
    // 読めなければ空
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, messages };
  transcriptCache.set(file, entry);
  return entry;
}

// ---- git -----------------------------------------------------------------
/** @type {Map<string, {at:number, value:any, pending:boolean}>} */
const gitCache = new Map();

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function gitInfo(cwd) {
  if (!cwd) return null;
  const hit = gitCache.get(cwd);
  if (!hit || (!hit.pending && Date.now() - hit.at > GIT_CACHE_MS)) {
    const entry = { at: Date.now(), value: hit?.value ?? null, pending: true };
    gitCache.set(cwd, entry);
    Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      run('git', ['status', '--porcelain'], cwd),
    ]).then(([branch, status]) => {
      entry.value =
        branch === null ? null : { branch: branch.trim(), dirty: status ? status.split('\n').filter(Boolean).length : 0 };
      entry.at = Date.now();
      entry.pending = false;
    });
  }
  return gitCache.get(cwd).value;
}

// ---- Haiku での要約 ----------------------------------------------------------
/** @type {Record<string, {text:string, count:number, at:number}>} */
let summaries = {};
try {
  summaries = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
} catch {
  summaries = {};
}
const summaryQueue = [];
let summarizing = false;

function requestSummary(sessionId, messages) {
  if (!SUMMARY_ENABLED || messages.length === 0) return;
  const cur = summaries[sessionId];
  if (cur && cur.count === messages.length) return;
  if (cur && Date.now() - cur.at < SUMMARY_MIN_INTERVAL_MS) return;
  if (summaryQueue.some((q) => q.sessionId === sessionId)) return;
  summaryQueue.push({ sessionId, messages });
  pumpSummaries();
}

function pumpSummaries() {
  if (summarizing) return;
  const job = summaryQueue.shift();
  if (!job) return;
  summarizing = true;
  const done = (text) => {
    if (text) {
      summaries[job.sessionId] = { text, count: job.messages.length, at: Date.now() };
      try {
        fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries, null, 2));
      } catch {
        // 保存できなくても表示は続ける
      }
    } else {
      // 失敗時も連打しないよう時刻だけ記録する
      const prev = summaries[job.sessionId];
      summaries[job.sessionId] = { text: prev?.text ?? '', count: prev?.count ?? -1, at: Date.now() };
    }
    summarizing = false;
    pumpSummaries();
  };
  const child = spawn('claude', ['-p', '--model', 'haiku', '--no-session-persistence'], {
    cwd: os.tmpdir(),
    env: { ...process.env, CC_DASHBOARD_SUMMARIZER: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  const timer = setTimeout(() => child.kill(), 90 * 1000);
  child.stdout.on('data', (d) => (out += d));
  child.on('error', () => {
    clearTimeout(timer);
    done(null);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const line = out.trim().split('\n').filter(Boolean).pop();
    done(code === 0 && line ? line.slice(0, 120) : null);
  });
  child.stdin.end(buildSummaryPrompt(job.messages));
}

// ---- スナップショット ------------------------------------------------------------
function readStates() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')));
    } catch {
      // 書き込み途中などは次の周期で読む
    }
  }
  return out;
}

function snapshot() {
  const now = Date.now();
  const sessions = [];
  for (const s of readStates()) {
    if (!isVisible(s, now)) continue;
    const t = readTranscript(s.transcriptPath);
    const lastActivityMs = Math.max(Date.parse(s.lastEventAt) || 0, t.mtimeMs || 0);
    const status = displayStatus(s, lastActivityMs, now);
    const git = gitInfo(s.cwd);
    requestSummary(s.sessionId, t.messages);
    const lastMsg = t.messages.at(-1);
    sessions.push({
      sessionId: s.sessionId,
      project: projectName(s.cwd),
      cwd: s.cwd,
      status,
      waitingReason: status === 'waiting' ? s.waitingReason : null,
      statusSince: s.statusSince,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      startedAt: s.startedAt,
      summary: summaries[s.sessionId]?.text || null,
      lastPrompt: lastMsg ? lastMsg.text.slice(0, 200) : null,
      promptCount: t.messages.length,
      recentSkills: s.recentSkills ?? [],
      lastTool: s.lastTool ?? null,
      git,
      closable: isClosable(status, s.waitingReason, git),
    });
  }
  return { generatedAt: new Date(now).toISOString(), sessions: sortSessions(sessions) };
}

// ---- HTTP / SSE ----------------------------------------------------------
const clients = new Set();
let lastPayload = '';

function broadcast() {
  const snap = snapshot();
  // 生成時刻を除いた内容が変わったときだけ送る
  const key = JSON.stringify(snap.sessions);
  if (key === lastPayload) return;
  lastPayload = key;
  const data = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) res.write(data);
}

const INDEX = path.join(HERE, 'public', 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(INDEX).pipe(res);
    return;
  }
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end('not found');
});

// 状態ファイルの変化はすぐ、時間経過による変化（停止判定・要約完了）は定期的に反映する
let watchTimer = null;
try {
  fs.watch(STATE_DIR, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(broadcast, 150);
  });
} catch {
  // watch が使えなければ定期実行だけ
}
setInterval(broadcast, TICK_MS);
// SSE の接続維持
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25 * 1000);

// 外部から見えないよう loopback のみで待ち受ける
server.listen(PORT, '127.0.0.1', () => {
  console.log(`session-dashboard: http://127.0.0.1:${PORT}`);
  console.log(`  state dir: ${STATE_DIR}`);
  if (!SUMMARY_ENABLED) console.log('  summary: disabled');
});
