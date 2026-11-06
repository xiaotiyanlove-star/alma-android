import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A writable per-run screenshot directory on macOS and Linux runners. */
export async function screenshotDir(name: string): Promise<string> {
  const directory = join(tmpdir(), `alma-android-${name}`, 'test-artifacts')
  await mkdir(directory, { recursive: true })
  return directory
}
