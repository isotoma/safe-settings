require('dotenv').config()
const appFn = require('./')
const { FULL_SYNC_NOP } = require('./lib/env')
const { createProbot } = require('probot')

async function performFullSync (appFn, nop) {
  const probot = createProbot()
  await probot.auth()
  probot.log.info(`Starting full sync with NOP=${nop}`)

  try {
    const app = appFn(probot, {})
    const settings = await app.syncInstallation(nop)

    if (settings && settings.results) {
      const results = settings.results.filter(Boolean)
      if (results.length === 0) {
        console.log('No changes detected.')
      } else {
        console.log(`\n=== Dry-run results (${results.length} change(s)) ===\n`)
        results.forEach(r => {
          const icon = r.type === 'ERROR' ? '✗' : '~'
          console.log(`${icon} [${r.plugin}] repo: ${r.repo}`)
          if (r.endpoint) console.log('  endpoint:', r.endpoint)
          if (r.body) console.log('  body:', JSON.stringify(r.body, null, 4))
          if (r.action.msg) console.log('  msg:', r.action.msg)
          const hasKeys = o => o && (Array.isArray(o) ? o.length > 0 : Object.keys(o).length > 0)
          if (hasKeys(r.action.additions)) console.log('  additions:', JSON.stringify(r.action.additions, null, 4))
          if (hasKeys(r.action.modifications)) console.log('  modifications:', JSON.stringify(r.action.modifications, null, 4))
          if (hasKeys(r.action.deletions)) console.log('  deletions:', JSON.stringify(r.action.deletions, null, 4))
          console.log()
        })
        console.log('=== End of dry-run results ===')
      }
    }

    if (settings && settings.errors && settings.errors.length > 0) {
      probot.log.error('Errors occurred during full sync.')
      process.exit(1)
    }

    probot.log.info('Full sync completed successfully.')
  } catch (error) {
    console.error('Unexpected error during full sync:', error)
    process.exit(1)
  }
}

performFullSync(appFn, FULL_SYNC_NOP).catch((error) => {
  console.error('Fatal error during full sync:', error)
  process.exit(1)
})
