#!/usr/bin/env node
// Claude Code のフックから呼ばれ、セッションごとの状態を JSON ファイルに書き出す。
// 書き出し先: $CC_DASHBOARD_DIR/state/<session_id>.json（既定は ~/.claude/session-dashboard）
// どんな失敗でも Claude Code の動作を止めないよう、常に exit 0 で終わる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ダッシュボード自身が要約のために起動した claude -p は記録しない
if (process.env.CC_DASHBOARD_SUMMARIZER === '1') process.exit(0);

const BASE_DIR = process.env.CC_DASHBOARD_DIR || path.join(os.homedir(), '.claude', 'session-dashboard');
const STATE_DIR = path.join(BASE_DIR, 'state');
const MAX_SKILLS = 2;

/** 純粋関数: 直前の状態とフック入力から次の状態を作る */
export function reduce(prev, input, now = new Date().toISOString()) {
  const s = {
    sessionId: input.session_id,
    cwd: input.cwd ?? prev?.cwd ?? null,
    transcriptPath: input.transcript_path ?? prev?.transcriptPath ?? null,
    status: prev?.status ?? 'idle',
    waitingReason: prev?.waitingReason ?? null,
    statusSince: prev?.statusSince ?? now,
    lastEventAt: now,
    lastEvent: input.hook_event_name,
    startedAt: prev?.startedAt ?? now,
    recentSkills: prev?.recentSkills ?? [],
    lastTool: prev?.lastTool ?? null,
    endedAt: prev?.endedAt ?? null,
  };

  const set = (status, reason = null) => {
    if (s.status !== status || s.waitingReason !== reason) s.statusSince = now;
    s.status = status;
    s.waitingReason = reason;
  };

  switch (input.hook_event_name) {
    case 'SessionStart':
      s.endedAt = null;
      // resume / clear / compact 直後はユーザーの入力待ち
      set('waiting', 'idle');
      break;
    case 'UserPromptSubmit':
      set('working');
      break;
    case 'PreToolUse': {
      s.lastTool = input.tool_name ?? null;
      if (input.tool_name === 'Skill' && input.tool_input?.skill) {
        const name = String(input.tool_input.skill);
        s.recentSkills = [name, ...s.recentSkills.filter((x) => x !== name)].slice(0, MAX_SKILLS);
      }
      // 選択肢の質問はユーザーの番
      if (input.tool_name === 'AskUserQuestion') set('waiting', 'question');
      else set('working');
      break;
    }
    case 'PostToolUse':
      set('working');
      break;
    case 'Notification':
      if (input.notification_type === 'permission_prompt') set('waiting', 'permission');
      else if (input.notification_type === 'idle_prompt') {
        // 入力待ちのまま時間が経った通知。作業中扱いのままなら返事待ちに寄せる
        if (s.status !== 'waiting') set('waiting', 'reply');
      } else if (/permission/i.test(input.message ?? '')) set('waiting', 'permission');
      break;
    case 'Stop':
      set('waiting', 'reply');
      break;
    case 'SessionEnd':
      set('ended');
      s.endedAt = now;
      break;
    default:
      break;
  }
  return s;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdin();
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input.session_id || !/^[\w-]+$/.test(input.session_id)) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `${input.session_id}.json`);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 初回
  }
  const next = reduce(prev, input);
  // 途中までしか書かれていないファイルをサーバーが読まないよう、rename で置き換える
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('record.mjs')) {
  try {
    main();
  } catch {
    // 記録の失敗で Claude Code を止めない
  }
  process.exit(0);
}
