import {Command} from '@oclif/core'

export default class Version extends Command {
  static description = 'Show the version of the cast CLI'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  async run(): Promise<void> {
    await this.parse(Version)
    this.log(this.config.version)
  }
}