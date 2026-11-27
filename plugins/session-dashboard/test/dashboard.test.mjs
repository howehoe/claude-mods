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
  parsePrList,
  parseTranscript,
  prCacheTtl,
  isTrunkBranch,
  extractTicketUrls,
  notionIdFromUrl,
  notionTitle,
  projectName,
  applyNoteOp,
  emptyNotes,
  isTrustedWrite,
  normalizeNotes,
  TODO_MAX_LEN,
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

test('gh pr list の出力から PR を取り出す', () => {
  const out = (o) => JSON.stringify([{ number: 6, url: 'https://github.com/a/b/pull/6', state: 'OPEN', isDraft: false, title: 't', ...o }]);
  assert.deepEqual(parsePrList(out()), { number: 6, url: 'https://github.com/a/b/pull/6', state: 'OPEN', title: 't' });
  assert.equal(parsePrList(out({ isDraft: true })).state, 'DRAFT');
  assert.equal(parsePrList(out({ state: 'MERGED' })).state, 'MERGED');
  assert.equal(parsePrList('[]'), null);
  assert.equal(parsePrList('not json'), null);
});

test('PR が無いブランチは短い間隔で見直す', () => {
  assert.ok(prCacheTtl(null) < prCacheTtl({ state: 'OPEN' }));
  assert.ok(prCacheTtl({ state: 'OPEN' }) < prCacheTtl({ state: 'MERGED' }));
});

test('main / develop では PR を探さない', () => {
  assert.equal(isTrunkBranch('develop'), true);
  assert.equal(isTrunkBranch('feature/x'), false);
});

test('Notion の URL から ID を取り出す', () => {
  const id = '2cbd89fdd946802eac3adcad8ea389a6';
  assert.equal(notionIdFromUrl(`https://www.notion.so/asuene/DB-${id}?source=copy_link`), id);
  assert.equal(notionIdFromUrl(`https://www.notion.so/${id}`), id);
  assert.equal(notionIdFromUrl('https://www.notion.so/asuene/2cbd89fd-d946-802e-ac3a-dcad8ea389a6'), id);
  assert.equal(notionIdFromUrl(`https://www.notion.so/asuene/aaaabbbbccccddddeeeeffff00001111?v=1&p=${id}`), id);
  assert.equal(notionIdFromUrl('https://www.notion.so/asuene'), null);
});

test('発言からチケット URL を重複なしで取り出す', () => {
  const id1 = 'a6e15f1772a34bf886d5bdd73442de36';
  const id2 = '5f59b155f22546a0a86480543edc6079';
  const msgs = [
    { text: `これやって https://www.notion.so/asuene/QA-${id2}?pvs=4。` },
    { text: `https://www.notion.so/asuene/${id1}（参考）と https://www.notion.so/asuene/QA-${id2}?source=copy_link` },
  ];
  assert.deepEqual(extractTicketUrls(msgs), [
    { id: id2, url: `https://www.notion.so/asuene/QA-${id2}` },
    { id: id1, url: `https://www.notion.so/asuene/${id1}` },
  ]);
});

test('Notion API のレスポンスからタイトルを取り出す', () => {
  const page = { object: 'page', properties: { 状態: { type: 'status' }, 名前: { type: 'title', title: [{ plain_text: '【UX】' }, { plain_text: 'ボタン修正' }] } } };
  assert.equal(notionTitle(page), '【UX】ボタン修正');
  assert.equal(notionTitle({ object: 'database', title: [{ plain_text: '開発チケット' }] }), '開発チケット');
  assert.equal(notionTitle({ object: 'page', properties: {} }), null);
});

// ---- 作業メモ・TODO ----
const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

