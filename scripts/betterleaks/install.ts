#!/usr/bin/env bun
/**
 * @module betterleaks/install
 *
 * Install the pinned betterleaks binary into `scripts/betterleaks/.bin/`.
 *
 * betterleaks is a Go tool, not an npm package — but `Bun.$` can still invoke
 * the installed binary (`betterleaks config show` is the credential-pattern
 * generator's source; `betterleaks stdin`/`dir` is the scanning path). The
 * install is pinned for reproducibility and checksum-verified against the
 * release's `checksums.txt`.
 *
 * Usage:
 *   bun run scripts/betterleaks/install.ts [--force]
 */

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RELEASE_VERSION = 'v1.8.1'
export const RELEASE_REPO = 'betterleaks/betterleaks'

/** Where the pinned binary lands — `scripts/betterleaks/.bin/` (gitignored). */
export const BIN_DIR = join(import.meta.dir, '.bin')
export const BIN_NAME = process.platform === 'win32' ? 'betterleaks.exe' : 'betterleaks'
export const BIN_PATH = join(BIN_DIR, BIN_NAME)

export type TargetOs = 'darwin' | 'linux' | 'windows'
export type TargetArch = 'arm64' | 'x64'

/** Map Node/Bun's `process.platform`/`process.arch` onto betterleaks release targets. */
export const resolveTarget = (platform: string, arch: string): { os: TargetOs; arch: TargetArch } => {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux'
  return { os, arch: arch === 'arm64' ? 'arm64' : 'x64' }
}

/** The release asset name, e.g. `betterleaks_1.8.1_darwin_arm64.tar.gz`. */
export const releaseAsset = ({ version, os, arch }: { version: string; os: TargetOs; arch: TargetArch }): string => {
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  return `betterleaks_${version.replace(/^v/, '')}_${os}_${arch}.${ext}`
}

/** Pull the sha256 for one asset out of a `checksums.txt` body (`<hash>  <name>`). */
export const parseChecksums = (text: string, asset: string): string | undefined => {
  for (const line of text.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (name === asset && hash !== undefined) return hash
  }
  return undefined
}

/** Find the binary's path (relative to the archive root) in a `tar -t`/`unzip -l` listing. */
export const binaryEntry = (listing: string, name: string = BIN_NAME): string | undefined =>
  listing
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line === name || line.endsWith(`/${name}`))

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

const install = async (force: boolean): Promise<void> => {
  if (!force && (await Bun.file(BIN_PATH).exists())) {
    console.log(`betterleaks already installed at ${BIN_PATH} (pass --force to reinstall)`)
    return
  }

  const { os, arch } = resolveTarget(process.platform, process.arch)
  const asset = releaseAsset({ version: RELEASE_VERSION, os, arch })
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_VERSION}`

  const response = await fetch(`${base}/${asset}`)
  if (!response.ok) throw new Error(`download failed (${response.status}): ${base}/${asset}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  const expected = parseChecksums(await (await fetch(`${base}/checksums.txt`)).text(), asset)
  if (expected === undefined) throw new Error(`checksums.txt has no entry for ${asset}`)
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)

  const work = mkdtempSync(join(tmpdir(), 'betterleaks-'))
  try {
    const archive = join(work, asset)
    await Bun.write(archive, bytes)
    const listing = os === 'windows' ? await Bun.$`unzip -l ${archive}`.text() : await Bun.$`tar -tzf ${archive}`.text()
    const entry = binaryEntry(listing)
    if (entry === undefined) throw new Error(`archive ${asset} contains no ${BIN_NAME}`)
    if (os === 'windows') await Bun.$`unzip -o ${archive} -d ${work}`.quiet()
    else await Bun.$`tar -xzf ${archive} -C ${work}`.quiet()
    mkdirSync(BIN_DIR, { recursive: true })
    copyFileSync(join(work, entry), BIN_PATH)
    chmodSync(BIN_PATH, 0o755)
    console.log(`installed betterleaks ${RELEASE_VERSION} → ${BIN_PATH}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await install(process.argv.includes('--force'))
}
