export interface DeploymentProviderChoice {
  key: string
  name: string
  desc: string
}

export const DEPLOYMENT_PROVIDERS: DeploymentProviderChoice[] = [
  {key: 'railway', name: 'Railway', desc: 'Managed containers with automatic deployments'},
  {key: 'fly', name: 'Fly.io', desc: 'Distributed containers close to your users'},
  {key: 'digitalocean', name: 'DigitalOcean', desc: 'Droplet with Docker container hosting'},
  {key: 'microvm', name: 'DigitalOcean MicroVM', desc: 'Firecracker microVM in MKC1. Pauses when idle, resumes on the next request.'},
  {key: 'sprites', name: 'Sprites', desc: 'Persistent Firecracker VMs on Fly.io'},
  {key: 'docker', name: 'Docker (local)', desc: 'Self-hosted Docker container on this machine'},
  {key: 'local', name: 'Local (no container)', desc: 'Run the agent directly without Docker'},
]

/** Map a number key to a provider index. 1 selects the first entry. */
export function providerIndexForNumberKey(keyName: string | undefined, count = DEPLOYMENT_PROVIDERS.length): number | null {
  if (!keyName || !/^[0-9]+$/.test(keyName)) return null
  const num = parseInt(keyName, 10)
  if (num < 1 || num > count) return null
  return num - 1
}
