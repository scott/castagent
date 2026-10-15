import {expect} from 'chai'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const workflowPath = path.join(root, '.github/workflows/auto-changeset.yml')
const scriptPath = path.join(root, '.github/scripts/create-changeset.cjs')

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function runScripts(workflow: string): string[] {
  const lines = workflow.split('\n')
  const scripts: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const indent = match[1].length
    const inline = match[2]
    if (inline && inline !== '|' && inline !== '|-') {
      scripts.push(inline.trim())
      continue
    }
    const block: string[] = []
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor]
      if (line.trim() === '') {
        block.push('')
        continue
      }
      const lineIndent = /^(\s*)/.exec(line)![1].length
      if (lineIndent <= indent) break
      block.push(line.trim())
    }
    scripts.push(block.join('\n').trim())
  }
  return scripts
}

function callExport(name: string, input: unknown): unknown {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const mod = require(process.env.CHANGESET_SCRIPT)',
        'let raw = ""',
        'process.stdin.setEncoding("utf8")',
        'process.stdin.on("data", chunk => { raw += chunk })',
        'process.stdin.on("end", () => {',
        '  const value = mod[process.env.CHANGESET_EXPORT](JSON.parse(raw))',
        '  process.stdout.write(JSON.stringify(value))',
        '})',
      ].join('\n'),
    ],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: {
        CHANGESET_SCRIPT: scriptPath,
        CHANGESET_EXPORT: name,
      },
    },
  )
  expect(result.status, result.stderr).to.equal(0)
  return JSON.parse(result.stdout)
}

function runScript(options: {cwd: string, env: NodeJS.ProcessEnv}): Promise<{status: number | null, stdout: string, stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {cwd: options.cwd, env: options.env})
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', status => resolve({status, stdout, stderr}))
  })
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not bind a port'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

