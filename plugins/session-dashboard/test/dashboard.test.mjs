// node --test plugins/session-dashboard/test/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { reduce } from '../bin/record.mjs';
import {
  buildSummaryPrompt,
  displayStatus,
  extractUserMessages,
  isAskingUser,
  isClosable,
  parseTranscript,
  projectName,
} from '../server/lib.mjs';

const base = { session_id: 's1', cwd: '/repo', transcript_path: '/t.jsonl' };
const step = (prev, ev, extra = {}) => reduce(prev, { ...base, hook_event_name: ev, ...extra });

test('ターンの流れで状態が遷移する', () => {
  let s = step(null, 'SessionStart');
  assert.equal(s.status, 'waiting');
  s = step(s, 'UserPromptSubmit');
  assert.equal(s.status, 'working');
  s = step(s, 'Notification', { notification_type: 'permission_prompt' });
  assert.deepEqual([s.status, s.waitingReason], ['waiting', 'permission']);
  s = step(s, 'PostToolUse', { tool_name: 'Bash' });
  assert.equal(s.status, 'working');
  s = step(s, 'PreToolUse', { tool_name: 'AskUserQuestion' });
  assert.deepEqual([s.status, s.waitingReason], ['waiting', 'question']);
  s = step(s, 'Stop');
  assert.deepEqual([s.status, s.waitingReason], ['waiting', 'reply']);
  s = step(s, 'SessionEnd');
  assert.equal(s.status, 'ended');
});

test('スキルは新しい順に 2 件まで', () => {
  let s = step(null, 'PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'a' } });
  s = step(s, 'PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'b' } });
  s = step(s, 'PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'a' } });
  s = step(s, 'PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'c' } });
  assert.deepEqual(s.recentSkills, ['c', 'a']);
});

test('statusSince は状態が変わったときだけ更新する', () => {
  const a = reduce(null, { ...base, hook_event_name: 'UserPromptSubmit' }, 't1');
  const b = reduce(a, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }, 't2');
  assert.equal(b.statusSince, 't1');
});

test('作業中で 3 分動きがなければ止まっている', () => {
  const now = Date.now();
  assert.equal(displayStatus({ status: 'working' }, now - 60_000, now), 'working');
  assert.equal(displayStatus({ status: 'working' }, now - 4 * 60_000, now), 'stalled');
});

test('人の発言だけを取り出す', () => {
  const lines = [
    { type: 'user', origin: { kind: 'human' }, message: { content: 'こんにちは' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: [{ type: 'text', text: '配列の発言' }] } },
    { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
    { type: 'assistant', message: { content: 'hi' } },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(
    extractUserMessages(lines.join('\n')).map((m) => m.text),
    ['こんにちは', '配列の発言'],
  );
});

test('閉じてよい判定', () => {
  assert.equal(isClosable('done', { dirty: 0 }), true);
  assert.equal(isClosable('done', { dirty: 2 }), false);
  assert.equal(isClosable('done', null), true);
  assert.equal(isClosable('waiting', { dirty: 0 }), false);
  assert.equal(isClosable('working', { dirty: 0 }), false);
  assert.equal(isClosable('ended', { dirty: 3 }), true);
});

test('ターン終了後: 聞かれていれば返事待ち、そうでなければ指示待ち', () => {
  const now = Date.now();
  const st = (waitingReason) => ({ status: 'waiting', waitingReason });
  assert.equal(displayStatus(st('reply'), now, now, 'PR を作りました。'), 'done');
  assert.equal(displayStatus(st('reply'), now, now, 'どちらで進めますか？'), 'waiting');
  assert.equal(displayStatus(st('reply'), now, now, null), 'done');
  assert.equal(displayStatus(st('permission'), now, now, 'PR を作りました。'), 'waiting');
  assert.equal(displayStatus(st('question'), now, now, null), 'waiting');
  assert.equal(displayStatus(st('idle'), now, now, null), 'idle');
});

test('末尾が質問・依頼なら返事を求めているとみなす', () => {
  assert.equal(isAskingUser('修正しました。\nテストも通っています。'), false);
  assert.equal(isAskingUser('置き場所は A でいいですか？'), true);
  assert.equal(isAskingUser('2 案あります。どちらにするか決めてください'), true);
  assert.equal(isAskingUser('この方針で進めてよいか確認させてください。'), true);
  // 途中の疑問文は見ない
  assert.equal(isAskingUser('「なぜ落ちる？」を調べました。\n原因は A でした。\n修正済みです。\nPR を出しました。'), false);
});

test('Claude の最後の発言は、人がその後に発言したら消える', () => {
  const rows = [
    { type: 'user', origin: { kind: 'human' }, message: { content: '直して' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '直しました。' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
  ];
  const text = (rs) => rs.map((r) => JSON.stringify(r)).join('\n');
  assert.equal(parseTranscript(text(rows)).lastAssistantText, '直しました。');
  rows.push({ type: 'user', origin: { kind: 'human' }, message: { content: '次これ' } });
  assert.equal(parseTranscript(text(rows)).lastAssistantText, null);
});

test('要約プロンプトは最初の 1 件と直近 11 件', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ text: `m${i}` }));
  const p = buildSummaryPrompt(msgs);
  assert.ok(p.includes('m0') && p.includes('m19') && p.includes('m9'));
  assert.ok(!p.includes('m8\n'));
});

test('worktree はリポジトリ名付きで表示', () => {
  assert.equal(projectName('/a/repo/.claude/worktrees/feat-x'), 'repo / feat-x');
  assert.equal(projectName('/a/repo'), 'repo');
});
