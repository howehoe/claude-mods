// ダッシュボードの状態計算（副作用のない部分）。テストから直接読み込む。
import path from 'node:path';

export const STALL_MS = 3 * 60 * 1000; // 作業中なのにこの時間動きがなければ「止まっている」
export const ENDED_KEEP_MS = 60 * 60 * 1000; // 終了したセッションを表示し続ける時間
export const INACTIVE_HIDE_MS = 24 * 60 * 60 * 1000; // これより古いセッションは表示しない

/**
 * transcript (jsonl) の本文を読み、人が入力した発言と、Claude の最後の発言（テキスト）を取り出す
 * @returns {{ messages: {text:string, at:string|null}[], lastAssistantText: string|null }}
 */
export function parseTranscript(jsonlText) {
  const messages = [];
  let lastAssistantText = null;
  for (const line of jsonlText.split('\n')) {
    const isUser = line.includes('"type":"user"');
    const isAssistant = line.includes('"type":"assistant"');
    if (!isUser && !isAssistant) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    if (row.type === 'assistant') {
      const text = messageText(row.message?.content);
      if (text) lastAssistantText = text;
      continue;
    }
    if (row.type !== 'user' || row.isMeta) continue;
    if (row.origin && row.origin.kind !== 'human') continue;
    const text = messageText(row.message?.content);
    if (!text) continue;
    // スラッシュコマンドの実行結果などは除く
    if (text.startsWith('<local-command') || text.startsWith('<command-')) continue;
    messages.push({ text, at: row.timestamp ?? null });
    // 人が新しく発言したら、それより前の Claude の発言は「最後の発言」ではない
    lastAssistantText = null;
  }
  return { messages, lastAssistantText };
}

/** transcript (jsonl) の本文から、人が入力した発言だけを取り出す */
export function extractUserMessages(jsonlText) {
  return parseTranscript(jsonlText).messages;
}

// 末尾がこれらで終わっていれば、Claude がこちらに返事・判断を求めているとみなす
const ASKING_PATTERNS = [
  /[?？]/,
  /(ますか|でしょうか|ませんか|どうしますか|いかがですか|よろしいですか)/,
  /(ください|お願いします|教えて|選んで|決めて|確認して)/,
  /(進めてよい|進めていい|してよい|していい)/,
];

/**
 * Claude の最後の発言が、こちらに返事を求めているか
 * 発言全体ではなく末尾（最後の数行）だけを見る。途中の「〜ですか？」の引用などで誤判定しないため。
 */
