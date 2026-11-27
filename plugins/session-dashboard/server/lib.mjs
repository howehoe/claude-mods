// ダッシュボードの状態計算（副作用のない部分）。テストから直接読み込む。
import path from 'node:path';

export const STALL_MS = 3 * 60 * 1000; // 作業中なのにこの時間動きがなければ「止まっている」
export const ENDED_KEEP_MS = 60 * 60 * 1000; // 終了したセッションを表示し続ける時間
export const INACTIVE_HIDE_MS = 24 * 60 * 60 * 1000; // これより古いセッションは表示しない

/** transcript (jsonl) の本文から、人が入力した発言だけを取り出す */
export function extractUserMessages(jsonlText) {
  const out = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'user' || row.isMeta || row.isSidechain) continue;
    if (row.origin && row.origin.kind !== 'human') continue;
    const text = messageText(row.message?.content);
    if (!text) continue;
    // スラッシュコマンドの実行結果などは除く
    if (text.startsWith('<local-command') || text.startsWith('<command-')) continue;
    out.push({ text, at: row.timestamp ?? null, gitBranch: row.gitBranch ?? null });
  }
  return out;
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
 * @returns {'waiting'|'working'|'stalled'|'idle'|'ended'}
 */
export function displayStatus(state, lastActivityMs, now = Date.now()) {
  if (state.status === 'ended') return 'ended';
  if (state.status === 'waiting') return 'waiting';
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
 * 「閉じてよい」判定: ターンを終えて返事待ち（許可や質問の途中ではない）で、
 * コミットしていない変更がないこと。終了済みのセッションも閉じてよい。
 */
export function isClosable(status, waitingReason, git) {
  if (status === 'ended') return true;
  if (status !== 'waiting' || !['reply', 'idle'].includes(waitingReason)) return false;
  if (!git) return true; // git 管理外
  return git.dirty === 0;
}

const ORDER = { waiting: 0, stalled: 1, working: 2, idle: 3, ended: 4 };

/** 並び順: 返事待ち（古い順）→ 停止 → 作業中 → その他 */
export function sortSessions(list) {
  return [...list].sort((a, b) => {
    const d = ORDER[a.status] - ORDER[b.status];
    if (d !== 0) return d;
    if (a.status === 'waiting') return Date.parse(a.statusSince) - Date.parse(b.statusSince);
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
