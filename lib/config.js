import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { isIP } from 'node:net'

async function readYaml(root, file) {
  try { return YAML.parse(await fs.readFile(path.join(root, file), 'utf8')) || {} }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot read configuration: ${file}`) }
}

export async function loadConfig(root = process.cwd()) {
  const http = await readYaml(root, 'config/config/http.yaml')
    || await readYaml(root, 'config/server.yaml')
    || await readYaml(root, 'config/default_config/config/http.yaml')
  const configuredPage = await readYaml(root, 'config/page/GTest.yaml')
  const page = configuredPage || await readYaml(root, 'config/default_config/page/GTest.yaml')
  if (!http || !page) throw new Error('Configuration templates are missing')
  if (http.HTTPS === true) throw new Error('Direct TLS configuration requires migration: terminate HTTPS at a reverse proxy; see README')
  const legacyHome = configuredPage?.ICP_NUMBER === undefined ? await readYaml(root, 'config/page/home.yaml') : null
  return normalizeConfig({ ...http, ...page, ICP_NUMBER: configuredPage?.ICP_NUMBER ?? legacyHome?.SITE_ICP ?? page.ICP_NUMBER ?? '' })
}

export function normalizeConfig(input = {}) {
  const positive = (key, fallback, max) => {
    const value = input[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid configuration: ${key}`)
    return value
  }
  const normalizeOrigin = value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Expected an HTTP(S) origin')
    const url = new URL(value)
    const authority = value.trim().match(/^[a-z]+:\/\/([^/]+)/i)?.[1] || ''
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value)
      || authority.includes('@') || url.pathname !== '/') throw new Error('Expected an HTTP(S) origin')
    return url
  }
  const publicValue = input.PUBLIC_ADDRESS || 'http://127.0.0.1:7833'
  const publicUrl = normalizeOrigin(publicValue)
  if (!Array.isArray(input.ALLOWED_ORIGINS ?? [])) throw new Error('ALLOWED_ORIGINS must be an array')
  const allowedOrigins = new Set([publicUrl.origin, ...(input.ALLOWED_ORIGINS || []).map(value => normalizeOrigin(value).origin)])
  const authority = publicValue.trim().match(/^[a-z]+:\/\/([^/?#]+)/i)?.[1] || ''
  if (!isIP(publicUrl.hostname.replace(/^\[|\]$/g, '')) && !/:\d+$/.test(authority)) {
    allowedOrigins.add(`http://${publicUrl.hostname}`)
    allowedOrigins.add(`https://${publicUrl.hostname}`)
  }
  if (typeof (input.REGISTER_KEY ?? '') !== 'string') throw new Error('REGISTER_KEY must be a string')
  if (typeof (input.ICP_NUMBER ?? '') !== 'string' || (input.ICP_NUMBER || '').length > 256) throw new Error('Invalid ICP_NUMBER')
  const host = input.HOST ?? '127.0.0.1'
  if (typeof host !== 'string' || !host.trim()) throw new Error('Invalid HOST')
  return {
    icpNumber: (input.ICP_NUMBER || '').trim(),
    allowedOrigins: [...allowedOrigins],
    host, port: positive('HTTP_PORT', 7833, 65535), publicAddress: publicUrl.origin,
    registerKey: input.REGISTER_KEY || '', ttlMs: positive('TTL_MS', 180000, 3600000),
    resultTtlMs: positive('RESULT_TTL_MS', 30000, 3600000), maxTasks: positive('MAX_TASKS', 1000, 100000),
  }
}
