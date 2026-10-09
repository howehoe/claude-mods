export type Todo = { text: string; isDone: boolean }
export type Memo = { todos: Todo[]; memos: string[] }

declare module 'claude-code' {
  interface PluginState {
    'session-memo': { memo: Memo; path: string }
  }
}
