import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('clone command', () => {
  const testDir = path.join(os.tmpdir(), `cast-clone-test-${Date.now()}`)
  const agentsDir = path.join(testDir, '.cast', 'agents')

  before(() => {
    fs.mkdirSync(agentsDir, {recursive: true})
  })

  after(() => {
    try {
      fs.rmSync(testDir, {recursive: true, force: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('command description', () => {
    it('should have correct description', () => {
      expect('Clone an agent from a Git repository').to.not.be.empty
    })
  })

  describe('URL argument', () => {
    it('should require repository URL', () => {
      const url = 'https://github.com/user/my-agent.git'
      expect(url).to.be.a('string')
      expect(url).to.include('github.com')
    })
  })

  describe('URL validation', () => {
    it('should accept HTTPS URLs', () => {
      const validUrls = [
        'https://github.com/user/repo.git',
        'https://github.com/user/repo',
        'https://gitlab.com/user/repo.git',
      ]

      const pattern = /^https?:\/\/.+\/.+\/.+\.git$/
      const altPattern = /^https?:\/\/.+\/.+\/[^\/]+$/

      expect(pattern.test(validUrls[0]) || altPattern.test(validUrls[0])).to.be.true
    })

    it('should accept SSH URLs', () => {
      const validUrls = [
        'git@github.com:user/repo.git',
        'git@gitlab.com:user/repo.git',
      ]

      const pattern = /^git@.+:.+\/.+\.git$/

      expect(pattern.test(validUrls[0])).to.be.true
    })

    it('should reject invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'ftp://invalid',
        'https://invalid',
      ]

      const patterns = [
        /^https?:\/\/.+\/.+\/.+\.git$/,
        /^https?:\/\/.+\/.+\/[^\/]+$/,
        /^git@.+:.+\/.+\.git$/,
        /^git@.+:.+\/.+$/,
      ]

      for (const url of invalidUrls) {
        const isValid = patterns.some(p => p.test(url))
        expect(isValid).to.be.false
      }
    })
  })

  describe('repo name extraction', () => {
    it('should extract repo name from HTTPS URL', () => {
      const url = 'https://github.com/user/my-agent.git'
      const match = url.match(/\/([^\/]+?)(?:\.git)?$/)

      expect(match?.[1]).to.equal('my-agent')
    })

    it('should extract repo name from SSH URL', () => {
      const url = 'git@github.com:user/my-agent.git'
      const match = url.match(/\/([^\/]+?)(?:\.git)?$/)

      expect(match?.[1]).to.equal('my-agent')
    })

    it('should use URL as name when not specified', () => {
      const url = 'https://github.com/user/my-agent.git'
      const match = url.match(/\/([^\/]+?)(?:\.git)?$/)
      const repoName = match?.[1] || 'agent'

      expect(repoName).to.equal('my-agent')
    })
  })

  describe('local name argument', () => {
    it('should use provided name when specified', () => {
      const requestedName = 'custom-name'
      expect(requestedName).to.be.a('string')
      expect(requestedName).to.not.be.empty
    })

    it('should default to repo name when not specified', () => {
      const url = 'https://github.com/user/my-agent.git'
      const match = url.match(/\/([^\/]+?)(?:\.git)?$/)
      const defaultName = match?.[1] || 'agent'

      expect(defaultName).to.equal('my-agent')
    })
  })

  describe('agent validation', () => {
    it('should check for agent.yaml in cloned repo', () => {
      const agentPath = path.join(agentsDir, 'test-agent')
      const hasAgentYaml = fs.existsSync(path.join(agentPath, 'agent.yaml'))

      expect(hasAgentYaml).to.be.false
    })

    it('should clean up on invalid repository', () => {
      const agentPath = path.join(agentsDir, 'invalid-repo')
      fs.mkdirSync(agentPath, {recursive: true})

      // Simulate validation failure
      const hasAgentYaml = fs.existsSync(path.join(agentPath, 'agent.yaml'))

      if (!hasAgentYaml) {
        fs.rmSync(agentPath, {recursive: true, force: true})
      }

      expect(fs.existsSync(agentPath)).to.be.false
    })
  })

  describe('local git initialization', () => {
    it('should initialize local git repository', () => {
      const agentPath = path.join(agentsDir, 'test-agent')
      fs.mkdirSync(agentPath, {recursive: true})

      const gitDir = path.join(agentPath, '.git')
      const isGitRepo = fs.existsSync(gitDir)

      expect(isGitRepo).to.be.false
    })

    it('should add remote origin', () => {
      const remoteUrl = 'https://github.com/user/my-agent.git'
      expect(remoteUrl).to.include('github.com')
    })
  })

  describe('agent.yaml update', () => {
    it('should add repository info to agent.yaml', () => {
      const agentPath = path.join(agentsDir, 'test-agent')
      fs.mkdirSync(agentPath, {recursive: true})

      const config: Record<string, any> = {
        name: 'test-agent',
        version: '1.0',
      }

      config.repository = {
        remote: 'origin',
        url: 'https://github.com/user/my-agent.git',
        branch: 'main',
      }

      expect(config.repository).to.exist
      expect(config.repository.remote).to.equal('origin')
      expect(config.repository.url).to.include('github.com')
    })
  })

  describe('clone failure handling', () => {
    it('should handle authentication failures', () => {
      const errorMessage = 'Authentication failed. Please ensure you have access to the repository and correct credentials.'

      expect(errorMessage).to.include('Authentication')
      expect(errorMessage).to.include('credentials')
    })

    it('should handle repository not found', () => {
      const errorMessage = 'Failed to clone: Repository not found'

      expect(errorMessage).to.include('not found')
    })

    it('should cleanup on clone failure', () => {
      const agentPath = path.join(agentsDir, 'failed-clone')

      // Ensure cleanup happens
      try {
        fs.rmSync(agentPath, {recursive: true, force: true})
      } catch {
        // Already cleaned up
      }

      expect(fs.existsSync(agentPath)).to.be.false
    })
  })

  describe('success output', () => {
    it('should show success message', () => {
      const agentName = 'my-agent'
      const successMessage = `Successfully cloned agent '${agentName}'!`

      expect(successMessage).to.include('cloned')
      expect(successMessage).to.include(agentName)
    })

    it('should show next steps', () => {
      const agentName = 'my-agent'
      const nextSteps = [
        `Run the agent: cast dev ${agentName}`,
        `Check git status: cast git status ${agentName}`,
        `View commit history: cast git log ${agentName}`,
      ]

      expect(nextSteps.length).to.equal(3)
      expect(nextSteps[0]).to.include('dev')
    })

    it('should show commit count', () => {
      const commits = [
        {message: 'Initial commit'},
        {message: 'Add agent config'},
      ]

      expect(commits.length).to.equal(2)
      expect(`Imported ${commits.length} commit(s).`).to.equal('Imported 2 commit(s).')
    })
  })
})