test('TODO の追加・完了・編集・削除', () => {
  const newId = ids();
  let r = applyNoteOp(emptyNotes(), { type: 'addTodo', text: ' 全体のやること ', project: 'x' }, 't1', newId);
  assert.equal(r.error, null);
  // 全体の TODO には作業名を付けない
  assert.deepEqual(r.notes.todos[0], { id: 'id1', text: '全体のやること', done: false, createdAt: 't1', doneAt: null, sessionId: null, project: null });
  r = applyNoteOp(r.notes, { type: 'addTodo', text: 'セッションの', sessionId: 'abc-1', project: 'repo' }, 't2', newId);
  assert.deepEqual([r.notes.todos[1].sessionId, r.notes.todos[1].project], ['abc-1', 'repo']);

  r = applyNoteOp(r.notes, { type: 'updateTodo', id: 'id1', done: true }, 't3');
  assert.deepEqual([r.notes.todos[0].done, r.notes.todos[0].doneAt], [true, 't3']);
  // 完了のまま送り直しても完了時刻は変えない
  r = applyNoteOp(r.notes, { type: 'updateTodo', id: 'id1', done: true }, 't4');
  assert.equal(r.notes.todos[0].doneAt, 't3');
  r = applyNoteOp(r.notes, { type: 'updateTodo', id: 'id1', done: false, text: '直した' }, 't5');
  assert.deepEqual([r.notes.todos[0].done, r.notes.todos[0].doneAt, r.notes.todos[0].text], [false, null, '直した']);

  r = applyNoteOp(r.notes, { type: 'deleteTodo', id: 'id1' });
  assert.deepEqual(r.notes.todos.map((t) => t.id), ['id2']);
  assert.equal(applyNoteOp(r.notes, { type: 'deleteTodo', id: 'id1' }).error, 'not found');
});

test('不正な TODO 操作は元の notes を変えずにエラーを返す', () => {
  const notes = emptyNotes();
  for (const op of [
    null,
    { type: 'nope' },
    { type: 'addTodo', text: '   ' },
    { type: 'addTodo', text: 'a'.repeat(TODO_MAX_LEN + 1) },
    { type: 'addTodo', text: 'a', sessionId: '../etc' },
    { type: 'updateTodo', id: 'missing', done: true },
  ]) {
    const r = applyNoteOp(notes, op);
    assert.ok(r.error, JSON.stringify(op));
    assert.equal(r.notes, notes);
  }
  assert.deepEqual(notes, emptyNotes());
});

test('セッションのメモ（空にすると消える）', () => {
  let r = applyNoteOp(emptyNotes(), { type: 'setSessionMemo', sessionId: 's1', project: 'repo', text: 'メモ' }, 't1');
  assert.deepEqual(r.notes.sessionMemos.s1, { text: 'メモ', project: 'repo', updatedAt: 't1' });
  r = applyNoteOp(r.notes, { type: 'setSessionMemo', sessionId: 's1', text: '  ' });
  assert.deepEqual(r.notes.sessionMemos, {});
  assert.equal(applyNoteOp(r.notes, { type: 'setSessionMemo', sessionId: '../x', text: 'a' }).error, 'invalid sessionId');
});

test('notes.json の読み込みで欠けた項目を補う', () => {
  assert.deepEqual(normalizeNotes(null), emptyNotes());
  assert.deepEqual(normalizeNotes('壊れた値'), emptyNotes());
  const n = normalizeNotes({ todos: [{ id: 'a', text: 't', done: 0, doneAt: 'x' }, { text: 'id なし' }], sessionMemos: { s1: { text: 'm' } } });
  assert.deepEqual(n.todos, [{ id: 'a', text: 't', done: false, createdAt: null, doneAt: null, sessionId: null, project: null }]);
  assert.equal(n.sessionMemos.s1.text, 'm');
});

test('書き込みはこのサーバー自身からの JSON だけ受け付ける', () => {
  const ok = { host: '127.0.0.1:7878', origin: 'http://127.0.0.1:7878', 'content-type': 'application/json' };
  assert.equal(isTrustedWrite(ok, 7878), true);
  assert.equal(isTrustedWrite({ ...ok, origin: undefined }, 7878), true);
  assert.equal(isTrustedWrite({ ...ok, host: 'localhost:7878', origin: 'http://localhost:7878' }, 7878), true);
  assert.equal(isTrustedWrite({ ...ok, origin: 'https://evil.example' }, 7878), false);
  assert.equal(isTrustedWrite({ ...ok, host: 'evil.example:7878' }, 7878), false);
  assert.equal(isTrustedWrite({ ...ok, 'content-type': 'text/plain' }, 7878), false);
});
