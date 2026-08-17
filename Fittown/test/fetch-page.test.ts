import { describe, expect, it } from 'vitest'
import { assertFetchableUrl, isPrivateAddress, PageFetchError } from '../server/utils/fetchPage'

/**
 * The guard on the URL importer.
 *
 * The server fetches an address the user supplies, so the request comes from
 * inside the household's network. These tests are what stop a link that looks
 * like a recipe from being a way to reach the router's admin page.
 *
 * No network here: everything uses IP literals or names that resolve locally.
 */

describe('recognising a private address', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each([
    // 172.16/12 stops at 172.31 — 172.66 is Cloudflare, and a prefix check on
    // "172." would block a large slice of the public internet.
    '172.66.41.15', '172.32.0.1', '172.15.0.1',
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '2606:4700::1111', '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })

  it('blocks the cloud metadata address specifically', () => {
    // 169.254.169.254 is the single most valuable SSRF target there is.
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
  })
})

describe('validating a URL', () => {
  const rejects = async (url: string) => {
    await expect(assertFetchableUrl(url)).rejects.toBeInstanceOf(PageFetchError)
  }

  it('rejects a scheme that is not http or https', async () => {
    await rejects('file:///etc/passwd')
    await rejects('ftp://example.com/x')
    await rejects('data:text/html,<h1>hi')
  })

  it('rejects something that is not a URL at all', async () => {
    await rejects('loveandlemons.com/balsamic')
    await rejects('')
  })

  it('rejects a private IP literal', async () => {
    await rejects('http://127.0.0.1/admin')
    await rejects('http://192.168.1.1/')
    await rejects('http://[::1]:8080/')
    await rejects('http://169.254.169.254/latest/meta-data/')
  })

  it('rejects localhost by name', async () => {
    await rejects('http://localhost:3000/')
    await rejects('http://app.localhost/')
  })

  it('accepts a public IP literal', async () => {
    const url = await assertFetchableUrl('https://1.1.1.1/')
    expect(url.hostname).toBe('1.1.1.1')
  })
})
