/**
 * @module betterleaks/install.spec
 *
 * Tests for the betterleaks install script's pure surface: platform/arch
 * mapping, release-asset naming, and checksum parsing. The network install
 * itself is exercised only in the `install betterleaks` CI/dev path.
 */

import { describe, expect, test } from 'bun:test'
import { binaryEntry, parseChecksums, releaseAsset, resolveTarget } from '../install.ts'

describe('resolveTarget', () => {
  test('maps darwin/arm64', () => {
    expect(resolveTarget('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' })
  })

  test('maps win32/x64 to windows/x64', () => {
    expect(resolveTarget('win32', 'x64')).toEqual({ os: 'windows', arch: 'x64' })
  })

  test('falls back to linux/x64 for an unknown platform and arch', () => {
    expect(resolveTarget('freebsd', 'ia32')).toEqual({ os: 'linux', arch: 'x64' })
  })

  test('falls back to x64 for an unknown arch on a known platform', () => {
    expect(resolveTarget('linux', 'riscv64')).toEqual({ os: 'linux', arch: 'x64' })
  })
})

describe('releaseAsset', () => {
  test('builds the tar.gz name for macos arm64', () => {
    expect(releaseAsset({ version: 'v1.8.1', os: 'darwin', arch: 'arm64' })).toBe(
      'betterleaks_1.8.1_darwin_arm64.tar.gz',
    )
  })

  test('builds the tar.gz name for linux x64', () => {
    expect(releaseAsset({ version: '1.8.1', os: 'linux', arch: 'x64' })).toBe('betterleaks_1.8.1_linux_x64.tar.gz')
  })

  test('builds the zip name for windows', () => {
    expect(releaseAsset({ version: 'v1.8.1', os: 'windows', arch: 'x64' })).toBe('betterleaks_1.8.1_windows_x64.zip')
  })
})

describe('parseChecksums', () => {
  test('returns the hash for the named asset', () => {
    const text = ['aaaa  betterleaks_1.8.1_linux_x64.tar.gz', 'bbbb  betterleaks_1.8.1_darwin_arm64.tar.gz'].join('\n')
    expect(parseChecksums(text, 'betterleaks_1.8.1_darwin_arm64.tar.gz')).toBe('bbbb')
  })

  test('returns undefined when the asset is absent', () => {
    expect(parseChecksums('aaaa  other.tar.gz\n', 'missing.tar.gz')).toBeUndefined()
  })
})

describe('binaryEntry', () => {
  test('finds the binary at the archive root', () => {
    expect(binaryEntry('betterleaks\nLICENSE\n', 'betterleaks')).toBe('betterleaks')
  })

  test('finds the binary nested in a directory', () => {
    expect(binaryEntry('betterleaks_1.8.1_darwin_arm64/betterleaks\n', 'betterleaks')).toBe(
      'betterleaks_1.8.1_darwin_arm64/betterleaks',
    )
  })

  test('returns undefined when the listing has no binary', () => {
    expect(binaryEntry('LICENSE\nREADME.md\n', 'betterleaks')).toBeUndefined()
  })
})