describe('auto-changeset workflow injection', () => {
  const workflow = read(workflowPath)
  const script = read(scriptPath)

  it('keeps run scripts free of workflow expressions', () => {
    const scripts = runScripts(workflow)
    expect(scripts).to.deep.equal([
      [
        'git config --local user.email "github-actions[bot]@users.noreply.github.com"',
        'git config --local user.name "github-actions[bot]"',
      ].join('\n'),
      'node .github/scripts/create-changeset.cjs',
    ])
    for (const block of scripts) {
      expect(block).to.not.include('${{')
      expect(block).to.not.include('github.event')
      expect(block).to.not.include('steps.')
      expect(block).to.not.include('<<')
    }
  })

  it('passes the commit message and token through the environment only', () => {
    const messageLines = workflow.split('\n').filter(line => line.includes('github.event.head_commit.message'))
    expect(messageLines.map(line => line.trim())).to.deep.equal([
      "if: startsWith(github.event.head_commit.message, 'Merge pull request #')",
      'COMMIT_MESSAGE: ${{ github.event.head_commit.message }}',
    ])
    expect(workflow).to.include('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(workflow).to.include('PUSH_CHANGESET: "1"')
    expect(workflow).to.not.include('steps.pr.outputs')
    expect(workflow).to.not.include('steps.notes.outputs')
    expect(workflow).to.not.include('steps.pr-info.outputs')
    expect(workflow).to.not.include('CHANGESET_EOF')
    expect(workflow).to.not.include('echo "title=')
    expect(workflow).to.not.include('echo "body=')
    expect(workflow).to.not.include('echo "notes=')
  })

  it('does not shell out from the changeset writer except through git argument arrays', () => {
    expect(script).to.include("require('node:child_process')")
    expect(script).to.include('execFileSync')
    expect(script).to.not.match(/(^|[^.\w])exec(Sync)?\s*\(/)
    expect(script).to.not.match(/(^|[^.\w])spawn(Sync)?\s*\(/)
    expect(script).to.not.match(/shell\s*:\s*true/)
    expect(script).to.include('appendFileSync(env.GITHUB_OUTPUT, `number=${prNumber}\\n`)')
    expect(script).to.not.include('github.event')
    expect(script).to.not.include('${{')
  })

  it('reads only the numeric pull request id from a hostile merge message', () => {
    const sentinel = path.join(os.tmpdir(), `cast-pr-num-${process.pid}`)
    const payload = `$(: > ${sentinel})`
    const number = callExport(
      'pullRequestNumber',
      `Merge pull request #245 from eve/${payload}\n\n${payload}\nMerge pull request #999`,
    )
    expect(number).to.equal('245')
    expect(fs.existsSync(sentinel)).to.equal(false)
    expect(() => callExport('pullRequestNumber', payload)).to.throw()
  })

  it('keeps legacy version and note rules without executing the text', () => {
    expect(callExport('versionFromPullRequest', {
      title: 'fix: $(id)',
      labels: ['major', 'breaking'],
    })).to.equal('patch')
    expect(callExport('versionFromPullRequest', {
      title: 'Update parser',
      labels: ['feature'],
    })).to.equal('minor')
    expect(callExport('versionFromPullRequest', {
      title: 'BREAKING CHANGE: remove flag',
      labels: [],
    })).to.equal('major')
    expect(callExport('cleanTitle', '[skip ci] feat(scope): hello: world')).to.equal('world')
    expect(callExport('cleanTitle', 'Fix: Keep tokens')).to.equal('Keep tokens')

    const body = 'line1\nline2\nline3\nline4\nline5\nline6'
    expect(callExport('notesFromPullRequest', {title: 'unused: title', body})).to.equal(
      'line1 line2 line3 line4 line5 ',
    )
    expect(callExport('notesFromPullRequest', {
      title: '[area] feat: short',
      body: 'too short',
    })).to.equal('short')
  })

  it('writes hostile pull request fields as changeset data', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-changeset-'))
    const sentinel = path.join(work, 'sentinel')
    const payload = `$(: > ${sentinel})`
    const title = `feat: ${payload} \`: > ${sentinel}\` "; : > ${sentinel}; echo "`
    const body = `${payload}\nCHANGESET_EOF\n: > ${sentinel}\n${'x'.repeat(40)}`
    const author = `eve\n${payload}`
    let authorization = ''
    let requestUrl = ''

    const server = http.createServer((request, response) => {
      authorization = String(request.headers.authorization || '')
      requestUrl = request.url || ''
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({
        title,
        body,
        user: {login: author},
        labels: [{name: `feature ${payload}`}],
      }))
    })

    const oracle = spawnSync('/bin/sh', ['-c', payload], {encoding: 'utf8'})
    expect(oracle.status).to.equal(0)
    expect(fs.existsSync(sentinel)).to.equal(true)
    fs.rmSync(sentinel)

    const port = await listen(server)
    const output = path.join(work, 'github-output.txt')
    const message = [
      `Merge pull request #245 from eve/${payload}`,
      '',
      payload,
      'Merge pull request #999',
    ].join('\n')

    try {
      const result = await runScript({
        cwd: work,
        env: {
          COMMIT_MESSAGE: message,
          GH_TOKEN: 'ci-test-token',
          GITHUB_REPOSITORY: 'scott/castagent',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_OUTPUT: output,
          HOME: work,
          PATH: work,
        },
      })
      expect(result.status, result.stderr).to.equal(0)
      if (authorization !== 'Bearer ci-test-token') {
        throw new Error('Authorization header was not the test token')
      }
      expect(requestUrl).to.equal('/repos/scott/castagent/pulls/245')
      expect(fs.existsSync(sentinel)).to.equal(false)
      expect(read(output)).to.equal('number=245\n')

      const files = fs.readdirSync(path.join(work, '.changeset'))
      expect(files).to.have.length(1)
      expect(files[0]).to.match(/^[a-f0-9]{16}\.md$/)
      const markdown = read(path.join(work, '.changeset', files[0]))
      expect(markdown).to.include('"cast-cli": minor')
      expect(markdown).to.include('"cast-tui": minor')
      expect(markdown).to.include(payload)
      expect(markdown).to.include('CHANGESET_EOF')
      expect(markdown).to.include(`* PR #245: @eve${payload}`)
      expect(markdown.split('\n').some(line => line.startsWith('* PR #245:'))).to.equal(true)
      expect(result.stdout).to.include('created changeset for pull request #245 (minor)')
      expect(result.stdout).to.not.include('ci-test-token')
      expect(result.stderr).to.not.include('ci-test-token')
      expect(result.stdout).to.not.include(payload)
    } finally {
      await close(server)
      fs.rmSync(work, {recursive: true, force: true})
    }
  })

  it('still writes a changeset when pull request metadata cannot be fetched', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-changeset-'))
    let seen = false
    const server = http.createServer((_request, response) => {
      seen = true
      response.writeHead(500, {'content-type': 'text/plain'})
      response.end('nope $(id)')
    })
    const port = await listen(server)
    try {
      const result = await runScript({
        cwd: work,
        env: {
          COMMIT_MESSAGE: 'Merge pull request #7 from octo/branch',
          GH_TOKEN: 'ci-test-token',
          GITHUB_REPOSITORY: 'scott/castagent',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          HOME: work,
          PATH: work,
        },
      })
      expect(seen).to.equal(true)
      expect(result.status, result.stderr).to.equal(0)
      const files = fs.readdirSync(path.join(work, '.changeset'))
      const markdown = read(path.join(work, '.changeset', files[0]))
      expect(markdown).to.include('"cast-cli": patch')
      expect(markdown).to.include('* PR #7: @unknown')
      expect(markdown).to.not.include('$(id)')
      expect(result.stderr).to.include('pull request metadata unavailable')
      expect(result.stderr).to.not.include('ci-test-token')
    } finally {
      await close(server)
      fs.rmSync(work, {recursive: true, force: true})
    }
  })

  it('refuses a commit message that is not a merge commit', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-changeset-'))
    const sentinel = path.join(work, 'sentinel')
    const payload = `$(: > ${sentinel})`
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: work,
        encoding: 'utf8',
        env: {
          COMMIT_MESSAGE: payload,
          GH_TOKEN: 'ci-test-token',
          GITHUB_REPOSITORY: 'scott/castagent',
          HOME: work,
          PATH: work,
        },
      })
      expect(result.status).to.not.equal(0)
      expect(fs.existsSync(path.join(work, '.changeset'))).to.equal(false)
      expect(fs.existsSync(sentinel)).to.equal(false)
      expect(result.stderr).to.include('commit message is not a pull request merge')
      expect(result.stderr).to.not.include(payload)
      expect(result.stdout).to.not.include(payload)
    } finally {
      fs.rmSync(work, {recursive: true, force: true})
    }
  })

  it('invokes git with separate arguments and rejects a non-numeric pull request id', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-changeset-git-'))
    const log = path.join(work, 'git-args.log')
    const bin = path.join(work, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$GIT_ARGS_LOG"',
      'if [ "$1" = "diff" ]; then',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'), {mode: 0o755})

    const caller = spawnSync(
      process.execPath,
      [
        '-e',
        [
          'const mod = require(process.env.CHANGESET_SCRIPT)',
          'mod.commitAndPush(process.env.PR_NUMBER, process.env.WORK)',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          CHANGESET_SCRIPT: scriptPath,
          PR_NUMBER: '245',
          WORK: work,
          GIT_ARGS_LOG: log,
          PATH: bin,
          HOME: work,
        },
      },
    )
    expect(caller.status, caller.stderr).to.equal(0)
    expect(read(log).trim().split('\n')).to.deep.equal([
      'add',
      '.changeset/',
      'diff',
      '--staged',
      '--quiet',
      'commit',
      '-m',
      'chore: add changeset for PR #245',
      'push',
    ])

    const rejected = spawnSync(
      process.execPath,
      [
        '-e',
        [
          'const mod = require(process.env.CHANGESET_SCRIPT)',
          'mod.commitAndPush(process.env.PR_NUMBER, process.env.WORK)',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          CHANGESET_SCRIPT: scriptPath,
          PR_NUMBER: '245; touch sentinel',
          WORK: work,
          GIT_ARGS_LOG: log,
          PATH: bin,
          HOME: work,
        },
      },
    )
    expect(rejected.status).to.not.equal(0)
    expect(rejected.stderr).to.include('pull request number must be digits')
    expect(read(log)).to.not.include('touch')
    fs.rmSync(work, {recursive: true, force: true})
  })
})
