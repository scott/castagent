import type {DeploymentProvider} from '../types'

export const localProvider: DeploymentProvider = {
  key: 'local',
  name: 'Local (no container)',
  description: 'Run the agent directly on this machine without Docker',
  toolChecks: [],
  async deploy(ctx) {
    ctx.log('Local deployment: Spawning agent in production mode...')
    ctx.log('Not yet implemented. Use --provider docker for now.')
  },
}
