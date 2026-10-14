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

export function resolveMetaTestPython(commandDir: string, homeDir?: string): CastPythonRuntime {
  // commandDir is commands/meta (src or dist). resolveCastPythonRuntime
  // expects a directory at the same depth as src/lib.
  return resolveCastPythonRuntime(path.resolve(commandDir, '../../lib'), homeDir)
}

export function metaTestChildEnv(
  base: NodeJS.ProcessEnv,
  runtime: CastPythonRuntime,
): NodeJS.ProcessEnv {
  const pythonPath = runtime.pythonPath
  const existing = base.PYTHONPATH
  return {
    ...base,
    PYTHONPATH: existing ? `${pythonPath}${path.delimiter}${existing}` : pythonPath,
    [META_TEST_ECHO_ENV]: '1',
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
