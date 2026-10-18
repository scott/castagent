import {execCommand, isShaPattern} from './deploy/deploy-utils'
import {flyAppName, flyStatusArgs} from './deploy/fly'
import {db} from './sqlite'

const AGENT_NAME = /^[a-zA-Z0-9-]+$/

export interface StatusDeployment {
  id: string
  agent_name: string
  provider: string
  deployment_url: string
  deployed_version?: string | null
}

export interface StatusCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface StatusResult {
  status: 'ok' | 'error'
  text: string
}

export interface DeploymentStatusDeps {
  getDeploymentBySha: (id: string) => StatusDeployment | undefined | null
  listDeployments: (agentName: string) => StatusDeployment[]
  flyStatus: (appName: string) => Promise<StatusCommandResult>
}

export function defaultDeploymentStatusDeps(): DeploymentStatusDeps {
  return {
    getDeploymentBySha: (id) => db.getDeploymentBySha(id) ?? null,
    listDeployments: (agentName) => db.listDeployments(agentName),
    flyStatus: (appName) => execCommand('flyctl', flyStatusArgs(appName), {
      silent: true,
      shell: false,
      timeoutMs: 30_000,
    }),
  }
}

function chooseDeployment(
  rows: StatusDeployment[],
  label: string,
): {kind: 'none'} | {kind: 'one'; row: StatusDeployment} | {kind: 'ambiguous'; text: string} {
  if (rows.length === 0) return {kind: 'none'}
  const unique = new Set(rows.map(row => `${row.provider}|${row.deployment_url}`))
  if (unique.size === 1) return {kind: 'one', row: rows[0]}
  const shaList = rows.map(row => row.id).join(', ')
  return {
    kind: 'ambiguous',
    text: `Multiple deployments found for '${label}'. Use SHA: ${shaList}`,
  }
}

function registrySummary(deployment: StatusDeployment): string {
  const lines = [
    `Agent: ${deployment.agent_name}`,
    `Deployment: ${deployment.id}`,
    `Provider: ${deployment.provider}`,
    `URL: ${deployment.deployment_url}`,
  ]
  if (deployment.deployed_version) lines.push(`Version: ${deployment.deployed_version}`)
  lines.push('', `cast status reads live machine status for Fly.io. This deployment is ${deployment.provider}.`)
  return lines.join('\n')
}

export async function collectDeploymentStatus(
  target: string,
  deps: DeploymentStatusDeps = defaultDeploymentStatusDeps(),
): Promise<StatusResult> {
  if (!AGENT_NAME.test(target)) {
    return {status: 'error', text: `Invalid agent name '${target}'.`}
  }

  let deployment: StatusDeployment | undefined
  if (isShaPattern(target)) {
    const bySha = deps.getDeploymentBySha(target)
    if (bySha) deployment = bySha
  }
  if (!deployment) {
    const chosen = chooseDeployment(deps.listDeployments(target), target)
    if (chosen.kind === 'ambiguous') return {status: 'error', text: chosen.text}
    if (chosen.kind === 'one') deployment = chosen.row
  }

  if (!deployment) {
    return {
      status: 'error',
      text: `No deployment found for '${target}'. Use 'cast deploy' to deploy.`,
    }
  }
  if (!AGENT_NAME.test(deployment.agent_name)) {
    return {status: 'error', text: `Invalid agent name '${deployment.agent_name}'.`}
  }

  if (deployment.provider !== 'fly') {
    return {status: 'ok', text: registrySummary(deployment)}
  }

  const appName = flyAppName(deployment.agent_name)
  let result: StatusCommandResult
  try {
    result = await deps.flyStatus(appName)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      text: `Could not read Fly.io status for app '${appName}'.\n${message}`,
    }
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].map(part => part.trim()).filter(Boolean).join('\n')
    return {
      status: 'error',
      text: detail
        ? `Could not read Fly.io status for app '${appName}'.\n${detail}`
        : `Could not read Fly.io status for app '${appName}'.`,
    }
  }
  const body = [result.stdout, result.stderr].filter(part => part && part.trim()).join(result.stdout.endsWith('\n') ? '' : '\n')
  if (!body.trim()) {
    return {status: 'ok', text: `No status output for Fly app '${appName}'.`}
  }
  return {status: 'ok', text: body}
}
