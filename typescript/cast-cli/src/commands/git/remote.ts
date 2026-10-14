import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'
import {spawn} from 'child_process'
import {isMap, isScalar, parseDocument, parse as parseYaml, stringify as stringifyYaml, type YAMLMap} from 'yaml'

type RemoteSubcommand = 'add' | 'create' | 'list' | 'remove' | 'set-url'

export default class GitRemote extends Command {
  static description = 'Manage Git remotes for an agent'

  static examples = [
    '<%= config.bin %> git remote my-agent list',
    '<%= config.bin %> git remote my-agent add origin https://github.com/user/repo.git',
    '<%= config.bin %> git remote my-agent set-url origin https://github.com/user/repo.git',
    '<%= config.bin %> git remote my-agent create origin',
    '<%= config.bin %> git remote my-agent remove origin',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
    action: Args.string({description: 'Action: add, create, list, remove, set-url', required: true}),
    name: Args.string({description: 'Remote name (e.g., origin)', required: false}),
    url: Args.string({description: 'Remote URL (for add and set-url)', required: false}),
  }

  static flags = {
    visibility: Flags.string({
      description: 'Repository visibility for create (private/public)',
      default: 'private',
      options: ['private', 'public'],
    }),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  private checkGhInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('gh', ['--version'], {stdio: 'ignore'} as any)
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })
  }

  private async checkGhAuthenticated(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('gh', ['auth', 'status'], {stdio: ['ignore', 'pipe', 'pipe']} as any)
      let output = ''
      proc.stdout?.on('data', (data: Buffer) => { output += data.toString() })
      proc.stderr?.on('data', (data: Buffer) => { output += data.toString() })
      proc.on('close', (code: number | null) => {
        resolve(code === 0 && output.includes('Logged in'))
      })
    }) as Promise<boolean>
  }

  private loadAgentConfig(agentPath: string): any {
    const configPath = path.join(agentPath, 'agent.yaml')
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      return parseYaml(content) || {}
    }
    return {}
  }

  private updateAgentYaml(agentPath: string, url: string): void {
    const configPath = path.join(agentPath, 'agent.yaml')
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, this.appendRepositoryBlock('', url))
      return
    }

    const content = fs.readFileSync(configPath, 'utf-8')
    fs.writeFileSync(configPath, this.agentYamlWithRepositoryUrl(content, url))
  }

  // Set repository.url in place. Reprinting the whole document reflows
  // folded text, quote style, and list indentation.
  private agentYamlWithRepositoryUrl(content: string, url: string): string {
    const doc = parseDocument(content, {keepSourceTokens: true})
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      if (content.trim().length === 0 && doc.errors.length === 0) {
        return this.appendRepositoryBlock('', url)
      }
      return this.rewriteRepositoryUrl(content, url)
    }

    const repository = doc.get('repository', true)
    if (isMap(repository)) {
      const urlNode = repository.get('url', true)
      if (isScalar(urlNode) && urlNode.range) {
        return this.replaceUrlScalar(content, urlNode.range, url, urlNode.type)
      }
      if (urlNode !== undefined) return this.rewriteRepositoryUrl(content, url)
      return this.insertRepositoryUrl(content, repository, url)
    }

    if (isScalar(repository) && repository.value == null && repository.range) {
      return this.insertUrlLineAfter(content, repository.range[0], url)
    }

    if (repository === undefined) return this.appendRepositoryBlock(content, url)
    return this.rewriteRepositoryUrl(content, url)
  }

  private replaceUrlScalar(
    content: string,
    range: readonly [number, number, number],
    url: string,
    style?: string,
  ): string {
    const existing = content.slice(range[0], range[1])
    let encoded = this.yamlUrlScalar(url, style)
    if (existing.length === 0 && content[range[0] - 1] === ':') encoded = ` ${encoded}`
    if (existing.endsWith('\n') && !encoded.endsWith('\n')) {
      encoded += existing.endsWith('\r\n') ? '\r\n' : '\n'
    }
    return content.slice(0, range[0]) + encoded + content.slice(range[1])
  }

  private insertRepositoryUrl(content: string, repository: YAMLMap, url: string): string {
    if (!repository.range) return this.rewriteRepositoryUrl(content, url)

    if (repository.srcToken?.type === 'flow-collection') {
      const end = repository.range[1] - 1
      if (content[end] !== '}') return this.rewriteRepositoryUrl(content, url)
      const scalar = this.yamlUrlScalar(url)
      const inside = content.slice(repository.range[0] + 1, end).trim()
      const insertion = inside.length === 0
        ? `url: ${scalar}`
        : inside.endsWith(',')
          ? ` url: ${scalar}`
          : `, url: ${scalar}`
      return content.slice(0, end) + insertion + content.slice(end)
    }

    const indent = this.repositoryKeyIndent(repository)
    const at = repository.range[2]
    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const line = `${' '.repeat(indent)}url: ${this.yamlUrlScalar(url)}${newline}`
    const needsLeading = at > 0 && content[at - 1] !== '\n'
    return content.slice(0, at) + (needsLeading ? newline : '') + line + content.slice(at)
  }

  private repositoryKeyIndent(repository: YAMLMap): number {
    const firstKey = repository.items[0]?.key
    const token = isScalar(firstKey) ? firstKey.srcToken : undefined
    if (token && 'indent' in token && typeof token.indent === 'number' && token.indent >= 1) {
      return token.indent
    }
    return 2
  }

  private insertUrlLineAfter(content: string, index: number, url: string): string {
    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const line = `  url: ${this.yamlUrlScalar(url)}${newline}`
    const lineEnd = content.indexOf('\n', index)
    if (lineEnd === -1) {
      const base = content.length === 0 || content.endsWith('\n') ? content : `${content}${newline}`
      return `${base}${line}`
    }
    return content.slice(0, lineEnd + 1) + line + content.slice(lineEnd + 1)
  }

  private appendRepositoryBlock(content: string, url: string): string {
    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const block = `repository:${newline}  url: ${this.yamlUrlScalar(url)}${newline}`
    if (content.length === 0) return block
    const base = content.endsWith('\n') ? content : `${content}${newline}`
    return base + block
  }

  private rewriteRepositoryUrl(content: string, url: string): string {
    const parsed = parseYaml(content)
    const config: Record<string, any> =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    if (!config.repository || typeof config.repository !== 'object' || Array.isArray(config.repository)) {
      config.repository = {}
    }
    config.repository.url = url
    return stringifyYaml(config)
  }

  private yamlUrlScalar(url: string, style?: string): string {
    if (style === 'QUOTE_DOUBLE') return JSON.stringify(url)
    if (style === 'QUOTE_SINGLE') return `'${url.replace(/'/g, "''")}'`
    if (this.isPlainYamlScalar(url)) return url
    return JSON.stringify(url)
  }

  private isPlainYamlScalar(value: string): boolean {
    if (value.length === 0 || value !== value.trim() || /[\n\r\t]/.test(value)) return false
    if (/^(?:~|\?|:|\*|\&|!|%|@|`|>|\||\[|\]|\{|\}|,|'|"|#|-)/.test(value)) return false
    if (value.includes(': ') || value.includes(' #') || value.includes('#')) return false
    return true
  }

  // gh records https or ssh, sometimes with .git or embedded credentials.
  // agent.yaml stores the https URL without userinfo or a .git suffix.
  private httpsRepositoryUrl(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim()
    const scp = /^git@([^:\s]+):(.+)$/.exec(trimmed)
    if (scp) return this.httpsRepo(scp[1], scp[2])

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed)
        if (!parsed.hostname) return null
        return this.httpsRepo(parsed.hostname, parsed.pathname)
      } catch {
        return null
      }
    }
    return null
  }

  private httpsRepo(host: string, repoPath: string): string | null {
    let pathPart = repoPath.replace(/^\/+/, '')
    while (pathPart.endsWith('/')) pathPart = pathPart.slice(0, -1)
    if (pathPart.toLowerCase().endsWith('.git')) pathPart = pathPart.slice(0, -4)
    if (!host || !pathPart || /\s/.test(pathPart)) return null
    return `https://${host}/${pathPart}`
  }

  // The GitHub owner is whoever gh created the repo for, not the local
  // login. Prefer the remote gh just added. Fall back to `gh api user`.
  private async repositoryUrlAfterCreate(
    git: SimpleGit,
    remoteName: string,
    agentName: string,
  ): Promise<string | null> {
    // Read the URL gh stored. `git remote -v` applies insteadOf rules and can
    // hide the owner behind a credential helper URL.
    if (/^[A-Za-z0-9._-]+$/.test(remoteName)) {
      try {
        const remoteUrl = (await git.raw(['config', '--local', '--get', `remote.${remoteName}.url`])).trim()
        if (remoteUrl) {
          const parsed = this.httpsRepositoryUrl(remoteUrl)
          if (parsed) return parsed
        }
      } catch {
        // The remote may be missing. The login lookup below still names the owner.
      }
    }

    try {
      const result = await this.captureGh(['api', 'user', '--jq', '.login'])
      const login = result.stdout.trim()
      if (result.code === 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)) {
        const repoName = /^[A-Za-z0-9._-]+$/.test(agentName) ? agentName : encodeURIComponent(agentName)
        return `https://github.com/${login}/${repoName}`
      }
    } catch {
      return null
    }
    return null
  }

  private captureGh(args: string[]): Promise<{code: number | null; stdout: string; stderr: string}> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gh', args, {stdio: ['ignore', 'pipe', 'pipe']})
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('error', (err: Error) => reject(err))
      proc.on('close', (code: number | null) => resolve({code, stdout, stderr}))
    })
  }

  private async finishCreate(
    git: SimpleGit,
    agentPath: string,
    name: string,
    agentName: string,
  ): Promise<void> {
    const url = await this.repositoryUrlAfterCreate(git, name, agentName)
    if (!url) {
      throw new Error('Could not determine the GitHub repository URL. repository.url was left unchanged.')
    }
    this.updateAgentYaml(agentPath, url)
    this.log('')
    this.log(`GitHub repository created and remote '${name}' added!`)
  }

  private async listRemotes(git: SimpleGit, agentName: string): Promise<void> {
    const remotes = await git.getRemotes(true)

    if (remotes.length === 0) {
      this.log(`No remotes configured for '${agentName}'.`)
      this.log('')
      this.log('Add a remote:')
      this.log(`  cast git remote ${agentName} add origin <url>`)
      return
    }

    this.log(`Remotes for '${agentName}':`)
    this.log('')
    for (const remote of remotes) {
      this.log(`  ${remote.name}`)
      this.log(`    Fetch: ${(remote as any).refs?.fetch || 'N/A'}`)
      if ((remote as any).refs?.push) {
        this.log(`    Push:  ${(remote as any).refs.push}`)
      }
    }
  }

  private async addRemote(git: SimpleGit, name: string, url: string, agentPath: string): Promise<void> {
    const remotes = await git.getRemotes()
    if (remotes.some(r => r.name === name)) {
      this.error(`Remote '${name}' already exists. Use 'remove' to delete it first, or use 'set-url' to update it.`)
    }

    await git.addRemote(name, url)
    this.updateAgentYaml(agentPath, url)

    this.log(`Added remote '${name}' → ${url}`)
  }

  private async createRemoteGh(
    git: SimpleGit,
    agentPath: string,
    name: string,
    visibility: string
  ): Promise<void> {
    const agentName = path.basename(agentPath)
    const config = this.loadAgentConfig(agentPath)
    const description = config.description || `${agentName} - Created with Cast`

    const ghInstalled = await this.checkGhInstalled()
    if (!ghInstalled) {
      this.error(
        `GitHub CLI (gh) is not installed.\n` +
        `Install it from: https://cli.github.com/\n` +
        `Or manually add a remote with:\n` +
        `  cast git remote ${agentName} add ${name} <url>`
      )
    }

    const authenticated = await this.checkGhAuthenticated()
    if (!authenticated) {
      this.error(
        `Not authenticated with GitHub.\n` +
        `Run 'gh auth login' first, then try again.`
      )
    }

    this.log('Creating GitHub repository...')

    return new Promise((resolve, reject) => {
      const args = [
        'repo', 'create', agentName,
        '--source', agentPath,
        '--push',
        '--description', description,
        '--remote', name,
      ]

      if (visibility === 'public') {
        args.push('--public')
      } else {
        args.push('--private')
      }

      const proc = spawn('gh', args, {stdio: 'inherit'})

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`gh repo create failed with exit code ${code}`))
          return
        }
        this.finishCreate(git, agentPath, name, agentName).then(resolve, reject)
      })

      proc.on('error', (err: Error) => {
        reject(err)
      })
    }) as Promise<void>
  }

  // Match URLs written by `add` and `create`. A trailing slash, a `.git`
  // suffix, or credentials embedded in an https remote still name the
  // same repository.
  private normalizeRemoteUrl(url: string): string {
    let normalized = url.trim()
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    if (normalized.toLowerCase().endsWith('.git')) {
      normalized = normalized.slice(0, -4)
    }

    if (/^https?:\/\//i.test(normalized)) {
      try {
        const parsed = new URL(normalized)
        parsed.username = ''
        parsed.password = ''
        normalized = parsed.toString()
        while (normalized.endsWith('/')) {
          normalized = normalized.slice(0, -1)
        }
      } catch {
        return normalized
      }
    }

    return normalized
  }

  private sameRemoteUrl(left: string, right: string): boolean {
    const normalizedLeft = this.normalizeRemoteUrl(left)
    const normalizedRight = this.normalizeRemoteUrl(right)
    return normalizedLeft.length > 0 && normalizedLeft === normalizedRight
  }

  private remoteUrls(remote: {refs?: {fetch?: string; push?: string}}): string[] {
    const urls = [remote.refs?.fetch, remote.refs?.push]
    return urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
  }

  // Drop repository.url when it points at the remote being removed and no
  // remaining remote still serves that URL. Leave the rest of agent.yaml
  // alone, including repository.remote and repository.branch.
  private repositoryYamlWithoutStaleUrl(
    agentPath: string,
    removedUrls: string[],
    remaining: Array<{refs?: {fetch?: string; push?: string}}>,
  ): string | null {
    const configPath = path.join(agentPath, 'agent.yaml')
    if (!fs.existsSync(configPath) || removedUrls.length === 0) return null

    const content = fs.readFileSync(configPath, 'utf-8')
    const doc = parseDocument(content)
    if (!isMap(doc.contents)) return null

    const repository = doc.contents.get('repository')
    if (!isMap(repository)) return null

    const urlNode = repository.get('url', true)
    if (!isScalar(urlNode)) return null
    const currentUrl: unknown = urlNode.value
    if (typeof currentUrl !== 'string') return null
    if (!removedUrls.some(url => this.sameRemoteUrl(currentUrl, url))) return null

    const stillUsed = remaining.some(remote =>
      this.remoteUrls(remote).some(url => this.sameRemoteUrl(currentUrl, url)),
    )
    if (stillUsed) return null

    repository.delete('url')
    return doc.toString()
  }

  private async removeRemote(git: SimpleGit, name: string, agentPath: string): Promise<void> {
    const remotes = await git.getRemotes(true)
    const target = remotes.find(remote => remote.name === name)
    if (!target) {
      this.error(`Remote '${name}' does not exist.`)
      return
    }

    const removedUrls = this.remoteUrls(target)
    const remaining = remotes.filter(remote => remote.name !== name)
    const nextYaml = this.repositoryYamlWithoutStaleUrl(agentPath, removedUrls, remaining)

    await git.removeRemote(name)
    if (nextYaml !== null) {
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), nextYaml)
    }
    this.log(`Removed remote '${name}'.`)
  }

  private async setRemoteUrl(git: SimpleGit, name: string, url: string, agentPath: string): Promise<void> {
    const remotes = await git.getRemotes()
    if (!remotes.some(r => r.name === name)) {
      this.error(`Remote '${name}' does not exist. Use 'add' to create it.`)
    }

    await git.remote(['set-url', name, url])
    this.updateAgentYaml(agentPath, url)

    this.log(`Updated remote '${name}' → ${url}`)
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(GitRemote)
    const agentName = args.agent
    const action = args.action as RemoteSubcommand
    const remoteName = args.name
    const remoteUrl = args.url

    const agentsDir = this.getAgentsDir()
    const agentPath = path.join(agentsDir, agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    if (!this.isGitRepo(agentPath)) {
      this.error(`'${agentName}' is not a Git repository. Run 'cast git init ${agentName}' first.`)
    }

    const git: SimpleGit = simpleGit(agentPath)

    try {
      switch (action) {
        case 'list': {
          await this.listRemotes(git, agentName)
          break
        }

        case 'add': {
          if (!remoteName) {
            this.error("Remote name required. Usage: cast git remote <agent> add <name> <url>")
          }
          if (!remoteUrl) {
            this.error("Remote URL required. Usage: cast git remote <agent> add <name> <url>")
          }
          await this.addRemote(git, remoteName, remoteUrl, agentPath)
          break
        }

        case 'create': {
          const name = remoteName || 'origin'
          await this.createRemoteGh(git, agentPath, name, flags.visibility)
          break
        }

        case 'remove': {
          if (!remoteName) {
            this.error("Remote name required. Usage: cast git remote <agent> remove <name>")
          }
          await this.removeRemote(git, remoteName, agentPath)
          break
        }

        case 'set-url': {
          if (!remoteName) {
            this.error("Remote name required. Usage: cast git remote <agent> set-url <name> <url>")
          }
          if (!remoteUrl) {
            this.error("Remote URL required. Usage: cast git remote <agent> set-url <name> <url>")
          }
          await this.setRemoteUrl(git, remoteName, remoteUrl, agentPath)
          break
        }

        default: {
          this.error(`Unknown action '${action}'. Use: list, add, create, remove, set-url`)
        }
      }
    } catch (error: any) {
      if (error?.oclif) throw error
      this.error(`Failed: ${error.message}`)
    }
  }
}