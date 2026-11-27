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
  parseTranscript,
  isClosable,
  extractTicketUrls,
  isTrunkBranch,
  notionTitle,
  isVisible,
  parsePrList,
  prCacheTtl,
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
/** @type {Map<string, {mtimeMs:number,size:number,messages:any[],lastAssistantText:string|null}>} */
const transcriptCache = new Map();
const EMPTY_TRANSCRIPT = { mtimeMs: 0, messages: [], lastAssistantText: null };

function readTranscript(file) {
  if (!file) return EMPTY_TRANSCRIPT;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return EMPTY_TRANSCRIPT;
  }
  const hit = transcriptCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let parsed = { messages: [], lastAssistantText: null };
  try {
    parsed = parseTranscript(fs.readFileSync(file, 'utf8'));
  } catch {
    // 読めなければ空
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, ...parsed };
  transcriptCache.set(file, entry);
  return entry;
}

// ---- git -----------------------------------------------------------------
/** @type {Map<string, {at:number, value:any, pending:boolean}>} */
const gitCache = new Map();

function run(cmd, args, cwd, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout }, (err, stdout) => resolve(err ? null : stdout));
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

// ---- チケット名（Notion API） --------------------------------------------------
// トークンは環境変数か、権限 600 のファイル（$CC_DASHBOARD_DIR/notion-token）で渡す。無ければ URL だけ表示する
const TICKET_FILE = path.join(BASE_DIR, 'tickets.json');
const TICKET_RETRY_MS = 10 * 60 * 1000;

function notionToken() {
  const env = process.env.CC_DASHBOARD_NOTION_TOKEN || process.env.NOTION_TOKEN;
  if (env) return env.trim();
  try {
    return fs.readFileSync(path.join(BASE_DIR, 'notion-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** @type {Record<string, {title:string|null, at:number}>} */
let tickets = {};
try {
  tickets = JSON.parse(fs.readFileSync(TICKET_FILE, 'utf8'));
} catch {
  tickets = {};
}
const ticketPending = new Set();

/**
 * Notion API を curl で呼ぶ。Node の fetch は社内プロキシの証明書を信頼せず失敗する環境があるため、
 * OS の証明書ストアを使う curl に任せる。トークンが ps に出ないよう、ヘッダーは標準入力の設定で渡す。
 * @returns {Promise<{status:number, body:string}|null>}
 */
function curlNotion(apiPath, token) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-s', '-K', '-', '-w', '\n%{http_code}', `https://api.notion.com/v1/${apiPath}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const i = out.lastIndexOf('\n');
      const status = Number(out.slice(i + 1));
      resolve(status ? { status, body: out.slice(0, i) } : null);
    });
    child.stdin.end(
      [`header = "Authorization: Bearer ${token}"`, 'header = "Notion-Version: 2022-06-28"', 'max-time = 10', ''].join('\n'),
    );
  });
}

async function fetchNotionTitle(id, token) {
  // ページで見つからなければ DB として引き直す
  for (const kind of ['pages', 'databases']) {
    const res = await curlNotion(`${kind}/${id}`, token);
    if (!res) return null;
    if (res.status === 200) return notionTitle(JSON.parse(res.body));
    if (res.status !== 404 && res.status !== 400) return null;
  }
  return null;
}

/** チケットの表示用データ。タイトルは取れたものから順に埋まる */
function ticketInfo(list) {
  const token = notionToken();
  return list.map(({ id, url }) => {
    const hit = tickets[id];
    const stale = !hit || (!hit.title && Date.now() - hit.at > TICKET_RETRY_MS);
    if (token && stale && !ticketPending.has(id)) {
      ticketPending.add(id);
      fetchNotionTitle(id, token)
        .catch(() => null)
        .then((title) => {
          tickets[id] = { title, at: Date.now() };
          ticketPending.delete(id);
          try {
            fs.writeFileSync(TICKET_FILE, JSON.stringify(tickets, null, 2));
          } catch {
            // 保存できなくても表示は続ける
          }
        });
    }
    return { url, title: tickets[id]?.title ?? null };
  });
}

// ---- PR（gh CLI） ------------------------------------------------------------
/** @type {Map<string, {at:number, ttl:number, value:any, pending:boolean}>} */
const prCache = new Map();

/** 作業ブランチに紐づく PR を返す。gh が無い・未ログインなら null のまま */
function prInfo(cwd, branch) {
  if (!cwd || !branch || isTrunkBranch(branch)) return null;
  const key = `${cwd}\0${branch}`;
  const hit = prCache.get(key);
  if (!hit || (!hit.pending && Date.now() - hit.at > hit.ttl)) {
    const entry = { at: Date.now(), ttl: hit?.ttl ?? 0, value: hit?.value ?? null, pending: true };
    prCache.set(key, entry);
    run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state,isDraft,title'], cwd, 15000).then(
      (out) => {
        // 取得に失敗したときは前回の値を残す
        if (out !== null) entry.value = parsePrList(out);
        entry.ttl = prCacheTtl(entry.value);
        entry.at = Date.now();
        entry.pending = false;
      },
    );
  }
  return prCache.get(key).value;
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

/** 長い発言の末尾だけを残す */
function tail(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
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
    const status = displayStatus(s, lastActivityMs, now, t.lastAssistantText);
    const git = gitInfo(s.cwd);
    requestSummary(s.sessionId, t.messages);
    const lastMsg = t.messages.at(-1);
    sessions.push({
      sessionId: s.sessionId,
      project: projectName(s.cwd),
      cwd: s.cwd,
      status,
      // 実行許可・質問は札に添える。発言で判定した返事待ちは 'reply'
      waitingReason: status === 'waiting' ? s.waitingReason : null,
      statusSince: s.statusSince,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      startedAt: s.startedAt,
      summary: summaries[s.sessionId]?.text || null,
      lastPrompt: lastMsg ? lastMsg.text.slice(0, 200) : null,
      // 返事待ちのとき、何を聞かれているかを見せるため Claude の最後の発言の末尾を渡す
      lastAssistantTail: status === 'waiting' && t.lastAssistantText ? tail(t.lastAssistantText, 160) : null,
      promptCount: t.messages.length,
      tickets: ticketInfo(extractTicketUrls(t.messages)),
      recentSkills: s.recentSkills ?? [],
      lastTool: s.lastTool ?? null,
      git,
      pr: git ? prInfo(s.cwd, git.branch) : null,
      closable: isClosable(status, git),
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

// 配る静的ファイルはこの一覧に載せたものだけ（パスをそのままファイル名に使うので、一覧外は読まない）
const STATIC_FILES = {
  '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
  '/favicon-32.png': 'image/png',
  '/manifest.webmanifest': 'application/manifest+json',
};

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
  // アイコンとマニフェスト（ブックマーク・アプリとしてインストール用）
  const asset = STATIC_FILES[url.pathname === '/favicon.ico' ? '/favicon-32.png' : url.pathname];
  if (asset) {
    res.writeHead(200, { 'content-type': asset, 'cache-control': 'public, max-age=86400' });
    fs.createReadStream(path.join(HERE, 'public', url.pathname === '/favicon.ico' ? 'favicon-32.png' : url.pathname.slice(1))).pipe(res);
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
