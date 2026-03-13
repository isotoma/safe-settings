require('dotenv').config()
const { createProbot } = require('probot')
const yaml = require('js-yaml')

const REPO_FIELDS = [
  'name', 'description', 'homepage', 'private', 'visibility',
  'has_issues', 'has_projects', 'has_wiki', 'has_downloads',
  'default_branch', 'allow_squash_merge', 'allow_merge_commit', 'allow_rebase_merge',
  'allow_auto_merge', 'delete_branch_on_merge', 'allow_update_branch',
  'squash_merge_commit_title', 'squash_merge_commit_message',
  'merge_commit_title', 'merge_commit_message',
  'web_commit_signoff_required'
]

async function exportSettings (owner, repoName) {
  const probot = createProbot()
  const appGithub = await probot.auth()

  const installations = await appGithub.paginate(
    appGithub.apps.listInstallations.endpoint.merge({ per_page: 100 })
  )
  const installation = installations.find(i => i.account.login === owner)
  if (!installation) {
    console.error(`No installation found for org/user: ${owner}`)
    process.exit(1)
  }

  const github = await probot.auth(installation.id)
  const repo = { owner, repo: repoName }

  const result = {}

  // --- Repository settings ---
  const repoData = (await github.repos.get(repo)).data
  result.repository = {}
  for (const field of REPO_FIELDS) {
    if (repoData[field] !== undefined) {
      result.repository[field] = repoData[field]
    }
  }

  // Topics are a separate API
  try {
    const topics = (await github.repos.getAllTopics(repo)).data.names
    if (topics && topics.length > 0) {
      result.repository.topics = topics
    }
  } catch (e) { /* ignore */ }

  // --- Collaborators (direct only, not team members) ---
  try {
    const collaborators = await github.paginate(
      github.repos.listCollaborators,
      { ...repo, affiliation: 'direct' }
    )
    if (collaborators.length > 0) {
      result.collaborators = collaborators.map(u => ({
        username: u.login,
        permission: (u.permissions.admin && 'admin') ||
          (u.permissions.maintain && 'maintain') ||
          (u.permissions.push && 'push') ||
          (u.permissions.triage && 'triage') ||
          'pull'
      }))
    }
  } catch (e) { /* ignore */ }

  // --- Teams ---
  try {
    const teams = await github.paginate(github.repos.listTeams, repo)
    if (teams.length > 0) {
      result.teams = teams.map(t => ({ name: t.slug, permission: t.permission }))
    }
  } catch (e) { /* ignore */ }

  // --- Classic branch protection ---
  try {
    const defaultBranch = repoData.default_branch
    const protection = (await github.repos.getBranchProtection({ ...repo, branch: defaultBranch })).data

    const bp = {}

    if (protection.required_status_checks) {
      bp.required_status_checks = {
        strict: protection.required_status_checks.strict,
        checks: (protection.required_status_checks.checks || []).map(c => `${c.context}`)
      }
    } else {
      bp.required_status_checks = null
    }

    bp.enforce_admins = protection.enforce_admins ? protection.enforce_admins.enabled : null

    if (protection.required_pull_request_reviews) {
      const rpr = protection.required_pull_request_reviews
      bp.required_pull_request_reviews = {
        required_approving_review_count: rpr.required_approving_review_count,
        dismiss_stale_reviews: rpr.dismiss_stale_reviews,
        require_code_owner_reviews: rpr.require_code_owner_reviews,
        require_last_push_approval: rpr.require_last_push_approval || false
      }
      if (rpr.dismissal_restrictions) {
        bp.required_pull_request_reviews.dismissal_restrictions = {
          users: (rpr.dismissal_restrictions.users || []).map(u => u.login),
          teams: (rpr.dismissal_restrictions.teams || []).map(t => t.slug)
        }
      }
      if (rpr.bypass_pull_request_allowances) {
        bp.required_pull_request_reviews.bypass_pull_request_allowances = {
          users: (rpr.bypass_pull_request_allowances.users || []).map(u => u.login),
          teams: (rpr.bypass_pull_request_allowances.teams || []).map(t => t.slug),
          apps: (rpr.bypass_pull_request_allowances.apps || []).map(a => a.slug)
        }
      }
    } else {
      bp.required_pull_request_reviews = null
    }

    if (protection.restrictions) {
      bp.restrictions = {
        users: (protection.restrictions.users || []).map(u => u.login),
        teams: (protection.restrictions.teams || []).map(t => t.slug),
        apps: (protection.restrictions.apps || []).map(a => a.slug)
      }
    } else {
      bp.restrictions = null
    }

    if (protection.required_linear_history) bp.required_linear_history = protection.required_linear_history.enabled
    if (protection.allow_force_pushes) bp.allow_force_pushes = protection.allow_force_pushes.enabled
    if (protection.allow_deletions) bp.allow_deletions = protection.allow_deletions.enabled
    if (protection.block_creations) bp.block_creations = protection.block_creations.enabled
    if (protection.required_conversation_resolution) bp.required_conversation_resolution = protection.required_conversation_resolution.enabled
    if (protection.lock_branch) bp.lock_branch = protection.lock_branch.enabled
    if (protection.allow_fork_syncing) bp.allow_fork_syncing = protection.allow_fork_syncing.enabled

    // required_signatures is a separate API call
    try {
      const sig = (await github.repos.getCommitSignatureProtection({ ...repo, branch: defaultBranch })).data
      bp.required_signatures = sig.enabled
    } catch (e) { /* ignore */ }

    result.branches = [{ name: 'default', protection: bp }]
  } catch (e) {
    if (e.status !== 404) console.error('Error fetching branch protection:', e.message)
  }

  // --- Rulesets ---
  try {
    const rulesetList = await github.paginate(
      github.request.endpoint.merge('GET /repos/{owner}/{repo}/rulesets', {
        owner,
        repo: repoName,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' }
      })
    )
    const repoRulesets = rulesetList.filter(r => r.source_type === 'Repository')

    if (repoRulesets.length > 0) {
      result.rulesets = await Promise.all(repoRulesets.map(async r => {
        const full = (await github.request('GET /repos/{owner}/{repo}/rulesets/{id}', {
          owner,
          repo: repoName,
          id: r.id,
          headers: { 'X-GitHub-Api-Version': '2022-11-28' }
        })).data

        const rs = { name: full.name, target: full.target, enforcement: full.enforcement }

        if (full.bypass_actors && full.bypass_actors.length > 0) {
          rs.bypass_actors = full.bypass_actors.map(a => ({
            actor_id: a.actor_id,
            actor_type: a.actor_type,
            bypass_mode: a.bypass_mode
          }))
        }

        if (full.conditions) {
          rs.conditions = {}
          if (full.conditions.ref_name) {
            rs.conditions.ref_name = {
              include: full.conditions.ref_name.include || [],
              exclude: full.conditions.ref_name.exclude || []
            }
          }
        }

        if (full.rules && full.rules.length > 0) {
          rs.rules = full.rules.map(rule => {
            const r = { type: rule.type }
            if (rule.parameters && Object.keys(rule.parameters).length > 0) {
              r.parameters = rule.parameters
            }
            return r
          })
        }

        return rs
      }))
    }
  } catch (e) {
    if (e.status !== 404) console.error('Error fetching rulesets:', e.message)
  }

  // --- Labels ---
  try {
    const labels = await github.paginate(github.issues.listLabelsForRepo, repo)
    if (labels.length > 0) {
      result.labels = labels.map(l => ({
        name: l.name,
        color: l.color,
        ...(l.description ? { description: l.description } : {})
      }))
    }
  } catch (e) { /* ignore */ }

  // --- Autolinks ---
  try {
    const autolinks = await github.paginate(github.repos.listAutolinks, repo)
    if (autolinks.length > 0) {
      result.autolinks = autolinks.map(a => ({
        key_prefix: a.key_prefix,
        url_template: a.url_template,
        is_alphanumeric: a.is_alphanumeric
      }))
    }
  } catch (e) { /* ignore */ }

  console.log(yaml.dump(result, { lineWidth: 120, noRefs: true }))
}

const [owner, repoName] = (process.argv[2] || '').split('/')
if (!owner || !repoName) {
  console.error('Usage: node export-settings.js <owner>/<repo>')
  process.exit(1)
}

exportSettings(owner, repoName).catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
