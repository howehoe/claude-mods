import { expect, test } from 'claude-code/testing'

// エンジンの代わりに、作業ディレクトリと in-memory のファイルを用意する
function engine(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>, state: { cwd: string }) {
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'memo' } }))
  on('clock.every', () => ({ value: undefined }))
  // 相対パスは今の作業ディレクトリ基準で解決する（$.fs と同じ）
  const abs = (p: string) => (p.startsWith('/') ? p : `${state.cwd}/${p}`)
  on('fs.exists', (_, e) => ({ value: files.has(abs(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(abs(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(abs(e.path), e.text)
    return { value: undefined }
  })
}

const memo = (args: string) =>
  ({ command: 'memo', args, origin: { kind: 'composer' }, presentation: 'shown' }) as never

test('作業ディレクトリが動いてもメモは最初の場所に残り、消えない', async ($, on) => {
  const files = new Map<string, string>()
  const state = { cwd: '/repo' }
  engine(on, files, state)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run(memo('最初のメモ'))

  // Bash の cd や EnterWorktree で作業ディレクトリが動く（ワークツリーでは session.start も再実行）
  state.cwd = '/repo/.claude/worktrees/x'
  await $.session.start({ cwd: state.cwd, surface: 'terminal', isInteractive: true })
  await $.command.run(memo('todo 移動後の TODO'))

  expect([...files.keys()]).toEqual(['/repo/.session-memo/sid.md'])
  const text = files.get('/repo/.session-memo/sid.md') ?? ''
  expect(text).toContain('- 最初のメモ')
  expect(text).toContain('- [ ] 移動後の TODO')
})
