import type {DeploymentProvider} from '../types'

export const localProvider: DeploymentProvider = {
  key: 'local',
  name: 'Local (no container)',
  description: 'Run the agent directly on this machine without Docker',
  toolChecks: [],
  async deploy(ctx) {
    // A normal return is a successful deploy. The command then prints
    // "Deployed <agent> with deployment SHA" and exits 0. This provider
    // does not register a row, so connect would not find that SHA. Fail here.
    ctx.error('Not yet implemented. Use --provider docker for now.')
  },
}
