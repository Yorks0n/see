import { build } from 'vite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const outDir = await mkdtemp(join(tmpdir(), 'see-tests-'))
try {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir,
      minify: false,
      lib: { entry: new URL('../tests/whiteboard.test.ts', import.meta.url).pathname, formats: ['es'], fileName: () => 'whiteboard.test.mjs' },
      rollupOptions: { external: ['node:test', 'node:assert/strict'] },
    },
  })
  const result = spawnSync(process.execPath, ['--test', join(outDir, 'whiteboard.test.mjs')], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  await rm(outDir, { recursive: true, force: true })
}
