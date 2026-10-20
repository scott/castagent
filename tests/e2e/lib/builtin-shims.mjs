// Shared CLI stand-ins used while packing an agent. They are not a provider.
// A provider CLI belongs in that provider's module.

export async function handleBuiltinShim(api) {
  if (api.args.includes('--version') || (api.bin === 'docker' && api.args[0] === '--version') || (api.bin === 'doctl' && api.args[0] === 'version')) {
    api.finish(0, `${api.bin} e2e-fake\n`)
  }
  if (api.bin === 'bun') api.finish(0, '')
  if (api.bin === 'gzip') {
    await api.readStdin()
    api.finish(0, 'gz\n')
  }
  return false
}
