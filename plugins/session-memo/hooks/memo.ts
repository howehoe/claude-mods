import type { Memo } from '../types'

export const EMPTY: Memo = { todos: [], memos: [] }

export function parse(text: string): Memo {
  const memo: Memo = { todos: [], memos: [] }
  let section: 'todo' | 'memo' | undefined
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      const name = (heading[1] ?? '').trim().toLowerCase()
      section = name === 'todo' ? 'todo' : name === 'memo' || name === 'メモ' ? 'memo' : undefined
      continue
    }
    if (section === 'todo') {
      const todo = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
      if (todo) memo.todos.push({ text: todo[2] ?? '', isDone: todo[1] !== ' ' })
    } else if (section === 'memo') {
      const item = /^\s*[-*]\s+(.*)$/.exec(line)
      if (item) memo.memos.push(item[1] ?? '')
    }
  }
  return memo
}

export function serialize(memo: Memo, sessionId: string): string {
  const todos = memo.todos.map(t => `- [${t.isDone ? 'x' : ' '}] ${t.text}`)
  const memos = memo.memos.map(m => `- ${m}`)
  return [`# Session memo ${sessionId}`, '', '## TODO', ...todos, '', '## Memo', ...memos, ''].join('\n')
}

// One line per item: newlines would break the Markdown list
export function clean(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}
