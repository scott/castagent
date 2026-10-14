import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {resolveCastPythonRuntime, type CastPythonRuntime} from '../cast-python'

/**
 * `cast meta test` talks to the Builder over stdio. The scenarios under
 * ~/.cast/meta/scenarios/ assert exact echo-builder results (agent names,
 * "haiku", "sonnet"). A live model call exceeds the client timeout and
 * does not satisfy those checks. CAST_BUILDER_ECHO forces echo mode even
 * when an API key is set.
 */
export const META_TEST_ECHO_ENV = 'CAST_BUILDER_ECHO'
export const META_TEST_AGENTS_ENV = 'CAST_AGENTS_DIR'
export const META_TEST_BUILDER_ENV = 'CAST_BUILDER_DIR'

export interface MetaTestWorkspace {
  root: string
  agentsDir: string
  builderDir: string
}

/**
 * Temporary agents directory for one `cast meta test` invocation.
 * The directory is named `agents` so the builder's cast.db lands in
 * `root` and is removed with the workspace.
 */
export function createMetaTestWorkspace(tmpdir: string = os.tmpdir()): MetaTestWorkspace {
  const root = fs.mkdtempSync(path.join(tmpdir, 'cast-meta-'))
  const agentsDir = path.join(root, 'agents')
  const builderDir = path.join(root, 'builder')
  fs.mkdirSync(agentsDir, {recursive: true})
  fs.mkdirSync(builderDir, {recursive: true})
  return {root, agentsDir, builderDir}
}

export function removeMetaTestWorkspace(root: string): void {
  fs.rmSync(root, {recursive: true, force: true})
}

export function resolveMetaTestPython(commandDir: string, homeDir?: string): CastPythonRuntime {
  // commandDir is commands/meta (src or dist). resolveCastPythonRuntime
  // expects a directory at the same depth as src/lib.
  return resolveCastPythonRuntime(path.resolve(commandDir, '../../lib'), homeDir)
}

export function metaTestChildEnv(
  base: NodeJS.ProcessEnv,
  runtime: CastPythonRuntime,
  workspace: Pick<MetaTestWorkspace, 'agentsDir' | 'builderDir'>,
): NodeJS.ProcessEnv {
  const pythonPath = runtime.pythonPath
  const existing = base.PYTHONPATH
  return {
    ...base,
    PYTHONPATH: existing ? `${pythonPath}${path.delimiter}${existing}` : pythonPath,
    [META_TEST_ECHO_ENV]: '1',
    [META_TEST_AGENTS_ENV]: workspace.agentsDir,
    [META_TEST_BUILDER_ENV]: workspace.builderDir,
  }
}

/**
 * Stay in normal mode. Initializing a missing agent named meta-test
 * enters the new-agent flow, and "Create an email agent" is then treated
 * as a description of meta-test instead of the scenario input.
 */
export function metaTestInitializeParams(): {agent_name: string; harness: boolean} {
  return {
    agent_name: 'meta-test',
    harness: true,
  }
}

export function usingSystemPython(command: string): boolean {
  return command === 'python3' || command === 'python' || command === 'python.exe'
}
