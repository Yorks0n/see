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
      lib: {
        entry: {
          whiteboard: new URL('../tests/whiteboard.test.ts', import.meta.url).pathname,
          persistence: new URL('../tests/persistence.test.ts', import.meta.url).pathname,
          tldraw: new URL('../tests/tldraw.test.ts', import.meta.url).pathname,
          sync: new URL('../tests/sync.test.ts', import.meta.url).pathname,
          'cloud-client': new URL('../tests/cloud-client.test.ts', import.meta.url).pathname,
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.test.mjs`,
      },
      rollupOptions: { external: ['node:test', 'node:assert/strict'] },
    },
  })
  const result = spawnSync(process.execPath, ['--test', ...['whiteboard', 'persistence', 'tldraw', 'sync', 'cloud-client'].map((name) => join(outDir, `${name}.test.mjs`))], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  await rm(outDir, { recursive: true, force: true })
}
