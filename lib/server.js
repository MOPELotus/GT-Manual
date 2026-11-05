import http from 'node:http'
import fs from 'node:fs'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const PUBLIC = new URL('../public/', import.meta.url)
const FAILURES = new Set(['manual_closed', 'manual_sdk_error', 'manual_invalid_result', 'manual_submission_failed'])
const staticFiles = new Map([
  ['/verify.js', ['verify.js', 'text/javascript; charset=utf-8']],
  ['/verify.css', ['verify.css', 'text/css; charset=utf-8']],
])
const string = (value, max = 8192) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const invalid = message => { const error = new Error(message); error.status = 400; return error }
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

function originAllowed(req, config) {
  const value = req.headers.origin
  if (value === undefined) return true
  if (typeof value !== 'string') return false
  let origin
  try { origin = new URL(value) } catch { return false }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) return false
  if ([config.publicAddress, ...(config.allowedOrigins || [])].includes(value)) return true
  const host = req.headers.host
  if (typeof host !== 'string' || /[\s,/@?#\\]/.test(host)) return false
  const remote = req.socket.remoteAddress
  const loopback = remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1'
  const protocol = req.socket.encrypted || (loopback && req.headers['x-forwarded-proto'] === 'https') ? 'https:' : 'http:'
  try { return new URL(`${protocol}//${host}`).origin === value } catch { return false }
}

function alias(data, camel, snake) {
  if (data[camel] !== undefined && data[snake] !== undefined && data[camel] !== data[snake]) throw invalid('Conflicting proof fields')
  return data[camel] ?? data[snake]
}

function declaredVersion(data) {
  const versions = ['captchaVersion', 'captcha_version', 'version'].filter(key => data[key] !== undefined).map(key => String(data[key]).replace(/^v/, ''))
  if (versions.some(v => !['3', '4'].includes(v)) || new Set(versions).size > 1) throw invalid('Unsupported or conflicting captcha version')
  return versions[0]
}

function versionOf(data) {
  const version = declaredVersion(data)
  const version4 = version === '4' || data.captchaId !== undefined || data.captcha_id !== undefined
  if (version4 && version === '3') throw invalid('Conflicting captcha version')
  return version4 ? 4 : 3
}

function registration(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Invalid registration')
  const captchaVersion = versionOf(data)
  if (captchaVersion === 4) {
    const captchaId = alias(data, 'captchaId', 'captcha_id')
    const riskType = alias(data, 'riskType', 'risk_type')
    if (!string(captchaId, 256) || data.gt !== undefined || data.challenge !== undefined) throw invalid('Invalid v4 registration')
    if (riskType !== undefined && !string(riskType)) throw invalid('Invalid riskType')
    if (data.userInfo !== undefined && !string(data.userInfo, 1024)) throw invalid('Invalid userInfo')
    return { captchaVersion, captchaId, ...(riskType !== undefined ? { riskType } : {}), ...(data.userInfo !== undefined ? { userInfo: data.userInfo } : {}) }
  }
  if (!string(data.gt, 256) || !string(data.challenge, 1024)) throw invalid('Invalid v3 registration')
  return { captchaVersion, gt: data.gt, challenge: data.challenge,
    ...(typeof data.new_captcha === 'boolean' || [0, 1].includes(data.new_captcha) ? { new_captcha: data.new_captcha } : {}),
    ...(typeof data.success === 'boolean' || [0, 1].includes(data.success) ? { success: data.success } : {}) }
}

function solution(data, challenge) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Invalid proof')
  if (challenge.captchaVersion === 4) {
    if (data.validate !== undefined || data.geetest_validate !== undefined || (declaredVersion(data) && declaredVersion(data) !== '4')) throw invalid('Wrong proof version')
    const captchaId = alias(data, 'captchaId', 'captcha_id') ?? challenge.captchaId
    const lotNumber = alias(data, 'lotNumber', 'lot_number')
    const captchaOutput = alias(data, 'captchaOutput', 'captcha_output')
    const passToken = alias(data, 'passToken', 'pass_token')
    const time = alias(data, 'genTime', 'gen_time')
    const genTime = typeof time === 'number' && Number.isFinite(time) ? String(time) : time
    if (captchaId !== challenge.captchaId || ![lotNumber, captchaOutput, passToken].every(v => string(v)) || typeof genTime !== 'string' || !/^\d+$/.test(genTime) || genTime.length > 32) throw invalid('Invalid v4 proof')
    return { captchaVersion: 4, captchaId, lotNumber, captchaOutput, passToken, genTime }
  }
  if (versionOf(data) === 4 || ['lotNumber', 'lot_number', 'captchaOutput', 'captcha_output', 'passToken', 'pass_token', 'genTime', 'gen_time'].some(key => key in data)) throw invalid('Wrong proof version')
  const challengeId = alias(data, 'challenge', 'geetest_challenge')
  const validate = alias(data, 'validate', 'geetest_validate')
  const seccode = alias(data, 'seccode', 'geetest_seccode') ?? (string(validate) ? `${validate}|jordan` : '')
  // The v3 SDK may legitimately return an updated challenge. Relay that exact
  // value rather than substituting the registration's original challenge.
  if (!string(challengeId, 1024) || !string(validate) || seccode !== `${validate}|jordan`) throw invalid('Invalid v3 proof')
  return { challenge: challengeId, validate, seccode }
}

