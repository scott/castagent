import {Command} from '@oclif/core'
import * as path from 'path'

/**
 * Load a command class for testing by file path.
 * This avoids the need to use @oclif/test's command loading which can be complex.
 */
export async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

/**
 * Mock a command instance for testing its methods without running.
 */
export function createMockCommandInstance(CommandClass: any, args: string[] = [], flags: Record<string, any> = {}): any {
  return new CommandClass(args, flags as any)
}

/**
 * Helper to create a mock context for command testing.
 */
export function createMockContext(options: {args?: Record<string, any>; flags?: Record<string, any>} = {}) {
  return {
    args: options.args || {},
    flags: options.flags || {},
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
}