import {expect} from 'chai'
import {execFileSync, spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import axios from 'axios'

import DigitalOceanDeploy, {
  VOLUME_MOUNT_MARKER,
  buildDigitalOceanVolumeMountScript,
  buildDropletRestartOnMemoryCommand,
  digitalOceanVolumeClient,
  DigitalOceanVolumeExistsError,
  ensureDropletContainerMemory,
  isDigitalOceanVolumeConflict,
  mountDigitalOceanMemoryVolume,
  parseDigitalOceanVolumeRecord,
  parseDropletMemoryBind,
  parseVolumeMountReport,
  planVolumeAttachment,
  prepareDigitalOceanMemoryVolume,
  remoteDockerRunCommand,
  volumeDetachClock,
  type DigitalOceanVolumeClient,
  type DigitalOceanVolumeRecord,
} from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {mountUpgradedDropletMemory} from '../../../../typescript/cast-cli/src/lib/deploy/upgrades'
import {recordPinnedHostKey} from '../../../../typescript/cast-cli/src/lib/deploy/ssh-hostkey'

const VOLUME_ID = '506f78a4-e098-11e5-ad9f-000f53306ae1'
const OTHER_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const VOLUME_NAME = 'cast-test-agent'
const TOKEN = 'super-secret-token'
const REPORT = [
  VOLUME_MOUNT_MARKER,
  'formatted=0',
  'filesystem=ext4',
  `uuid=${VOLUME_ID}`,
  `mount=/mnt/${VOLUME_NAME}`,
  'source=/dev/sda',
  '',
].join('\n')

function volume(dropletIds: number[], name = VOLUME_NAME): DigitalOceanVolumeRecord {
  return {id: VOLUME_ID, name, region: 'nyc3', dropletIds, filesystemType: ''}
}

describe('DigitalOcean memory volume mount', () => {
  describe('mount plan', () => {
    it('attaches only when this droplet does not already have the volume', () => {
      expect(planVolumeAttachment([42], 42)).to.equal('attached')
      expect(planVolumeAttachment([], 42)).to.equal('attach')
      expect(planVolumeAttachment([99], 42)).to.equal('foreign')
    })

    it('treats a taken name as an existing volume and not as a mounted path', () => {
      expect(isDigitalOceanVolumeConflict(409, {id: 'conflict', message: 'already in use'})).to.equal(true)
      expect(isDigitalOceanVolumeConflict(422, {id: 'invalid'})).to.equal(true)
      expect(isDigitalOceanVolumeConflict(422, {id: 'invalid', message: 'volume name already exists'})).to.equal(true)
      expect(isDigitalOceanVolumeConflict(422, {id: 'invalid', message: 'region is unavailable'})).to.equal(false)
      expect(isDigitalOceanVolumeConflict(500, {id: 'internal'})).to.equal(false)
    })

    it('parses a volume record and a successful mount report', () => {
      expect(parseDigitalOceanVolumeRecord({
        id: VOLUME_ID,
        name: VOLUME_NAME,
        region: {slug: 'nyc3'},
        droplet_ids: [42],
        filesystem_type: 'ext4',
      })).to.deep.equal({
        id: VOLUME_ID,
        name: VOLUME_NAME,
        region: 'nyc3',
        dropletIds: [42],
        filesystemType: 'ext4',
      })
      expect(parseDigitalOceanVolumeRecord({id: 'vol-123', name: VOLUME_NAME, region: 'nyc3'})).to.equal(null)
      const report = parseVolumeMountReport(`noise\n${REPORT}`)
      expect(report).to.deep.equal({
        formatted: false,
        filesystem: 'ext4',
        uuid: VOLUME_ID,
        mountPath: `/mnt/${VOLUME_NAME}`,
        source: '/dev/sda',
      })
      expect(() => parseVolumeMountReport('mounted nowhere')).to.throw(/did not report a mount/)
      expect(parseDropletMemoryBind('container=ok\n')).to.equal('ok')
      expect(() => parseDropletMemoryBind('container=absent\n')).to.throw(/not writing memory/)
      expect(() => parseDropletMemoryBind('container=missing\n')).to.throw(/not writing memory/)
    })

    it('restarts the container with the same docker run builder deploy uses', () => {
      const image = 'registry.digitalocean.com/cast-test-agent/agent:1.2.3'
      expect(buildDropletRestartOnMemoryCommand(VOLUME_NAME, image)).to.equal(
        remoteDockerRunCommand({volumeId: VOLUME_NAME, imageTag: image}),
      )
      expect(() => buildDropletRestartOnMemoryCommand(VOLUME_NAME, "cast'agent")).to.throw(/image name/)
      const script = buildDigitalOceanVolumeMountScript({volumeName: VOLUME_NAME})
      expect(script.startsWith('#!/bin/bash\nset -euo pipefail\n')).to.equal(true)
      expect(script).to.not.include('--target')
      expect(script).to.include('mkfs.ext4 -F ')
      expect(script).to.not.include('mkfs.ext4 -FF')
      expect(script).to.not.include('ssh-key')
    })

    it('mounts before the container starts and checks the container afterwards', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../../typescript/cast-cli/src/lib/deploy/digitalocean.ts'),
        'utf8',
      )
      const start = source.indexOf('const volumeSecrets')
      const end = source.indexOf('saveDeployment(agentName, \'digitalocean\'')
      const slice = source.slice(start, end)
      expect(slice.indexOf('createAndAttachVolume')).to.be.greaterThan(-1)
      expect(slice.indexOf('createAndAttachVolume')).to.be.lessThan(slice.indexOf('this.deployOnDroplet'))
      expect(slice.indexOf('Volume attached at')).to.be.lessThan(slice.indexOf('this.deployOnDroplet'))
      expect(slice.indexOf('verifyDropletContainerMemory')).to.be.greaterThan(slice.indexOf('this.deployOnDroplet'))
      expect(source).to.not.include('ssh-key delete')
    })
  })

  describe('remote mount script', () => {
    let root = ''

    afterEach(() => {
      if (root) fs.rmSync(root, {recursive: true, force: true})
      root = ''
    })

    function writeTool(bin: string, name: string, body: string): void {
      fs.writeFileSync(path.join(bin, name), body, {mode: 0o755})
    }

    function runScript(mode: 'empty' | 'ext4' | 'mounted' | 'other' | 'error' | 'signature', preexisting?: string): {
      status: number | null
      stdout: string
      stderr: string
      fstab: string
      notes: string
      formats: string
      mounts: string
      umounts: string
    } {
      if (root) fs.rmSync(root, {recursive: true, force: true})
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-vol-'))
      const bin = path.join(root, 'bin')
      const state = path.join(root, 'state')
      const mnt = path.join(root, 'mnt')
      const device = path.join(root, 'disk')
      const fstabPath = path.join(root, 'fstab')
      const hasFilesystem = mode === 'ext4' || mode === 'mounted' || mode === 'other'
      const startsMounted = mode === 'mounted' || mode === 'other'
      fs.mkdirSync(bin)
      fs.mkdirSync(state)
      fs.mkdirSync(mnt)
      fs.writeFileSync(device, '')
      fs.writeFileSync(path.join(state, 'formats'), '0')
      fs.writeFileSync(path.join(state, 'mounts'), '0')
      fs.writeFileSync(path.join(state, 'umounts'), '0')
      fs.writeFileSync(path.join(state, 'mounted'), startsMounted ? '1' : '0')
      fs.writeFileSync(path.join(state, 'type'), hasFilesystem ? 'ext4' : '')
      fs.writeFileSync(path.join(state, 'uuid'), hasFilesystem ? VOLUME_ID : '')
      fs.writeFileSync(path.join(state, 'mounted_uuid'), mode === 'mounted' ? VOLUME_ID : mode === 'other' ? OTHER_UUID : '')
      fs.writeFileSync(path.join(state, 'mounted_source'), mode === 'mounted' ? '/dev/sda' : mode === 'other' ? '/dev/sdz' : '')
      fs.writeFileSync(path.join(state, 'signature'), mode === 'signature' ? '1' : '0')
      fs.writeFileSync(path.join(state, 'probe'), mode === 'error' ? '1' : '0')
      fs.writeFileSync(fstabPath, '# keep me\nUUID=11111111-1111-1111-1111-111111111111 / ext4 defaults 0 1\n')
      if (preexisting !== undefined) fs.writeFileSync(path.join(mnt, 'notes.md'), preexisting)

      writeTool(bin, 'sleep', '#!/bin/bash\nexit 0\n')
      writeTool(bin, 'blkid', `#!/bin/bash
if [ "$(cat ${state}/probe)" = 1 ]; then exit 1; fi
if [[ "$*" == *TYPE* ]]; then
  type="$(cat ${state}/type)"
  if [ -z "$type" ]; then exit 2; fi
  printf '%s' "$type"
  exit 0
fi
uuid="$(cat ${state}/uuid)"
if [ -z "$uuid" ]; then exit 2; fi
printf '%s' "$uuid"
exit 0
`)
      writeTool(bin, 'wipefs', `#!/bin/bash
if [ "$(cat ${state}/signature)" = 1 ]; then
  printf 'disk 0x438 ext4 already-there\\n'
fi
exit 0
`)
      writeTool(bin, 'mkfs.ext4', `#!/bin/bash
if [ -n "$(cat ${state}/type)" ]; then
  echo 'refusing to format a volume that already has a filesystem' >&2
  exit 1
fi
printf 'ext4' > ${state}/type
printf '${VOLUME_ID}' > ${state}/uuid
printf '%s' "$(($(cat ${state}/formats) + 1))" > ${state}/formats
exit 0
`)
      writeTool(bin, 'findmnt', `#!/bin/bash
mode=""
output=""
path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target|--mountpoint) mode="$1"; path="$2"; shift 2 ;;
    -o) output="$2"; shift 2 ;;
    -n) shift ;;
    *) shift ;;
  esac
done
root_uuid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
root_source='/dev/vda1'
if [ "$path" = / ]; then
  if [ "$output" = UUID ]; then printf '%s' "$root_uuid"; fi
  if [ "$output" = SOURCE ]; then printf '%s' "$root_source"; fi
  exit 0
fi
mounted="$(cat ${state}/mounted)"
if [ "$mode" = --target ]; then
  if [ "$mounted" != 1 ] || [ "$path" != ${JSON.stringify(mnt)} ]; then
    if [ "$output" = UUID ]; then printf '%s' "$root_uuid"; fi
    if [ "$output" = SOURCE ]; then printf '%s' "$root_source"; fi
    exit 0
  fi
elif [ "$mounted" != 1 ] || [ "$path" != ${JSON.stringify(mnt)} ]; then
  exit 1
fi
if [ "$output" = UUID ]; then printf '%s' "$(cat ${state}/mounted_uuid)"; exit 0; fi
if [ "$output" = SOURCE ]; then printf '%s' "$(cat ${state}/mounted_source)"; exit 0; fi
exit 0
`)
      writeTool(bin, 'mount', `#!/bin/bash
if [ "$(cat ${state}/mounted)" = 1 ]; then
  echo 'mount: already mounted' >&2
  exit 1
fi
mkdir -p ${state}/hidden
shopt -s dotglob nullglob
for file in "$1"/*; do
  mv "$file" ${state}/hidden/
done
printf '1' > ${state}/mounted
cat ${state}/uuid > ${state}/mounted_uuid
printf '/dev/sda' > ${state}/mounted_source
printf '%s' "$(($(cat ${state}/mounts) + 1))" > ${state}/mounts
exit 0
`)
      writeTool(bin, 'umount', `#!/bin/bash
printf '%s' "$(($(cat ${state}/umounts) + 1))" > ${state}/umounts
if [ "$(cat ${state}/mounted)" != 1 ]; then
  echo "umount: $1: not mounted." >&2
  exit 1
fi
printf '0' > ${state}/mounted
printf '' > ${state}/mounted_uuid
exit 0
`)

      const script = buildDigitalOceanVolumeMountScript({
        volumeName: VOLUME_NAME,
        devicePath: device,
        mountPath: mnt,
        fstabPath,
      })
      const result = spawnSync('bash', ['-s'], {
        input: script,
        encoding: 'utf8',
        env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
      })
      const notesPath = path.join(mnt, 'notes.md')
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        fstab: fs.readFileSync(fstabPath, 'utf8'),
        notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '',
        formats: fs.readFileSync(path.join(state, 'formats'), 'utf8'),
        mounts: fs.readFileSync(path.join(state, 'mounts'), 'utf8'),
        umounts: fs.readFileSync(path.join(state, 'umounts'), 'utf8'),
      }
    }

    it('formats an empty mountpoint once and does not unmount the root filesystem', () => {
      const first = runScript('empty', 'remember this')
      expect(first.status, `${first.stderr}\n${first.stdout}`).to.equal(0)
      expect(first.formats).to.equal('1')
      expect(first.mounts).to.equal('1')
      expect(first.umounts).to.equal('0')
      expect(first.notes).to.equal('remember this')
      expect(first.fstab).to.include('# keep me')
      expect(first.fstab).to.include('UUID=11111111-1111-1111-1111-111111111111 / ext4 defaults 0 1')
      expect(first.fstab).to.include(`UUID=${VOLUME_ID} `)
      expect(first.fstab).to.include('ext4 defaults,nofail,discard 0 2')
      expect(first.fstab.match(new RegExp(VOLUME_ID, 'g'))).to.have.length(1)
      expect(first.stdout).to.include('formatted=1')
      expect(first.stdout).to.include(`uuid=${VOLUME_ID}`)
      expect(first.stderr).to.not.include('not mounted')
    })

    it('leaves a mountpoint that already has the volume UUID alone', () => {
      const mounted = runScript('mounted', 'already here')
      expect(mounted.status, mounted.stderr).to.equal(0)
      expect(mounted.formats).to.equal('0')
      expect(mounted.mounts).to.equal('0')
      expect(mounted.umounts).to.equal('0')
      expect(mounted.notes).to.equal('already here')
      expect(mounted.stdout).to.include('formatted=0')
      expect(mounted.fstab).to.include(`UUID=${VOLUME_ID} `)
      expect(mounted.fstab).to.include('defaults,nofail,discard 0 2')
    })

    it('mounts a volume that already has data without formatting it', () => {
      const existing = runScript('ext4', 'keep me')
      expect(existing.status, existing.stderr).to.equal(0)
      expect(existing.formats).to.equal('0')
      expect(existing.mounts).to.equal('1')
      expect(existing.umounts).to.equal('0')
      expect(existing.notes).to.equal('keep me')
      expect(existing.stdout).to.include('formatted=0')
      expect(existing.fstab).to.include('defaults,nofail,discard 0 2')
    })

    it('unmounts a different filesystem and still does not format the volume', () => {
      const other = runScript('other')
      expect(other.status, other.stderr).to.equal(0)
      expect(other.formats).to.equal('0')
      expect(other.umounts).to.equal('1')
      expect(other.mounts).to.equal('1')
      expect(other.stdout).to.include('formatted=0')
      expect(other.stdout).to.include(`uuid=${VOLUME_ID}`)
    })

    it('does not format a volume that already has a disk signature', () => {
      const signed = runScript('signature', 'keep me')
      expect(signed.status).to.not.equal(0)
      expect(signed.stderr).to.include('Refusing to format')
      expect(signed.formats).to.equal('0')
      expect(signed.mounts).to.equal('0')
      expect(signed.umounts).to.equal('0')
      expect(signed.notes).to.equal('keep me')
      expect(signed.fstab).to.not.include(VOLUME_ID)
    })

    it('refuses to format when the filesystem probe fails', () => {
      const failed = runScript('error')
      expect(failed.status).to.not.equal(0)
      expect(failed.stderr).to.include('Refusing to format')
      expect(failed.formats).to.equal('0')
      expect(failed.mounts).to.equal('0')
      expect(failed.umounts).to.equal('0')
    })
  })

  describe('prepare and attach', () => {
    function clockStub(): {now(): number; sleep(ms: number): Promise<void>; elapsed(): number} {
      const start = 1_000_000
      let now = start
      return {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms
        },
        elapsed: () => now - start,
      }
    }

    it('creates a volume without a filesystem hint, then waits for the attach', async () => {
      const calls: string[] = []
      let created = false
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          calls.push('list')
          return []
        },
        async createVolume(name, region) {
          calls.push(`create:${name}:${region}`)
          return volume([])
        },
        async attachVolumeAction(_volumeId, dropletId) {
          calls.push(`attach-action:${dropletId}`)
          return {actionId: '9', status: 'in-progress'}
        },
        async readAction() {
          calls.push('action')
          return 'completed'
        },
        async readVolume() {
          calls.push('read')
          return volume([42])
        },
        async dropletExists() {
          calls.push('droplet')
          return true
        },
      }
      const prepared = await prepareDigitalOceanMemoryVolume({
        client,
        volumeName: VOLUME_NAME,
        region: 'nyc3',
        dropletId: '42',
        onCreated: () => {
          created = true
        },
      })
      expect(created).to.equal(true)
      expect(prepared.created).to.equal(true)
      expect(prepared.volume.dropletIds).to.deep.equal([42])
      expect(calls).to.deep.equal([
        'list',
        `create:${VOLUME_NAME}:nyc3`,
        'attach-action:42',
        'action',
        'read',
      ])
    })

    it('reuses an existing volume and does not attach it again when this droplet has it', async () => {
      const calls: string[] = []
      let created = false
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          calls.push('list')
          return [volume([42])]
        },
        async createVolume() {
          calls.push('create')
          return volume([])
        },
        async attachVolumeAction() {
          calls.push('attach')
          return {actionId: '9', status: 'completed'}
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          calls.push('read')
          return volume([42])
        },
        async dropletExists() {
          return true
        },
      }
      const prepared = await prepareDigitalOceanMemoryVolume({
        client,
        volumeName: VOLUME_NAME,
        region: 'nyc3',
        dropletId: '42',
        onCreated: () => {
          created = true
        },
      })
      expect(prepared.created).to.equal(false)
      expect(created).to.equal(false)
      expect(calls).to.deep.equal(['list'])
    })

    it('lists the volume once when create reports the name is already taken', async () => {
      let lists = 0
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          lists += 1
          return []
        },
        async createVolume() {
          throw new DigitalOceanVolumeExistsError(VOLUME_NAME, 'nyc3')
        },
        async attachVolumeAction() {
          throw new Error('should not attach')
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          return volume([42])
        },
        async dropletExists() {
          return false
        },
      }
      try {
        await prepareDigitalOceanMemoryVolume({
          client,
          volumeName: VOLUME_NAME,
          region: 'nyc3',
          dropletId: '42',
        })
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('already exists')
        expect(message).to.include('not in the volume list')
        expect(message).to.not.include(TOKEN)
      }
      expect(lists).to.equal(1)
    })

    it('refuses to detach a volume from a different live droplet', async () => {
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([99])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          throw new Error('should not attach')
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          return volume([99])
        },
        async dropletExists(dropletId) {
          expect(dropletId).to.equal(99)
          return true
        },
      }
      try {
        await prepareDigitalOceanMemoryVolume({
          client,
          volumeName: VOLUME_NAME,
          region: 'nyc3',
          dropletId: '42',
        })
        expect.fail('should have refused')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('attached to droplet 99')
        expect(message).to.include('Refusing to detach')
      }
    })

    it('attaches a volume whose previous droplet is gone', async () => {
      const clock = clockStub()
      const calls: string[] = []
      let reads = 0
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([99])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          calls.push('attach-action')
          return {actionId: '9', status: 'completed'}
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          reads += 1
          if (reads === 1) return volume([99])
          if (reads === 2) return volume([])
          return volume([42])
        },
        async dropletExists() {
          return false
        },
      }
      const logs: string[] = []
      const prepared = await prepareDigitalOceanMemoryVolume({
        client,
        volumeName: VOLUME_NAME,
        region: 'nyc3',
        dropletId: '42',
        clock,
        log: message => logs.push(message),
      })
      expect(prepared.volume.dropletIds).to.deep.equal([42])
      expect(calls).to.deep.equal(['attach-action'])
      expect(logs.some(line => line.includes('Waiting for memory volume'))).to.equal(true)
      expect(clock.elapsed()).to.be.greaterThan(0)
    })

    it('fails when the attach action errors', async () => {
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          return {actionId: '9', status: 'in-progress'}
        },
        async readAction() {
          return 'errored'
        },
        async readVolume() {
          return volume([])
        },
        async dropletExists() {
          return false
        },
      }
      try {
        await prepareDigitalOceanMemoryVolume({
          client,
          volumeName: VOLUME_NAME,
          region: 'nyc3',
          dropletId: '42',
        })
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('failed to attach')
      }
    })

    it('times out a volume action without sleeping in real time', async () => {
      const clock = clockStub()
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          return {actionId: '9', status: 'in-progress'}
        },
        async readAction() {
          return 'in-progress'
        },
        async readVolume() {
          return volume([])
        },
        async dropletExists() {
          return false
        },
      }
      try {
        await prepareDigitalOceanMemoryVolume({
          client,
          volumeName: VOLUME_NAME,
          region: 'nyc3',
          dropletId: '42',
          clock,
        })
        expect.fail('should have timed out')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('Timed out waiting')
      }
      expect(clock.elapsed()).to.be.greaterThan(0)
    })

    it('waits out a lagging droplet id after the attach action has completed', async () => {
      const clock = clockStub()
      let reads = 0
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          return {actionId: '9', status: 'completed'}
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          reads += 1
          if (reads < 4) return volume([])
          return volume([42])
        },
        async dropletExists() {
          return false
        },
      }
      const prepared = await prepareDigitalOceanMemoryVolume({
        client,
        volumeName: VOLUME_NAME,
        region: 'nyc3',
        dropletId: '42',
        clock,
      })
      expect(prepared.volume.dropletIds).to.deep.equal([42])
      expect(reads).to.equal(4)
      expect(clock.elapsed()).to.equal(14_000)
    })

    it('says how long it waited when the volume never lists the new droplet', async () => {
      const clock = clockStub()
      let reads = 0
      const client: DigitalOceanVolumeClient = {
        async listVolumes() {
          return [volume([])]
        },
        async createVolume() {
          throw new Error('should not create')
        },
        async attachVolumeAction() {
          return {actionId: '9', status: 'completed'}
        },
        async readAction() {
          return 'completed'
        },
        async readVolume() {
          reads += 1
          return volume([])
        },
        async dropletExists() {
          return false
        },
      }
      try {
        await prepareDigitalOceanMemoryVolume({
          client,
          volumeName: VOLUME_NAME,
          region: 'nyc3',
          dropletId: '42',
          clock,
        })
        expect.fail('should have timed out')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.equal(`Memory volume '${VOLUME_NAME}' did not attach to droplet 42 after 60 seconds.`)
      }
      expect(reads).to.be.greaterThan(1)
      expect(clock.elapsed()).to.equal(60_000)
    })
  })

  describe('volume API client', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('creates a 1 GB volume with no filesystem field and keeps the token out of errors', async () => {
      const post = sandbox.stub(axios, 'post').callsFake(async (url: string, body?: unknown) => {
        expect(String(url)).to.equal('https://api.digitalocean.com/v2/volumes')
        expect(body).to.deep.equal({name: VOLUME_NAME, size_gigabytes: 1, region: 'nyc3'})
        expect(JSON.stringify(body)).to.not.include('filesystem')
        return {data: {volume: {id: VOLUME_ID, name: VOLUME_NAME, region: {slug: 'nyc3'}, droplet_ids: []}}}
      })
      const client = digitalOceanVolumeClient(TOKEN)
      const created = await client.createVolume(VOLUME_NAME, 'nyc3')
      expect(created.id).to.equal(VOLUME_ID)
      const headers = post.firstCall.args[2] as {headers: {Authorization: string}}
      expect(headers.headers.Authorization).to.equal(`Bearer ${TOKEN}`)

      post.resetBehavior()
      post.callsFake(async () => {
        const error = new Error('Request failed with status code 500') as Error & {
          isAxiosError: boolean
          response: {status: number; data: {message: string}}
          config: {headers: {Authorization: string}}
        }
        error.isAxiosError = true
        error.response = {status: 500, data: {message: 'region is unavailable'}}
        error.config = {headers: {Authorization: `Bearer ${TOKEN}`}}
        throw error
      })
      try {
        await client.createVolume(VOLUME_NAME, 'nyc3')
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('region is unavailable')
        expect(message).to.not.include(TOKEN)
      }
    })

    it('turns a conflict into an existing-volume error', async () => {
      sandbox.stub(axios, 'post').callsFake(async () => {
        const error = new Error('Request failed with status code 409') as Error & {
          isAxiosError: boolean
          response: {status: number; data: {id: string; message: string}}
        }
        error.isAxiosError = true
        error.response = {status: 409, data: {id: 'conflict', message: `name ${VOLUME_NAME} already in use`}}
        throw error
      })
      const client = digitalOceanVolumeClient(TOKEN)
      try {
        await client.createVolume(VOLUME_NAME, 'nyc3')
        expect.fail('should have existed')
      } catch (error) {
        expect(error).to.be.instanceOf(DigitalOceanVolumeExistsError)
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.not.include(TOKEN)
      }
    })
  })

  describe('droplet SSH mount', () => {
    let sandbox: sinon.SinonSandbox
    let sshDir = ''
    let pinnedPublicKey = ''

    before(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-vol-pin-'))
      try {
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k'), '-C', 'test'])
        pinnedPublicKey = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    })

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-vol-ssh-'))
      process.env.CAST_SSH_DIR = sshDir
      recordPinnedHostKey('203.0.113.1', pinnedPublicKey)
    })

    afterEach(() => {
      sandbox.restore()
      delete process.env.CAST_SSH_DIR
      if (sshDir) fs.rmSync(sshDir, {recursive: true, force: true})
      sshDir = ''
    })

    function stubSsh(handler: (remote: string) => {stdout: string; stderr: string; exitCode: number}) {
      return sandbox.stub(deployUtils, 'execCommand').callsFake(async (command: string, args?: string[]) => {
        expect(command).to.equal('ssh')
        const remote = (args || [])[(args || []).length - 1] || ''
        expect(remote).to.not.include(TOKEN)
        expect(remote).to.not.include('ssh-key')
        expect((args || []).join(' ')).to.include('StrictHostKeyChecking=yes')
        return handler(remote)
      })
    }

    it('stops the container, mounts, and fails when the mount script does not succeed', async () => {
      const commands: string[] = []
      stubSsh(remote => {
        commands.push(remote)
        if (remote.includes('docker rm')) return {stdout: '', stderr: '', exitCode: 0}
        return {stdout: '', stderr: 'Memory volume is not mounted at /mnt/cast-test-agent.', exitCode: 1}
      })
      try {
        await mountDigitalOceanMemoryVolume('203.0.113.1', VOLUME_NAME, [TOKEN])
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('not mounted')
        expect(message).to.not.include(TOKEN)
      }
      expect(commands[0]).to.include('docker rm -f cast-agent')
      expect(commands.some(command => command.includes("docker' 'run'"))).to.equal(false)
    })

    it('restarts an existing container onto the mounted volume', async () => {
      const commands: string[] = []
      let verified = false
      stubSsh(remote => {
        commands.push(remote)
        if (remote.includes('stat -c %d')) {
          if (!verified) {
            verified = true
            return {stdout: '', stderr: 'Agent container is not writing memory at /mnt/cast-test-agent.', exitCode: 1}
          }
          return {stdout: 'container=ok\n', stderr: '', exitCode: 0}
        }
        if (remote.includes('docker inspect')) return {stdout: 'cast-test-agent:latest\n', stderr: '', exitCode: 0}
        if (remote.includes('docker rm')) return {stdout: '', stderr: '', exitCode: 0}
        if (remote.includes(VOLUME_MOUNT_MARKER)) return {stdout: REPORT, stderr: '', exitCode: 0}
        if (remote.includes("'docker'") && remote.includes("'run'")) return {stdout: 'cid\n', stderr: '', exitCode: 0}
        return {stdout: '', stderr: `unexpected ${remote}`, exitCode: 1}
      })
      await ensureDropletContainerMemory('203.0.113.1', VOLUME_NAME, [TOKEN])
      expect(commands[0]).to.include('stat -c %d')
      expect(commands[1]).to.include('docker inspect')
      expect(commands[2]).to.include('docker rm -f cast-agent')
      expect(commands[3]).to.include('mkfs.ext4')
      expect(commands[3]).to.include('nofail')
      const run = commands.find(command => command.includes("'docker'") && command.includes("'run'"))
      expect(run).to.include("'/mnt/cast-test-agent:/app/agent/memory'")
      expect(run).to.include("'--env-file'")
      expect(run).to.not.include(TOKEN)
      expect(commands[commands.length - 1]).to.include('/app/agent/memory')
    })

    it('does not restart a container that is already writing to the mounted volume', async () => {
      const commands: string[] = []
      stubSsh(remote => {
        commands.push(remote)
        if (remote.includes('stat -c %d')) return {stdout: 'container=ok\n', stderr: '', exitCode: 0}
        if (remote.includes(VOLUME_MOUNT_MARKER)) return {stdout: REPORT, stderr: '', exitCode: 0}
        return {stdout: '', stderr: 'should not restart the container', exitCode: 1}
      })
      await ensureDropletContainerMemory('203.0.113.1', VOLUME_NAME, [TOKEN])
      expect(commands.some(command => command.includes('docker rm'))).to.equal(false)
      expect(commands.some(command => command.includes("'run'"))).to.equal(false)
      expect(commands.some(command => command.includes('nofail'))).to.equal(true)
    })

    it('fails when the droplet has no agent container to restart', async () => {
      const commands: string[] = []
      stubSsh(remote => {
        commands.push(remote)
        if (remote.includes('docker inspect')) return {stdout: '\n', stderr: '', exitCode: 0}
        if (remote.includes('docker rm')) return {stdout: '', stderr: '', exitCode: 0}
        if (remote.includes(VOLUME_MOUNT_MARKER)) return {stdout: REPORT, stderr: '', exitCode: 0}
        return {stdout: '', stderr: 'should not start a container', exitCode: 1}
      })
      try {
        await ensureDropletContainerMemory('203.0.113.1', VOLUME_NAME, [TOKEN])
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('not on the droplet')
        expect(message).to.not.include(TOKEN)
      }
      expect(commands.some(command => command.includes("'run'"))).to.equal(false)
      expect(commands.some(command => command.includes('docker rm'))).to.equal(false)
    })

    it('checks upgrade SSH commands against the api token, auth token, and inference secret', async () => {
      let apiToken = 'do-api-token-not-in-argv'
      let authToken = 'auth-token-not-in-argv'
      let inferenceValue = 'inference-token-not-in-argv'
      sandbox.stub(deployUtils, 'resolveDeploymentAuthToken').callsFake(async () => authToken)
      sandbox.stub(deployUtils, 'readAgentModel').returns('openrouter/test')
      sandbox.stub(deployUtils, 'inferenceEnv').resolves({OPENROUTER_API_KEY: inferenceValue})
      sandbox.stub(deployUtils, 'filterInferenceEnv').callsFake(() => ({OPENROUTER_API_KEY: inferenceValue}))
      const commands: string[] = []
      stubSsh(remote => {
        commands.push(remote)
        expect(remote).to.not.include(apiToken)
        expect(remote).to.not.include(authToken)
        expect(remote).to.not.include(inferenceValue)
        if (remote.includes('stat -c %d')) return {stdout: 'container=ok\n', stderr: '', exitCode: 0}
        if (remote.includes(VOLUME_MOUNT_MARKER)) return {stdout: REPORT, stderr: '', exitCode: 0}
        return {stdout: '', stderr: '', exitCode: 0}
      })
      const deployment = {agent_name: 'test-agent', id: 'abc123', auth_token_hash: 'hash'}
      await mountUpgradedDropletMemory('203.0.113.1', '/tmp/cast-agent', VOLUME_NAME, apiToken, deployment)
      expect(commands.some(command => command.includes('stat -c %d'))).to.equal(true)
      expect(commands.join('\n')).to.not.include(apiToken)
      expect(commands.join('\n')).to.not.include(authToken)
      expect(commands.join('\n')).to.not.include(inferenceValue)

      const leaks = [
        () => { apiToken = 'cast-agent' },
        () => { apiToken = 'do-api-token-not-in-argv'; authToken = 'cast-agent' },
        () => { authToken = 'auth-token-not-in-argv'; inferenceValue = 'cast-agent' },
      ]
      for (const leak of leaks) {
        leak()
        try {
          await mountUpgradedDropletMemory('203.0.113.1', '/tmp/cast-agent', VOLUME_NAME, apiToken, deployment)
          expect.fail('secret was not checked')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          expect(message).to.include('Refusing to place a secret')
        }
      }
    })

    it('mounts through the deploy helper and does not claim success when the mount fails', async () => {
      const instance = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as never)
      const logs: string[] = []
      sandbox.stub(instance, 'log').callsFake((message?: string) => {
        logs.push(String(message ?? ''))
        return instance
      })
      const post = sandbox.stub(axios, 'post')
      const get = sandbox.stub(axios, 'get')
      get.callsFake(async (url: string) => {
        const target = String(url)
        if (target.includes('/actions/')) return {data: {action: {id: 9, status: 'completed'}}}
        if (/\/volumes\/[^/]+$/.test(target)) {
          return {data: {volume: {id: VOLUME_ID, name: VOLUME_NAME, region: {slug: 'nyc3'}, droplet_ids: [42]}}}
        }
        return {data: {volumes: []}}
      })
      post.callsFake(async (url: string, body?: unknown) => {
        const target = String(url)
        if (target.endsWith('/volumes')) {
          expect(body).to.deep.equal({name: VOLUME_NAME, size_gigabytes: 1, region: 'nyc3'})
          expect(JSON.stringify(body)).to.not.include('filesystem')
          return {data: {volume: {id: VOLUME_ID, name: VOLUME_NAME, region: {slug: 'nyc3'}, droplet_ids: []}}}
        }
        return {data: {action: {id: 9, status: 'in-progress'}}}
      })
      const commands: string[] = []
      stubSsh(remote => {
        commands.push(remote)
        if (remote.includes('docker rm')) return {stdout: '', stderr: '', exitCode: 0}
        return {stdout: '', stderr: 'Memory volume is not mounted at /mnt/cast-test-agent.', exitCode: 1}
      })
      let created = false
      try {
        await (instance as unknown as {
          createAndAttachVolume: (...args: unknown[]) => Promise<unknown>
        }).createAndAttachVolume(TOKEN, '42', '203.0.113.1', VOLUME_NAME, 'nyc3', [TOKEN], () => {
          created = true
        })
        expect.fail('should have failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).to.include('not mounted')
        expect(message).to.not.include(TOKEN)
      }
      expect(created).to.equal(true)
      expect(logs).to.include(`Creating memory volume: ${VOLUME_NAME}`)
      expect(logs.some(line => line.includes('Volume attached at'))).to.equal(false)
      expect(commands.some(command => command.includes('ssh-key'))).to.equal(false)
      expect(post.called).to.equal(true)
    })

    it('reuses a volume the API already has and returns the mount only after the script succeeds', async () => {
      const instance = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as never)
      const logs: string[] = []
      sandbox.stub(instance, 'log').callsFake((message?: string) => {
        logs.push(String(message ?? ''))
        return instance
      })
      sandbox.stub(axios, 'post').rejects(new Error('should not create or attach'))
      sandbox.stub(axios, 'get').callsFake(async (url: string) => {
        const target = String(url)
        expect(target).to.not.include(TOKEN)
        if (target.endsWith('/volumes')) {
          return {data: {volumes: [{id: VOLUME_ID, name: VOLUME_NAME, region: {slug: 'nyc3'}, droplet_ids: [42]}]}}
        }
        throw new Error(`unexpected ${target}`)
      })
      stubSsh(remote => {
        if (remote.includes('docker rm')) return {stdout: '', stderr: '', exitCode: 0}
        if (remote.includes(VOLUME_MOUNT_MARKER)) return {stdout: REPORT, stderr: '', exitCode: 0}
        return {stdout: '', stderr: remote, exitCode: 1}
      })
      let created = false
      const result = await (instance as unknown as {
        createAndAttachVolume: (...args: unknown[]) => Promise<{mountPath: string; created: boolean}>
      }).createAndAttachVolume(TOKEN, '42', '203.0.113.1', VOLUME_NAME, 'nyc3', [TOKEN], () => {
        created = true
      })
      expect(result).to.deep.equal({mountPath: `/mnt/${VOLUME_NAME}`, created: false})
      expect(created).to.equal(false)
      expect(logs).to.include(`Reusing memory volume: ${VOLUME_NAME}`)
    })
  })

  describe('detach clock export', () => {
    it('is the same clock shutdown uses', () => {
      expect(typeof volumeDetachClock.now).to.equal('function')
      expect(typeof volumeDetachClock.sleep).to.equal('function')
    })
  })
})
