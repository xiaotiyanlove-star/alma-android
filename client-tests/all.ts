/**
 * Every check that must pass before a build is handed over.
 *
 * `npm test` covers the pure units; the UI checks drive the real interface in
 * a browser against a synthetic relay. Both are needed: the units cannot see a
 * broken layout, and the UI checks cannot see a parser rule that silently
 * drops a menu.
 *
 * Run with `npm run test:all` (after `npm run dev` is listening, or with
 * APP_PORT pointing at an already running dev server). Anything that fails
 * stops the run and is reported by name. `--skip-build` runs only the UI
 * checks, for a pipeline that already ran the unit tests and the build.
 */
import { spawn } from 'node:child_process'

interface Step { name: string; script: string; args: string[] }

const UI_CHECKS = [
  // Whole-app flows.
  'browser-smoke',
  'navigation-check',
  // One check per feature area.
  'scan-ui-check',
  'scan-flow-check',
  'prompt-ui-check',
  'markdown-ui-check',
  'copy-ui-check',
  'attach-ui-check',
  'session-name-ui-check',
  'new-session-ui-check',
  'share-link-ui-check',
  'transcript-gap-ui-check',
  'agents-commands-ui-check',
  'fixes-ui-check',
  'nodes-ux-check',
  'settings-nodes-check',
  'settings-groups-check',
  // Weak-network behaviour: detection time and background retry silence.
  'weaknet-check',
]

/**
 * `--skip-build` leaves out the steps CI already ran in an earlier job, so the
 * suite can be split there without running the tests twice.
 */
const skipBuild = process.argv.includes('--skip-build')

const steps: Step[] = [
  ...(skipBuild ? [] : [
    { name: 'unit tests', script: 'npm', args: ['test'] },
    { name: 'type check + production build', script: 'npm', args: ['run', 'build:web'] },
  ]),
  ...UI_CHECKS.map((name) => ({ name, script: 'npx', args: ['tsx', `client-tests/${name}.ts`] })),
]

function run(step: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.script, step.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${step.name} failed (exit ${code})\n${output.slice(-2500)}`))
    })
  })
}

const started = Date.now()
for (const [index, step] of steps.entries()) {
  process.stdout.write(`[${index + 1}/${steps.length}] ${step.name}… `)
  try {
    await run(step)
    process.stdout.write('ok\n')
  } catch (error) {
    process.stdout.write('FAILED\n\n')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
console.log(`\nAll ${steps.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s.`)
