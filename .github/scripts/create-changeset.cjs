'use strict'
// @ts-check

/**
 * Create a changeset from a merged pull request without passing the pull
 * request title, body, or commit message through a shell.
 *
 * Callers pass COMMIT_MESSAGE and GH_TOKEN in the environment. Those values
 * stay data: this file reads them with process.env and writes the changeset
 * with fs. Git is invoked through execFileSync argument arrays.
 */

const {execFileSync} = require('node:child_process')
const {randomBytes} = require('node:crypto')
const {appendFileSync, mkdirSync, writeFileSync} = require('node:fs')
const {join} = require('node:path')

const MERGE_COMMIT = /^Merge pull request #(\d+)\b/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DIGITS = /^\d+$/
const CHANGESET_ID = /^[a-f0-9]{16}$/

/**
 * @param {string | undefined | null} message
 * @returns {string}
 */
function pullRequestNumber(message) {
  const firstLine = String(message ?? '').split(/\r?\n/, 1)[0]
  const match = MERGE_COMMIT.exec(firstLine)
  if (!match) {
    throw new Error('commit message is not a pull request merge')
  }
  return match[1]
}

/**
 * @param {string | undefined | null} text
 * @param {string} pattern
 * @returns {boolean}
 */
function anyLine(text, pattern) {
  const expression = new RegExp(pattern, 'i')
  return String(text ?? '').split(/\r?\n/).some(line => expression.test(line))
}

/**
 * @param {{title?: string, labels?: string[]}} pullRequest
 * @returns {'patch' | 'minor' | 'major'}
 */
function versionFromPullRequest(pullRequest) {
  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map(label => String(label)) : []
  const labelText = labels.join(',')
  /** @type {'patch' | 'minor' | 'major'} */
  let version = 'patch'
  if (anyLine(labelText, 'major|breaking')) {
    version = 'major'
  } else if (anyLine(labelText, 'minor|feature|enhancement')) {
    version = 'minor'
  } else if (anyLine(labelText, 'fix|bugfix|hotfix')) {
    version = 'patch'
  }

  const title = String(pullRequest.title ?? '')
  if (anyLine(title, '^feat|^feat:')) {
    version = 'minor'
  } else if (anyLine(title, '^fix|^fix:')) {
    version = 'patch'
  } else if (anyLine(title, '^BREAKING|^BREAKING CHANGE')) {
    version = 'major'
  }
  return version
}

/**
 * @param {string | undefined | null} title
 * @returns {string}
 */
function cleanTitle(title) {
  return String(title ?? '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\[.*\] /, '').replace(/^[a-z]*(.*): /, ''))
    .join('\n')
}

/**
 * @param {string} body
 * @returns {string}
 */
function notesFromBody(body) {
  const echoed = `${String(body)}\n`
  let newlines = 0
  let end = echoed.length
  for (let index = 0; index < echoed.length; index++) {
    if (echoed.charCodeAt(index) === 10) {
      newlines += 1
      if (newlines === 5) {
        end = index + 1
        break
      }
    }
  }
  return echoed.slice(0, end).split('\n').join(' ').slice(0, 200)
}

/**
 * @param {{title?: string, body?: string | null}} pullRequest
 * @returns {string}
 */
function notesFromPullRequest(pullRequest) {
  const body = String(pullRequest.body ?? '')
  if (body.length > 20) {
    return notesFromBody(body)
  }
  return cleanTitle(pullRequest.title)
}

/**
 * @param {{prNumber?: string, version?: string, author?: string, notes?: string | null}} input
 * @returns {string}
 */
function changesetDocument(input) {
  const prNumber = String(input.prNumber ?? '')
  if (!DIGITS.test(prNumber)) {
    throw new Error('pull request number must be digits')
  }
  if (input.version !== 'patch' && input.version !== 'minor' && input.version !== 'major') {
    throw new Error('invalid version bump')
  }
  const author = String(input.author ?? 'unknown').replace(/[\r\n]/g, '') || 'unknown'
  const notes = input.notes == null ? '' : String(input.notes)
  return [
    '---',
    `"cast-cli": ${input.version}`,
    `"cast-tui": ${input.version}`,
    '---',
    '',
    notes,
    '',
    `* PR #${prNumber}: @${author}`,
    '',
  ].join('\n')
}

/**
 * @param {string | undefined} apiBase
 * @param {string} repo
 * @param {string} prNumber
 * @returns {string}
 */
function apiUrl(apiBase, repo, prNumber) {
  const base = String(apiBase || 'https://api.github.com').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base) || /[\s\r\n]/.test(base)) {
    throw new Error('invalid api url')
  }
  if (!REPOSITORY.test(repo) || !DIGITS.test(prNumber)) {
    throw new Error('invalid pull request reference')
  }
  return `${base}/repos/${repo}/pulls/${prNumber}`
}

