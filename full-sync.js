require('dotenv').config()
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const appFn = require('./')
const env = require('./lib/env')
const { FULL_SYNC_NOP } = env
const { createProbot } = require('probot')

/**
 * Fail fast on a broken LOCAL_CONFIG_PATH.
 *
 * The config loaders in lib/settings.js and lib/configManager.js deliberately
 * swallow ENOENT and return []/null, to mimic a 404 from the Contents API. That
 * is right for the API path, but for a local checkout it turns a wrong path into
 * a silent "No changes detected" rather than an error. This checks up front so a
 * misconfigured run says so instead of reporting a false clean.
 */
function validateLocalConfig () {
  const root = env.LOCAL_CONFIG_PATH
  if (!root) return

  const fail = (msg, hint) => {
    console.error(`LOCAL_CONFIG_PATH is set to ${root}, but ${msg}`)
    if (hint) console.error(hint)
    process.exit(1)
  }

  let stat
  try {
    stat = fs.statSync(root)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return fail('that path does not exist.',
      'If you are running in a container, the config checkout has to be mounted there.')
  }
  if (!stat.isDirectory()) fail('that path is not a directory.')

  // The settings file must exist and parse. safe-settings runs js-yaml 5, which
  // throws on a comments-only document where js-yaml 4 returned undefined - and
  // that throw aborts the sync before any repo is processed.
  const settingsPath = path.join(root, env.CONFIG_PATH, env.SETTINGS_FILE_PATH)
  let settings
  try {
    settings = yaml.load(fs.readFileSync(settingsPath, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return fail(`${settingsPath} is missing.`)
    return fail(`${settingsPath} could not be parsed:\n  ${e.message.split('\n')[0]}`,
      'A file containing only comments counts as empty under js-yaml 5. Add an\n' +
      'explicit "{}" to make it a valid empty mapping.')
  }

  const reposDir = path.join(root, env.CONFIG_PATH, 'repos')
  let repoFiles = []
  try {
    repoFiles = fs.readdirSync(reposDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return fail(`${reposDir} does not exist, so there are no per-repo configs to apply.`)
  }
  if (repoFiles.length === 0) {
    console.warn(`Warning: ${reposDir} contains no .yml files - nothing to apply.`)
  }

  const shared = settings && Object.keys(settings).length > 0
  console.log(`Local config: ${root} (${repoFiles.length} repo config(s), ` +
    `shared settings: ${shared ? 'yes' : 'none'})`)
}

async function performFullSync (appFn, nop) {
  validateLocalConfig()

  const probot = createProbot()
  await probot.auth()
  probot.log.info(`Starting full sync with NOP=${nop}`)

  try {
    const app = appFn(probot, {})
    const settings = await app.syncInstallation(nop)

    // Results are only collected in NOP mode - appendToResults() in
    // lib/settings.js returns early when this.nop is false, and diffable.js
    // only pushes NopCommands under the same condition. So an empty results
    // array in apply mode means nothing was recorded, NOT that nothing changed.
    // Reporting "No changes detected" there would be actively misleading.
    if (!nop) {
      console.log('\nApplied. safe-settings does not collect a result set when ' +
        'writing, so what changed is in the [Plugin] log lines above.')
    } else if (settings && settings.results) {
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
