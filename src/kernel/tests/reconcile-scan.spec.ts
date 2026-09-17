import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { discoverySearch } from '../../tools/discovery.ts'
import { provisionBehavioralHome } from '../behavioral-home.ts'
import { reconcileScan } from '../reconcile-scan.ts'

const commitAll = async (dir: string, message: string): Promise<void> => {
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t add -A`.quiet()
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit --no-gpg-sign -qm ${message}`.quiet()
}

type Setup = {
  home: string
  project: string
  commitHome: (message: string) => Promise<void>
  commitProject: (message: string) => Promise<void>
}

let teardown: (() => Promise<void>) | null = null

const setup = async (): Promise<Setup> => {
  const parent = (await Bun.$`mktemp -d`.quiet().text()).trim()
  const project = (await Bun.$`mktemp -d`.quiet().text()).trim()
  // HOME is the parent; the behavioral home root is <parent>/.behavioral
  Bun.env.HOME = parent
  const home = path.join(parent, '.behavioral')
  await provisionBehavioralHome(home)
  await Bun.$`git -C ${project} init -q ${project}`.quiet()
  teardown = async () => {
    await Bun.$`rm -rf ${parent} ${project}`.quiet().nothrow()
    delete Bun.env.HOME
  }
  return {
    home,
    project,
    commitHome: (message) => commitAll(home, message),
    commitProject: (message) => commitAll(project, message),
  }
}

const GOV_THREAD = `export const meta = {
  type: 'thread',
  title: 'Write policy governor',
  description: 'Blocks discovery writes outside the scan',
  generated: { by: 'turn-1', at: '2026-09-17T00:00:00Z' },
  status: 'stable',
}
`

const BRIEFING_HTML = `<html><head><script type="application/json" b-meta>
{"type":"html","title":"Space briefing","description":"Shared context about the space","generated":{"by":"turn-1","at":"2026-09-17T00:00:00Z"},"status":"stable"}
</script></head><body><p>x</p></body></html>`

describe('reconcile scan — the sole discovery writer', () => {
  test('artifact committed → row derived from BMeta + git log; artifact deleted → row gone', async () => {
    const s = await setup()
    try {
      const threadPath = path.join(s.home, 'root', 'threads', 'governor.ts')
      const htmlPath = path.join(s.home, 'root', 'html', 'briefing.html')
      const skillDir = path.join(s.project, '.agents', 'skills', 'echo')
      await Bun.write(threadPath, GOV_THREAD)
      await Bun.write(htmlPath, BRIEFING_HTML)
      await Bun.$`mkdir -p ${skillDir}`.quiet()
      await Bun.write(path.join(skillDir, 'SKILL.md'), '---\nname: echo\ndescription: Echoes the input.\n---\n# Echo')
      await s.commitHome('learn: governor + briefing')
      await s.commitProject('add echo skill')

      const scan = await reconcileScan({ cwd: s.project })
      expect(scan.created).toBe(3)
      expect(scan.skippedUncommitted).toBe(0)

      const rows = (await discoverySearch({ query: '' })).rows
      const threadRow = rows.find((r) => r.kind === 'thread')
      expect(threadRow?.name).toBe('Write policy governor')
      expect(threadRow?.description).toBe('Blocks discovery writes outside the scan')
      expect(threadRow?.space).toBe('root')
      expect(typeof (threadRow?.metadata as { commitSha?: string })?.commitSha).toBe('string')

      const htmlRow = rows.find((r) => r.kind === 'html')
      expect(htmlRow?.name).toBe('Space briefing')
      expect(typeof (htmlRow?.metadata as { commitSha?: string })?.commitSha).toBe('string')

      const skillRow = rows.find((r) => r.kind === 'skill')
      expect(skillRow?.name).toBe('echo')
      expect(skillRow?.description).toBe('Echoes the input.')

      // uncommitted means unlearned — write a thread without committing it
      await Bun.write(
        path.join(s.home, 'root', 'threads', 'ghost.ts'),
        GOV_THREAD.replace("'Write policy governor'", "'Ghost thread'"),
      )
      const rescan = await reconcileScan({ cwd: s.project })
      expect(rescan.created).toBe(0)
      expect(rescan.skippedUncommitted).toBe(1)
      expect((await discoverySearch({ query: 'Ghost thread' })).rows).toEqual([])

      // round-trip: artifact deleted (+committed) → row gone
      await Bun.$`rm ${threadPath}`.quiet()
      await s.commitHome('revert: remove governor')
      const afterDelete = await reconcileScan({ cwd: s.project })
      expect(afterDelete.deleted).toBe(1)
      expect((await discoverySearch({ query: 'Write policy governor' })).rows).toEqual([])
      // the ghost was committed by the revert commit — it is now learned
      expect((await discoverySearch({ query: 'Ghost thread' })).rows).toHaveLength(1)
    } finally {
      await teardown?.()
    }
  })

  test('a changed artifact updates its row; root scans index all spaces', async () => {
    const s = await setup()
    try {
      const threadPath = path.join(s.home, 'root', 'threads', 'governor.ts')
      await Bun.write(threadPath, GOV_THREAD)
      await s.commitHome('learn')

      // a second space with its own learned thread
      const spaceDir = path.join(s.home, 'project-a')
      await Bun.$`mkdir -p ${path.join(spaceDir, 'threads')}`.quiet()
      const spaceThread = path.join(spaceDir, 'threads', 'helper.ts')
      await Bun.write(
        spaceThread,
        GOV_THREAD.replace("'Write policy governor'", "'Project helper'").replace(
          'Blocks discovery writes outside the scan',
          'Helps the project space',
        ),
      )
      await s.commitHome('learn: project-a helper')

      await reconcileScan({ cwd: s.project })
      const before = (await discoverySearch({ query: 'governor' })).rows
      expect(before).toHaveLength(1)
      const helper = (await discoverySearch({ query: 'Project helper' })).rows
      expect(helper).toHaveLength(1)
      expect(helper[0]!.space).toBe('project-a')

      // change the root artifact's description + commit → scan updates the row
      await Bun.write(threadPath, GOV_THREAD.replace('Blocks discovery writes outside the scan', 'Blocks all writes'))
      await s.commitHome('update: governor description')
      const rescan = await reconcileScan({ cwd: s.project })
      expect(rescan.updated).toBe(1)
      const after = (await discoverySearch({ query: 'Blocks all writes' })).rows
      expect(after).toHaveLength(1)
    } finally {
      await teardown?.()
    }
  })

  test('a thread with a malformed meta export is skipped, not indexed', async () => {
    const s = await setup()
    try {
      await Bun.write(path.join(s.home, 'root', 'threads', 'bad.ts'), 'export const meta = { nope: true }\n')
      await s.commitHome('learn: bad meta')
      const scan = await reconcileScan({ cwd: s.project })
      expect(scan.skippedInvalid).toBe(1)
      expect((await discoverySearch({ query: '' })).rows).toEqual([])
    } finally {
      await teardown?.()
    }
  })
})