/**
 * @param {{apiBase?: string, repo: string, prNumber: string, token?: string, fetch: typeof fetch}} options
 * @returns {Promise<{title: string, body: string, author: string, labels: string[]}>}
 */
async function fetchPullRequest(options) {
  const url = apiUrl(options.apiBase, options.repo, options.prNumber)
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'castagent-auto-changeset',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }
  const response = await options.fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    throw new Error(`pull request request failed with status ${response.status}`)
  }
  const payload = await response.json()
  /** @type {Array<{name?: string}>} */
  const rawLabels = Array.isArray(payload.labels) ? payload.labels : []
  const labels = rawLabels.map(label => String(label && label.name != null ? label.name : ''))
  const login = payload.user && payload.user.login != null ? String(payload.user.login) : ''
  return {
    title: payload.title == null ? '' : String(payload.title),
    body: payload.body == null ? '' : String(payload.body),
    author: login || 'unknown',
    labels,
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{fetch?: typeof fetch, cwd?: string, randomBytes?: (size: number) => Buffer}} [deps]
 * @returns {Promise<{prNumber: string, version: string, filePath: string, markdown: string}>}
 */
async function createChangesetFromEnv(env, deps = {}) {
  const prNumber = pullRequestNumber(env.COMMIT_MESSAGE)
  const repo = String(env.GITHUB_REPOSITORY || '')
  if (!REPOSITORY.test(repo)) {
    throw new Error('invalid repository')
  }
  let pullRequest
  try {
    pullRequest = await fetchPullRequest({
      apiBase: env.GITHUB_API_URL,
      repo,
      prNumber,
      token: String(env.GH_TOKEN || ''),
      fetch: deps.fetch || globalThis.fetch,
    })
  } catch {
    console.error('pull request metadata unavailable, using an empty summary')
    pullRequest = {title: '', body: '', author: 'unknown', labels: []}
  }

  const version = versionFromPullRequest(pullRequest)
  const notes = notesFromPullRequest(pullRequest)
  const id = (deps.randomBytes ? deps.randomBytes(8) : randomBytes(8)).toString('hex')
  if (!CHANGESET_ID.test(id)) {
    throw new Error('invalid changeset id')
  }
  const markdown = changesetDocument({
    version,
    notes,
    prNumber,
    author: pullRequest.author,
  })
  const cwd = deps.cwd || process.cwd()
  const directory = join(cwd, '.changeset')
  mkdirSync(directory, {recursive: true})
  const filePath = join(directory, `${id}.md`)
  writeFileSync(filePath, markdown, {encoding: 'utf8', mode: 0o644})
  return {prNumber, version, filePath, markdown}
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {void}
 */
function git(args, cwd) {
  execFileSync('git', args, {cwd, stdio: 'inherit'})
}

/**
 * @param {string} prNumber
 * @param {string} [cwd]
 * @returns {void}
 */
function commitAndPush(prNumber, cwd = process.cwd()) {
  if (!DIGITS.test(String(prNumber))) {
    throw new Error('pull request number must be digits')
  }
  git(['add', '.changeset/'], cwd)
  let hasChanges = false
  try {
    execFileSync('git', ['diff', '--staged', '--quiet'], {cwd, stdio: 'ignore'})
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
    if (status === 1) {
      hasChanges = true
    } else {
      throw error
    }
  }
  if (!hasChanges) return
  git(['commit', '-m', `chore: add changeset for PR #${prNumber}`], cwd)
  git(['push'], cwd)
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} prNumber
 * @returns {void}
 */
function writeGithubOutput(env, prNumber) {
  if (!env.GITHUB_OUTPUT) return
  if (!DIGITS.test(String(prNumber))) {
    throw new Error('pull request number must be digits')
  }
  appendFileSync(env.GITHUB_OUTPUT, `number=${prNumber}\n`)
}

async function main() {
  const created = await createChangesetFromEnv(process.env)
  writeGithubOutput(process.env, created.prNumber)
  console.log(`created changeset for pull request #${created.prNumber} (${created.version})`)
  if (process.env.PUSH_CHANGESET === '1') {
    commitAndPush(created.prNumber)
  }
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'changeset creation failed'
    console.error(message.split('\n', 1)[0].slice(0, 300))
    process.exitCode = 1
  })
}

module.exports = {
  apiUrl,
  changesetDocument,
  cleanTitle,
  commitAndPush,
  createChangesetFromEnv,
  notesFromPullRequest,
  pullRequestNumber,
  versionFromPullRequest,
}
