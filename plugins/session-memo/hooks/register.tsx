import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Memo } from '../types'
import { EMPTY, clean, parse, serialize } from './memo'

const PANE = 'session-memo'
const DIR = '.session-memo'
const POLL_MS = 3000

const memoAtom = atom({ plugin: 'session-memo', key: 'memo' } as const, EMPTY)
const pathAtom = atom({ plugin: 'session-memo', key: 'path' } as const, '')

let sessionId = ''
// The file's text as last read or written, so a poll only redraws on an outside change
let lastText: string | undefined

async function relPath($: EngineInterface): Promise<string> {
  if (!sessionId) sessionId = await $.session.id()
  return `${DIR}/${sessionId}.md`
}

async function load($: EngineInterface): Promise<void> {
  const path = await relPath($)
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  if (text === lastText) return
  lastText = text
  const memo = parse(text)
  await update($, memoAtom, () => memo)
}

async function save($: EngineInterface, change: (memo: Memo) => Memo): Promise<void> {
  await load($)
  const memo = change(await read($, memoAtom))
  const text = serialize(memo, sessionId)
  await $.fs.write(await relPath($), text)
  lastText = text
  await update($, memoAtom, () => memo)
}

async function openRaw($: EngineInterface): Promise<string> {
  const path = await relPath($)
  if (!(await $.fs.exists(path))) await save($, memo => memo)
  const abs = `${await $.session.cwd()}/${path}`
  const opened = await $.process.run(['open', '-t', abs]).catch(() => undefined)
  if (opened?.exitCode !== 0) await $.process.run(['xdg-open', abs]).catch(() => undefined)
  return abs
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = ''
    lastText = undefined
    await $.command.register({
      name: 'memo',
      description: 'Session memo: open the pane, `raw` for the .md file, `todo <text>` to add a TODO, `<text>` to add a memo',
      argumentHint: '[raw | todo <text> | <text>]',
    })
    await load($)
    await update($, pathAtom, () => `${DIR}/${sessionId}.md`)
    $.clock.every(POLL_MS, () => {
      void load($).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'memo' }, async ($, e) => {
    const args = e.args.trim()

    if (args === '') {
      await $.ui.open({ id: PANE, title: 'Session memo', focus: true })
      return { text: 'Session memo pane opened.' }
    }
    if (args === 'raw') {
      const abs = await openRaw($)
      return { text: `Opened ${abs}` }
    }
    const todo = /^todo(?:\s+([\s\S]*))?$/.exec(args)
    if (todo) {
      const text = clean(todo[1] ?? '')
      if (!text) return { text: 'Usage: /memo todo <text>' }
      await save($, memo => ({ ...memo, todos: [...memo.todos, { text, isDone: false }] }))
      return { text: `TODO added: ${text}` }
    }
    const text = clean(args)
    await save($, memo => ({ ...memo, memos: [...memo.memos, text] }))
    return { text: `Memo added: ${text}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const memo = await read($, memoAtom)
    const open = memo.todos.filter(t => !t.isDone).length
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>
          memo: TODO {open}/{memo.todos.length} · メモ {memo.memos.length}{' '}
        </Text>
        <Button
          key="open-pane"
          label="メモを開く"
          onPress={() => $.ui.open({ id: PANE, title: 'Session memo', focus: true })}
        />
        <Text> </Text>
        <Button key="open-raw" label="mdファイルで開く" onPress={() => openRaw($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // mobile has no Input: adding there goes through /memo
    const Input = 'Input' in elements ? elements.Input : undefined
    const memo = await read($, memoAtom)
    const path = await read($, pathAtom)

    return (
      <Box flexDirection="column">
        <Text dimColor>{path}</Text>
        <Text bold>TODO</Text>
        {memo.todos.length === 0 && <Text dimColor>No TODOs yet.</Text>}
        {memo.todos.map((todo, i) => (
          <Box>
            <Button
              key={`todo-toggle-${i}`}
              label={todo.isDone ? '[x]' : '[ ]'}
              onPress={() =>
                save($, m => ({
                  ...m,
                  todos: m.todos.map((t, j) => (j === i ? { ...t, isDone: !t.isDone } : t)),
                }))
              }
            />
            <Text dimColor={todo.isDone}> {todo.text} </Text>
            <Button
              key={`todo-delete-${i}`}
              label="削除"
              onPress={() => save($, m => ({ ...m, todos: m.todos.filter((_, j) => j !== i) }))}
            />
          </Box>
        ))}
        {Input && <Input
          key="todo-add"
          label="TODO追加"
          placeholder="新しいTODO"
          onSubmit={(value: string) => {
            const text = clean(value)
            if (text) void save($, m => ({ ...m, todos: [...m.todos, { text, isDone: false }] }))
          }}
        />}
        <Text> </Text>
        <Text bold>メモ</Text>
        {memo.memos.length === 0 && <Text dimColor>No memos yet.</Text>}
        {memo.memos.map((text, i) => (
          <Box>
            <Text>- {text} </Text>
            <Button
              key={`memo-delete-${i}`}
              label="削除"
              onPress={() => save($, m => ({ ...m, memos: m.memos.filter((_, j) => j !== i) }))}
            />
          </Box>
        ))}
        {Input && <Input
          key="memo-add"
          label="メモ追記"
          placeholder="新しいメモ"
          onSubmit={(value: string) => {
            const text = clean(value)
            if (text) void save($, m => ({ ...m, memos: [...m.memos, text] }))
          }}
        />}
      </Box>
    )
  })
}
