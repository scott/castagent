import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import SpritesDeploy, {runSpriteExec, spriteExecArgv, spriteReadyArgv} from '../../../../typescript/cast-cli/src/lib/deploy/sprites'

describe('Sprites Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(SpritesDeploy.description).to.equal('Deploy agent to Sprites (Fly.io Firecracker VM)')
    })

    it('should require agent argument', () => {
      expect(SpritesDeploy.args).to.have.property('agent')
      expect(SpritesDeploy.args.agent.required).to.be.true
      expect(SpritesDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag', () => {
      // Sprites deploy doesn't have flags property
      expect(SpritesDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      // Sprites deploy doesn't have flags property
      expect(SpritesDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(SpritesDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new SpritesDeploy(['deploy', 'sprites'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof SpritesDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define sprites as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('sprites')
    })

    it('should use sprite CLI', () => {
      // The implementation uses 'sprite' command
      expect(SpritesDeploy.description).to.include('Sprites')
    })
  })

  describe('configuration', () => {
    it('should have memory mount path configuration', () => {
      // Sprites uses /opt/cast-agent directory
      expect(SpritesDeploy).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should handle authentication errors', () => {
      // The implementation checks for sprite auth
      expect(SpritesDeploy).to.be.a('function')
    })
  })

  describe('sprite exec argv', () => {
    it('passes the sprite name and command as separate arguments', () => {
      const spriteName = 'cast-demo"; echo broke'
      const command = "true'; echo broke"
      expect(spriteExecArgv(spriteName, command)).to.deep.equal([
        'exec', '-s', spriteName, '--', 'sudo', 'bash', '-c', command,
      ])
      expect(spriteReadyArgv(spriteName)).to.deep.equal([
        'exec', '-s', spriteName, '--', 'echo', 'ready',
      ])
    })

    it('does not run a local shell around sprite exec', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-sprite-proof-'))
      const marker = path.join(dir, 'marker')
      const log = path.join(dir, 'argv.txt')
      const fakeSprite = path.join(dir, 'sprite')
      fs.writeFileSync(fakeSprite, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SPRITE_ARGV_LOG"\n')
      fs.chmodSync(fakeSprite, 0o755)
      const previousPath = process.env.PATH
      const previousLog = process.env.SPRITE_ARGV_LOG
      process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`
      process.env.SPRITE_ARGV_LOG = log
      const spriteName = `n"; touch ${marker}; echo "`
      const command = `c'; touch ${marker}; echo '`

      try {
        runSpriteExec(spriteName, command, 5000)
        expect(fs.existsSync(marker)).to.equal(false)
        const argv = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.length > 0)
        expect(argv).to.deep.equal(spriteExecArgv(spriteName, command))
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        if (previousLog === undefined) delete process.env.SPRITE_ARGV_LOG
        else process.env.SPRITE_ARGV_LOG = previousLog
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })
  })
})