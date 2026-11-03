export async function startVerification({ id, button, status, fetchImpl = fetch, loadSdk = defaultLoadSdk, sdk = globalThis } = {}) {
  let started = false, finished = false, captcha
  const setStatus = message => { status.textContent = message }
  const post = async (route, body) => {
    const response = await fetchImpl(`/GTest/${route}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Verification request rejected')
  }
  const fail = async reason => {
    if (finished) return
    finished = true; button.disabled = true
    setStatus('验证已结束，请返回机器人获取新链接。')
    try { await post('fail', { reason }) } catch { /* TTL remains the fallback when delivery fails. */ }
    try { captcha?.destroy?.() } catch { /* Already terminal. */ }
  }
  const onSuccess = async challenge => {
    if (finished) return
    finished = true; button.disabled = true
    let data
    try { data = captcha.getValidate() } catch { finished = false; await fail('manual_invalid_result'); return }
    if (!data) {
      finished = false
      await fail('manual_invalid_result'); return
    }
    const proof = challenge.captchaVersion === 4 ? {
      captchaVersion: 4, captchaId: challenge.captchaId,
      lotNumber: data.lot_number, captchaOutput: data.captcha_output,
      passToken: data.pass_token, genTime: data.gen_time,
    } : data
    try { await post('validate', proof); setStatus('验证已提交，请返回机器人查看业务结果。') }
    catch {
      setStatus('提交未确认，请返回机器人获取新链接。')
      try { await post('fail', { reason: 'manual_submission_failed' }) } catch { /* Never resend a proof. */ }
    }
    try { captcha?.destroy?.() } catch { /* Already terminal. */ }
  }
  button.addEventListener('click', async () => {
    if (started || finished) return
    started = true; button.disabled = true; setStatus('正在准备验证…')
    let challenge
    try {
      const response = await fetchImpl(`/GTest/register/${id}`, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error('Unavailable')
      challenge = await response.json()
      const v4 = challenge.captchaVersion === 4
      await loadSdk(v4 ? 4 : 3)
      if (finished) return
      const initialize = v4 ? sdk.initGeetest4 : sdk.initGeetest
      if (typeof initialize !== 'function') throw new Error('SDK unavailable')
      const config = v4 ? {
        captchaId: challenge.captchaId, product: 'bind',
        onError: () => { void fail('manual_sdk_error') },
        ...(challenge.riskType !== undefined ? { riskType: challenge.riskType } : {}),
        ...(challenge.userInfo !== undefined ? { userInfo: challenge.userInfo } : {}),
      } : {
        gt: challenge.gt, challenge: challenge.challenge, product: 'bind',
        hideRefresh: true, new_captcha: challenge.new_captcha ?? true, offline: challenge.success === false || challenge.success === 0,
      }
      initialize(config, instance => {
        if (finished) { instance.destroy?.(); return }
        captcha = instance
        try {
          captcha.onError(() => { void fail('manual_sdk_error') })
          captcha.onClose(() => { void fail('manual_closed') })
          if (v4) captcha.onFail(() => { void fail('manual_invalid_result') })
          captcha.onSuccess(() => { void onSuccess(challenge) })
          captcha.onReady(() => {
            if (finished) return
            setStatus('请完成弹出的验证。')
            try {
              if (v4) captcha.showCaptcha()
              else captcha.verify()
            } catch { void fail('manual_sdk_error') }
          })
        } catch { void fail('manual_sdk_error') }
      })
    } catch { await fail('manual_sdk_error') }
  })
  return { fail }
}

function defaultLoadSdk(version) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = version === 4 ? 'https://static.geetest.com/v4/gt4.js' : 'https://static.geetest.com/static/tools/gt.js'
    script.onload = resolve; script.onerror = reject
    document.head.append(script)
  })
}

if (typeof document !== 'undefined') {
  const id = location.pathname.match(/^\/GTest\/([A-Za-z0-9_-]{32})$/)?.[1]
  const button = document.getElementById('verify'), status = document.getElementById('status')
  if (id && button && status) void startVerification({ id, button, status })
}
