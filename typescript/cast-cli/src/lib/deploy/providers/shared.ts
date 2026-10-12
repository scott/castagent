/** Lines logged by the interactive DigitalOcean token walkthrough (droplets and MicroVMs). */
export const DIGITALOCEAN_TOKEN_HELP = [
  '',
  '─────────────────────────────────────────────────────────────',
  '  DigitalOcean API Token Required',
  '─────────────────────────────────────────────────────────────',
  '',
  'You need a DigitalOcean API token to deploy.',
  '',
  'Get your token:',
  '  1. Visit https://cloud.digitalocean.com/account/api/tokens',
  '  2. Click "Generate New Token"',
  '  3. Give it a name (e.g., "cast-deploy")',
  '  4. Copy the token',
  '',
  'Then set it via one of these methods:',
  '  export DIGITALOCEAN_ACCESS_TOKEN=<your-token>',
  '  # or add to ~/.cast/config.yaml:',
  '  providers:',
  '    digitalocean:',
  '      token: ${DIGITALOCEAN_ACCESS_TOKEN}',
  '',
]

export const DIGITALOCEAN_ENV_VARS = [
  'DIGITALOCEAN_ACCESS_TOKEN',
  'DIGITALOCEAN_API_TOKEN',
  'DIGITALOCEAN_API_KEY',
]

export const DOCTL_RECHECK_HELP = [
  '',
  '─────────────────────────────────────────────────────────────',
  '  doctl CLI Required',
  '─────────────────────────────────────────────────────────────',
  '',
  'You need the doctl CLI to deploy to DigitalOcean.',
  '',
  'Install it:',
  '  brew install doctl',
  '  # or visit: https://docs.digitalocean.com/reference/doctl/how-to/install/',
  '',
  'Then authenticate:',
  '  doctl auth init',
  '',
]

export const DOCTL_CLI = {
  command: 'doctl',
  installUrl: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
  interactiveRecheckError: 'doctl is required for DigitalOcean deployment.',
  interactiveRecheckHelp: DOCTL_RECHECK_HELP,
}

export const DIGITALOCEAN_AUTH = {
  command: 'doctl auth init',
  envVars: DIGITALOCEAN_ENV_VARS,
  configKey: 'providers.digitalocean.token',
  tokenHelp: DIGITALOCEAN_TOKEN_HELP,
  tokenConfirm: 'Have you set your DigitalOcean API token and are ready to continue?',
}
