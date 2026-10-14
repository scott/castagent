import {Command, Flags} from '@oclif/core'
import {StdioJsonRpcBridge} from '../../lib/builder/stdio'
import {AssertionEngine, AssertionResult} from '../../lib/meta/assertions'
import {
  metaTestChildEnv,
  metaTestInitializeParams,
  resolveMetaTestPython,
  usingSystemPython,
} from '../../lib/meta/harness'
import {ScenarioLoader} from '../../lib/meta/scenarios'

interface ScenarioRunResult {
  name: string
  passed: boolean
  assertions: AssertionResult[]
  response?: string
  error?: string
}

export default class MetaTest extends Command {
  static description = 'Run meta-builder tests'

  static examples = [
    '<%= config.bin %> meta test',
    '<%= config.bin %> meta test --scenario create-simple',
    '<%= config.bin %> meta test --verbose',
  ]

  static flags = {
    scenario: Flags.string({description: 'Run specific scenario'}),
    verbose: Flags.boolean({description: 'Show full output'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(MetaTest)

    this.log('Running meta-builder tests...')

    // Ensure default scenarios exist
    const loader = new ScenarioLoader()
    loader.createDefaultScenarios()

    let scenarios: string[]
    if (flags.scenario) {
      scenarios = [flags.scenario]
    } else {
      scenarios = loader.listScenarios()
    }

    if (scenarios.length === 0) {
      this.log('No scenarios found in ~/.cast/meta/scenarios/')
      this.log('Run without --scenario to create defaults.')
      return
    }

    // Validate requested scenario exists
    if (flags.scenario) {
      const allScenarios = loader.listScenarios()
      if (!allScenarios.includes(flags.scenario)) {
        this.error(
          `Scenario '${flags.scenario}' not found.\n` +
          `Available scenarios: ${allScenarios.join(', ') || 'none'}`
        )
      }
    }

    const python = resolveMetaTestPython(__dirname)
    if (usingSystemPython(python.command)) {
      this.warn('Python virtual environment not found at python/.venv/')
      this.warn('Falling back to system python3. Some features may not work correctly.')
    }

    const bridge = new StdioJsonRpcBridge(python.command, ['-m', 'cast', 'builder'], {
      env: metaTestChildEnv(process.env, python),
    })

    try {
      await bridge.start()
    } catch (error: any) {
      this.error(
        `Failed to start Builder Agent for testing.\n` +
        `Error: ${error.message}\n\n` +
        `Make sure Python is installed and the virtual environment is set up.`
      )
    }

    try {
      // Initialize the builder agent
      await bridge.send('initialize', metaTestInitializeParams())

      const results: ScenarioRunResult[] = []

      for (const scenarioName of scenarios) {
        const result = await this.runScenario(bridge, loader, scenarioName, flags.verbose)
        results.push(result)
      }

      // Print results
      this.log('')
      this.log('='.repeat(60))
      this.log('META-BUILDER TEST RESULTS')
      this.log('='.repeat(60))

      let totalPassed = 0
      let totalFailed = 0

      for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL'
        const statusColor = result.passed ? '\x1b[32m' : '\x1b[31m'
        const resetColor = '\x1b[0m'

        if (result.passed) {
          totalPassed++
        } else {
          totalFailed++
        }

        this.log(`${statusColor}[${status}]${resetColor} ${result.name}`)

        if (result.error) {
          this.log(`  Error: ${result.error}`)
        }

        for (const assertionResult of result.assertions) {
          const aStatus = assertionResult.passed ? 'PASS' : 'FAIL'
          const aColor = assertionResult.passed ? '\x1b[32m' : '\x1b[31m'
          this.log(`  ${aColor}[${aStatus}]${resetColor} ${assertionResult.message}`)
        }

        if (flags.verbose && result.response) {
          this.log(`  Response: ${result.response}`)
        }
      }

      this.log('')
      this.log(`Total: ${results.length} scenarios, ${totalPassed} passed, ${totalFailed} failed`)

      if (totalFailed > 0) {
        this.exit(1)
      }
    } catch (error: any) {
      this.error(
        `Failed to run meta-builder tests.\n\n` +
        `Error: ${error.message || error}\n\n` +
        `Troubleshooting:\n` +
        `  - Ensure the Builder Agent started correctly\n` +
        `  - Check that PYTHONPATH includes the cast Python package\n` +
        `  - Verify Python dependencies are installed`
      )
    } finally {
      bridge.stop()
    }
  }

  private async runScenario(
    bridge: StdioJsonRpcBridge,
    loader: ScenarioLoader,
    scenarioName: string,
    verbose?: boolean,
  ): Promise<ScenarioRunResult> {
    try {
      const scenario = loader.loadScenario(scenarioName)

      if (verbose) {
        this.log(`\nRunning scenario: ${scenario.name}`)
        this.log(`Input: ${scenario.input}`)
      }

      // Send input to builder agent
      const response = await bridge.send('output', {
        message: scenario.input,
        content: scenario.input,
        text: scenario.input,
      })

      const builderResponse = response?.response || ''

      if (verbose) {
        this.log(`Response: ${builderResponse}`)
      }

      // Wait a moment for any async file operations to complete
      await new Promise(resolve => setTimeout(resolve, 500))

      // Run assertions
      const engine = new AssertionEngine()
      const assertionResults = await engine.run(scenario.assertions, {response: builderResponse})
      const allPassed = assertionResults.every(r => r.passed)

      return {
        name: scenario.name,
        passed: allPassed,
        assertions: assertionResults,
        response: builderResponse,
      }
    } catch (error) {
      return {
        name: scenarioName,
        passed: false,
        assertions: [],
        error: String(error),
      }
    }
  }
}