export function isAskingUser(text) {
  if (!text) return false;
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  // コードブロックの閉じ記号などは除いて、最後の 3 行を見る
  const tail = lines.filter((l) => !/^(```|---|\|)/.test(l)).slice(-3).join('\n');
  return ASKING_PATTERNS.some((re) => re.test(tail));
}

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  // tool_result を含む行はツールの返り値なので人の発言ではない
  if (content.some((c) => c?.type === 'tool_result')) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/** 要約用プロンプト: 最初の 1 件と直近 11 件 */
export function buildSummaryPrompt(messages) {
  const picked = messages.length <= 12 ? messages : [messages[0], ...messages.slice(-11)];
  const body = picked.map((m, i) => `[${i + 1}] ${m.text.slice(0, 800)}`).join('\n\n');
  return [
    '以下は、ある Claude Code セッションでユーザーが送った発言です（最初の1件と直近の発言）。',
    'このセッションが「いま何の作業をしているか」を、日本語で40文字以内の1文にしてください。',
    '前置きや引用符は付けず、その1文だけを出力してください。',
    '',
    body,
  ].join('\n');
}

/**
 * 表示用の状態を決める
 * - waiting: 返事待ち。実行許可・選択肢の質問、または Claude の最後の発言がこちらに何か聞いている
 * - done:    完了。ターンを終えただけで、特に聞かれていない（次の指示待ち）
 * - working: 作業中
 * - stalled: 応答なし。作業中のはずなのに一定時間動きがない（Esc で中断した場合など）
 * - idle:    起動直後など、まだ何もしていない
 * - ended:   セッション終了
 * @returns {'waiting'|'done'|'working'|'stalled'|'idle'|'ended'}
 */
export function displayStatus(state, lastActivityMs, now = Date.now(), lastAssistantText = null) {
  if (state.status === 'ended') return 'ended';
  if (state.status === 'waiting') {
    if (state.waitingReason === 'permission' || state.waitingReason === 'question') return 'waiting';
    if (state.waitingReason === 'idle') return 'idle';
    return isAskingUser(lastAssistantText) ? 'waiting' : 'done';
  }
  if (state.status === 'working') return now - lastActivityMs > STALL_MS ? 'stalled' : 'working';
  return 'idle';
}

/** 一覧に出すかどうか */
export function isVisible(state, now = Date.now()) {
  const last = Date.parse(state.lastEventAt ?? 0);
  if (state.status === 'ended') return now - Date.parse(state.endedAt ?? state.lastEventAt) < ENDED_KEEP_MS;
  return now - last < INACTIVE_HIDE_MS;
}

/**
 * 「閉じてよい」判定: 完了（何も聞かれていない）か待機中で、
 * コミットしていない変更がないこと。終了済みのセッションも閉じてよい。
 */
export function isClosable(status, git) {
  if (status === 'ended') return true;
  if (status !== 'done' && status !== 'idle') return false;
  if (!git) return true; // git 管理外
  return git.dirty === 0;
}

const ORDER = { waiting: 0, stalled: 1, done: 2, working: 3, idle: 4, ended: 5 };

/** 並び順: 返事待ち（古い順）→ 応答なし → 完了 → 作業中 → その他 */
export function sortSessions(list) {
  return [...list].sort((a, b) => {
    const d = ORDER[a.status] - ORDER[b.status];
    if (d !== 0) return d;
    if (a.status === 'waiting' || a.status === 'done') return Date.parse(a.statusSince) - Date.parse(b.statusSince);
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

export function projectName(cwd) {
  if (!cwd) return '(不明)';
  // .claude/worktrees/<name> 配下はリポジトリ名 + worktree 名で表示する
  const m = cwd.match(/([^/]+)\/\.claude\/worktrees\/([^/]+)/);
  if (m) return `${m[1]} / ${m[2]}`;
  return path.basename(cwd);
}

// ---- PR -------------------------------------------------------------------
// PR を作らない（作業の土台になる）ブランチ
const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD']);

export function isTrunkBranch(branch) {
  return TRUNK_BRANCHES.has(branch);
}

/**
 * `gh pr list --json number,url,state,isDraft,title` の出力から、カードに出す PR を取り出す
 * @returns {{number:number, url:string, state:'OPEN'|'DRAFT'|'MERGED'|'CLOSED', title:string} | null}
 */
export function parsePrList(stdout) {
  let list;
  try {
    list = JSON.parse(stdout);
  } catch {
    return null;
  }
  const pr = Array.isArray(list) ? list[0] : null;
  if (!pr?.url) return null;
  const state = pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state;
  return { number: pr.number, url: pr.url, state, title: pr.title ?? '' };
}

/**
 * PR 情報を取り直すまでの間隔
 * まだ PR が無いブランチは、作られたらすぐ出したいので短めに見る。
 * マージ・クローズ済みはもう変わらないので長めにする。
 */
export function prCacheTtl(pr) {
  if (!pr) return 30 * 1000;
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return 10 * 60 * 1000;
  return 2 * 60 * 1000;
}

// ---- チケット（Notion） ----------------------------------------------------------
const NOTION_URL_RE = /https:\/\/(?:www\.)?notion\.(?:so|site)\/[^\s"'<>()（）`\]]+/g;

/** Notion の URL からページ（または DB）の ID を取り出す。ID はパスの末尾の 32 桁の 16 進数 */
export function notionIdFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // DB からページをプレビューで開いた URL（?p=<ページ ID>）はそのページを指す
  const peek = u.searchParams.get('p');
  if (peek && /^[0-9a-f]{32}$/i.test(peek)) return peek.toLowerCase();
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  const m = last.replace(/-/g, '').match(/([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : null;
}

/** 表示用に ?pvs=4 や ?source=copy_link などの付属パラメータを落とす（DB ビューの ?v= は残す） */
export function cleanNotionUrl(url) {
  try {
    const u = new URL(url);
    const keep = new URLSearchParams();
    for (const k of ['v', 'p']) if (u.searchParams.get(k)) keep.set(k, u.searchParams.get(k));
    u.search = keep.toString() ? `?${keep}` : '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 人の発言から Notion の URL を、最初に出てきた順・ページ単位で重複を除いて取り出す
 * @returns {{id:string, url:string}[]}
 */
export function extractTicketUrls(messages, max = 3) {
  const out = [];
  const seen = new Set();
  for (const m of messages) {
    for (const raw of m.text.match(NOTION_URL_RE) ?? []) {
      const url = raw.replace(/[.,、。]+$/, '');
      const id = notionIdFromUrl(url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, url: cleanNotionUrl(url) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Notion API（pages / databases）のレスポンスからタイトルを取り出す */
export function notionTitle(json) {
  const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => t.plain_text ?? '').join('').trim() : '');
  if (json?.object === 'database' || json?.object === 'data_source') return plain(json.title) || null;
  const props = json?.properties ?? {};
  for (const p of Object.values(props)) {
    if (p?.type === 'title') return plain(p.title) || null;
  }
  return null;
}

// ---- 作業メモ・TODO ----------------------------------------------------------
// notes.json の形:
// {
//   todos: [{ id, text, done, createdAt, doneAt, sessionId, project }],  // sessionId が null なら全体の TODO
//   sessionMemos: { [sessionId]: { text, project, updatedAt } },
// }
export const TODO_MAX_LEN = 500;
export const MEMO_MAX_LEN = 20000;
const SESSION_ID_RE = /^[\w-]{1,100}$/;

export function emptyNotes() {
  return { todos: [], sessionMemos: {} };
}

/** ファイルから読んだ値を、欠けた項目を補った形にそろえる */
export function normalizeNotes(raw) {
  const n = emptyNotes();
  if (!raw || typeof raw !== 'object') return n;
  if (Array.isArray(raw.todos)) {
    n.todos = raw.todos
      .filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string')
      .map((t) => ({
        id: t.id,
        text: t.text,
        done: Boolean(t.done),
        createdAt: t.createdAt ?? null,
        doneAt: t.done ? (t.doneAt ?? null) : null,
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : null,
        project: typeof t.project === 'string' ? t.project : null,
      }));
  }
  if (raw.sessionMemos && typeof raw.sessionMemos === 'object') n.sessionMemos = { ...raw.sessionMemos };
  return n;
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * 画面からの操作を notes に当てる（元の notes は書き換えない）
 * @returns {{ notes: object, error: string|null }}
 */
export function applyNoteOp(notes, op, now = new Date().toISOString(), newId = () => Math.random().toString(36).slice(2, 10)) {
  const fail = (error) => ({ notes, error });
  if (!op || typeof op !== 'object') return fail('invalid op');
  const next = { todos: [...notes.todos], sessionMemos: { ...notes.sessionMemos } };
  const project = str(op.project).slice(0, 200) || null;

  switch (op.type) {
    case 'addTodo': {
      const text = str(op.text).trim();
      if (!text || text.length > TODO_MAX_LEN) return fail('invalid text');
      const sessionId = op.sessionId == null ? null : str(op.sessionId);
      if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) return fail('invalid sessionId');
      next.todos.push({ id: newId(), text, done: false, createdAt: now, doneAt: null, sessionId, project: sessionId ? project : null });
      return { notes: next, error: null };
    }
    case 'updateTodo': {
      const i = next.todos.findIndex((t) => t.id === op.id);
      if (i < 0) return fail('not found');
      const t = { ...next.todos[i] };
      if ('done' in op) {
        const done = Boolean(op.done);
        if (done !== t.done) t.doneAt = done ? now : null;
        t.done = done;
      }
      if ('text' in op) {
        const text = str(op.text).trim();
        if (!text || text.length > TODO_MAX_LEN) return fail('invalid text');
        t.text = text;
      }
      next.todos[i] = t;
      return { notes: next, error: null };
    }
    case 'deleteTodo': {
      const before = next.todos.length;
      next.todos = next.todos.filter((t) => t.id !== op.id);
      return next.todos.length === before ? fail('not found') : { notes: next, error: null };
    }
    case 'setSessionMemo': {
      const sessionId = str(op.sessionId);
      if (!SESSION_ID_RE.test(sessionId)) return fail('invalid sessionId');
      const text = str(op.text);
      if (text.length > MEMO_MAX_LEN) return fail('too long');
      if (text.trim()) next.sessionMemos[sessionId] = { text, project, updatedAt: now };
      else delete next.sessionMemos[sessionId];
      return { notes: next, error: null };
    }
    default:
      return fail('unknown op');
  }
}

/**
 * 書き込み API を他のサイトから叩かれないための確認
 * - Host が loopback であること（DNS リバインディング対策）
 * - Origin があるならこのサーバー自身であること
 * - JSON で送られていること（他サイトからは CORS のプリフライトが必要になり、応答しないので送れない）
 */
export function isTrustedWrite(headers, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(headers.host)) return false;
  if (headers.origin && !allowed.has(headers.origin.replace(/^http:\/\//, ''))) return false;
  return /^application\/json\b/i.test(headers['content-type'] ?? '');
}
