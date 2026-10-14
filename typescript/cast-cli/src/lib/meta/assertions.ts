import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import {homedir} from 'os'

export interface Assertion {
  type: string
  path?: string
  key?: string
  value?: string
}

export interface AssertionResult {
  assertion: Assertion
  passed: boolean
  message: string
}

export interface AssertionContext {
  response?: string
  /** Isolated agents directory. Rewrites `~/.cast/agents` assertion paths. */
  agentsDir?: string
  /**
   * Absolute paths that existed before this scenario ran.
   * File assertions on those paths fail: the run did not create them.
   */
  preexisting?: ReadonlySet<string>
}

export function resolveAssertionPath(filePath: string, agentsDir?: string): string {
  const expanded = filePath.startsWith('~/')
    ? path.join(homedir(), filePath.slice(2))
    : filePath
  const absolute = path.resolve(expanded)
  if (!agentsDir) return absolute

  const homeAgents = path.resolve(homedir(), '.cast', 'agents')
  const relative = path.relative(homeAgents, absolute)
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!inside) return absolute
  return path.resolve(agentsDir, relative)
}

export function collectPreexistingPaths(assertions: Assertion[], agentsDir?: string): Set<string> {
  const found = new Set<string>()
  for (const assertion of assertions) {
    if (!assertion.path) continue
    const resolved = resolveAssertionPath(assertion.path, agentsDir)
    if (fs.existsSync(resolved)) found.add(resolved)
  }

  return found
}

export class AssertionEngine {
  async run(assertions: Assertion[], context: AssertionContext = {}): Promise<AssertionResult[]> {
    const results: AssertionResult[] = []
    for (const assertion of assertions) {
      const result = await this.runOne(assertion, context)
      results.push(result)
    }

    return results
  }

  private async runOne(assertion: Assertion, context: AssertionContext): Promise<AssertionResult> {
    const filePath = assertion.path
      ? resolveAssertionPath(assertion.path, context.agentsDir)
      : ''
    if (assertion.path && context.preexisting?.has(filePath)) {
      return {
        assertion,
        passed: false,
        message: `Path already existed before this scenario and was not created by this run: ${filePath}`,
      }
    }

    switch (assertion.type) {
    case 'file_exists':
      return this.fileExists(filePath, assertion)
    case 'directory_exists':
      return this.directoryExists(filePath, assertion)
    case 'file_contains':
      return this.fileContains(filePath, assertion)
    case 'yaml_contains':
      return this.yamlContains(filePath, assertion)
    case 'yaml_not_always_allow':
      return this.yamlNotAlwaysAllow(filePath, assertion)
    case 'response_contains':
      return this.responseContains(context.response || '', assertion)
    default:
      return {
        assertion,
        passed: false,
        message: `Unknown assertion type: ${assertion.type}`,
      }
    }
  }

  private fileExists(filePath: string, assertion: Assertion): AssertionResult {
    const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    return {
      assertion,
      passed: exists,
      message: exists ? `File exists: ${filePath}` : `File does not exist: ${filePath}`,
    }
  }

  private directoryExists(dirPath: string, assertion: Assertion): AssertionResult {
    const exists = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
    return {
      assertion,
      passed: exists,
      message: exists ? `Directory exists: ${dirPath}` : `Directory does not exist: ${dirPath}`,
    }
  }

  private fileContains(filePath: string, assertion: Assertion): AssertionResult {
    if (!fs.existsSync(filePath)) {
      return {
        assertion,
        passed: false,
        message: `File does not exist: ${filePath}`,
      }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const expected = assertion.value || ''
    const contains = content.includes(expected)
    return {
      assertion,
      passed: contains,
      message: contains ? `File contains '${expected}'` : `File does not contain '${expected}'`,
    }
  }

  private yamlContains(filePath: string, assertion: Assertion): AssertionResult {
    if (!fs.existsSync(filePath)) {
      return {
        assertion,
        passed: false,
        message: `File does not exist: ${filePath}`,
      }
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const doc = yaml.parse(content)
      const key = assertion.key || ''
      const expectedValue = assertion.value
      const actualValue = this.getValueByPath(doc, key)

      if (expectedValue !== undefined) {
        const matches = actualValue === expectedValue
        return {
          assertion,
          passed: matches,
          message: matches
            ? `YAML key '${key}' has value '${expectedValue}'`
            : `YAML key '${key}' expected '${expectedValue}' but got '${actualValue}'`,
        }
      }

      const exists = actualValue !== undefined
      return {
        assertion,
        passed: exists,
        message: exists ? `YAML key '${key}' exists` : `YAML key '${key}' not found`,
      }
    } catch (error) {
      return {
        assertion,
        passed: false,
        message: `Failed to parse YAML: ${error}`,
      }
    }
  }

  private yamlNotAlwaysAllow(filePath: string, assertion: Assertion): AssertionResult {
    if (!fs.existsSync(filePath)) {
      return {
        assertion,
        passed: false,
        message: `File does not exist: ${filePath}`,
      }
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const doc = yaml.parse(content)
      const key = assertion.key || ''
      const actualValue = this.getValueByPath(doc, key)

      const isSafe = actualValue !== 'always-allow'
      return {
        assertion,
        passed: isSafe,
        message: isSafe
          ? `YAML key '${key}' is NOT always-allow (value: '${actualValue}')`
          : `YAML key '${key}' is always-allow - unsafe!`,
      }
    } catch (error) {
      return {
        assertion,
        passed: false,
        message: `Failed to parse YAML: ${error}`,
      }
    }
  }

  private responseContains(response: string, assertion: Assertion): AssertionResult {
    const expected = assertion.value || ''
    const contains = response.includes(expected)
    return {
      assertion,
      passed: contains,
      message: contains ? `Response contains '${expected}'` : `Response does not contain '${expected}'`,
    }
  }

  private getValueByPath(obj: any, path: string): any {
    const keys = path.split('.')
    let current = obj
    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined
      }

      current = current[key]
    }

    return current
  }
}