async function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { const error = invalid('JSON body required'); error.status = 415; throw error }
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > 16384) { const error = invalid('Body too large'); error.status = 413; throw error }
    return req.body
  }
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) { const error = invalid('Body too large'); error.status = 413; throw error }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw invalid('Invalid JSON') }
}

function equalKey(a, b) {
  return timingSafeEqual(createHash('sha256').update(String(a ?? '')).digest(), createHash('sha256').update(b).digest())
}

export function createVerificationHandler({ config, now = Date.now } = {}) {
  if (!config) throw new Error('Configuration required')
  const basePath = config.basePath || ''
  const tasks = new Map()
  const fail = (task, reason, deleteAt = now() + config.resultTtlMs) => {
    task.result = { ok: false, reason, captchaVersion: task.challenge.captchaVersion }
    task.state = 'done'
    task.deleteAt = deleteAt
  }
  const sweep = () => {
    for (const [id, task] of tasks) {
      if (task.state !== 'done' && now() >= task.expiresAt) fail(task, 'manual_expired', task.expiresAt + config.resultTtlMs)
      if (task.state === 'done' && now() >= task.deleteAt) tasks.delete(id)
    }
  }
  const send = (res, status, data, message = 'OK') => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: status < 400 ? 0 : 1, message, data }))
  }
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com 'unsafe-eval'; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    try {
      sweep()
      const url = new URL(req.originalUrl || req.url, 'http://localhost')
      if (basePath) {
        if (!url.pathname.startsWith(basePath + '/')) { send(res, 404, null, 'Not found'); return }
        url.pathname = url.pathname.slice(basePath.length)
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'lotus-gt-manual', protocol: 1, versions: [3, 4] })); return
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname)
        res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(new URL(file, PUBLIC))); return
      }
      if (req.method === 'POST' && url.pathname === '/GTest/register') {
        const body = await readBody(req)
        if (config.registerKey && !equalKey(url.searchParams.get('key') ?? body.key, config.registerKey)) { send(res, 403, null, 'Registration denied'); return }
        const challenge = registration(body)
        if (tasks.size >= config.maxTasks) { send(res, 503, null, 'Verification capacity reached'); return }
        const id = randomBytes(24).toString('base64url'), expiresAt = now() + config.ttlMs
        tasks.set(id, { challenge, expiresAt, state: 'pending' })
        const base = `${config.publicAddress}${basePath}`
        send(res, 200, { link: `${base}/GTest/${id}`, result: `${base}/GTest/validate/${id}`, expires_in_ms: config.ttlMs, expires_at: expiresAt }); return
      }
      const match = url.pathname.match(/^\/GTest\/(?:(register|validate|fail)\/)?([A-Za-z0-9_-]{32})$/)
      if (!match) { send(res, 404, null, 'Not found'); return }
      const [, action, id] = match
      const task = tasks.get(id)
      if (!task) { send(res, 410, null, 'Verification unavailable'); return }
      if (req.method === 'GET' && !action) {
        if (task.state !== 'pending') { send(res, 409, null, 'Verification already claimed or completed'); return }
        const footer = config.icpNumber ? `<footer><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${escapeHtml(config.icpNumber)}</a></footer>` : ''
        const page = fs.readFileSync(new URL('index.html', PUBLIC), 'utf8').replace('<!-- ICP_FOOTER -->', footer)
          .replace('href="/verify.css"', `href="${basePath}/verify.css"`).replace('src="/verify.js"', `src="${basePath}/verify.js"`)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return
      }
      if (req.method === 'GET' && action === 'register') {
        if (task.state !== 'pending') { send(res, 409, null, 'Verification already claimed or completed'); return }
        task.state = 'claimed'
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(task.challenge)); return
      }
      if (req.method === 'GET' && action === 'validate') {
        if (task.state !== 'done') { send(res, 200, {}); return }
        tasks.delete(id) // consume synchronously before any response write
        send(res, 200, task.result); return
      }
      if (req.method === 'POST' && ['validate', 'fail'].includes(action)) {
        if (!originAllowed(req, config)) { send(res, 403, null, 'Origin denied'); return }
        // Read before rechecking state: another concurrent submission may have
        // completed while this request was still streaming its body.
        const body = await readBody(req)
        sweep()
        if (tasks.get(id) !== task || task.state !== 'claimed') { send(res, 409, null, 'Verification not claimable'); return }
        if (action === 'fail') {
          if (!FAILURES.has(body?.reason)) throw invalid('Unknown failure reason')
          fail(task, body.reason)
        } else {
          try { task.result = solution(body, task.challenge) }
          catch (error) { fail(task, 'manual_invalid_result'); throw error }
          task.state = 'done'; task.deleteAt = now() + config.resultTtlMs
        }
        send(res, 200, {}); return
      }
      send(res, 405, null, 'Method not allowed')
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, null, error.status ? error.message : 'Request failed')
      else res.end()
    }
  }
  const timer = setInterval(sweep, 1000)
  timer.unref()
  handler.close = () => { clearInterval(timer); tasks.clear() }
  return handler
}

export function createVerificationServer(options = {}) {
  const handler = createVerificationHandler(options)
  const server = http.createServer(handler)
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.once('close', handler.close)
  return server
}
