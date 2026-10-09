import { expect, test } from 'claude-code/testing'

import { clean, parse, serialize } from './memo'

test('serialize and parse round-trip', async () => {
  const memo = { todos: [{ text: 'a', isDone: false }, { text: 'b', isDone: true }], memos: ['note'] }
  expect(parse(serialize(memo, 'sid'))).toEqual(memo)
})

test('parse reads hand-edited Markdown', async () => {
  const text = '# x\n\n## TODO\n- [X] done\n* [ ] open\nstray\n\n## メモ\n- one\n- two\n'
  expect(parse(text)).toEqual({
    todos: [{ text: 'done', isDone: true }, { text: 'open', isDone: false }],
    memos: ['one', 'two'],
  })
})

test('clean folds newlines', async () => {
  expect(clean('  a\n b  ')).toBe('a b')
})
