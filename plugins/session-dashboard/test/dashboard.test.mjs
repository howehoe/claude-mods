// node --test plugins/session-dashboard/test/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { reduce } from '../bin/record.mjs';
import { displayStatus, extractUserMessages, isClosable, buildSummaryPrompt, projectName } from '../server/lib.mjs';

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
  assert.equal(isClosable('waiting', 'reply', { dirty: 0 }), true);
  assert.equal(isClosable('waiting', 'reply', { dirty: 2 }), false);
  assert.equal(isClosable('waiting', 'permission', { dirty: 0 }), false);
  assert.equal(isClosable('working', null, { dirty: 0 }), false);
  assert.equal(isClosable('ended', null, { dirty: 3 }), true);
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
