import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config.js'
import { createVerificationServer } from './lib/server.js'

const root = fileURLToPath(new URL('.', import.meta.url))
try {
  const config = await loadConfig(root)
  const server = createVerificationServer({ config })
  server.on('error', () => { console.error('GT-Manual listener failed'); process.exitCode = 1 })
  server.listen(config.port, config.host, () => console.info('GT-Manual verification service ready (v3/v4)'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { process.exitCode = 0 })
    server.closeIdleConnections()
  })
} catch {
  console.error('GT-Manual startup failed; check configuration and listener availability')
  process.exitCode = 1
}
