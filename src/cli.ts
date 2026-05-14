#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import getPort from 'get-port'
import { isGitRepo } from './git.js'
import { startServer } from './server.js'
import { loadSettings } from './settings.js'
import { defaultStatePath, writeState, removeState } from './state.js'
import { SUBCOMMANDS, cmdState, cmdComments, cmdReply, cmdResolve, cmdReopen } from './subcommands.js'

// Subcommand dispatch happens BEFORE parseArgs so that flags like --staged
// don't get rejected when we're really running a subcommand. We only treat
// argv[2] as a subcommand if there's no `--` separator before it — `--` is
// the user's hard signal that the rest of argv is git-diff args, not a
// subcommand.
const rawArgs = process.argv.slice(2)
const dashDashIdx = rawArgs.indexOf('--')
const firstPositional = rawArgs.find((a) => !a.startsWith('-'))
const subcommandIdx = firstPositional ? rawArgs.indexOf(firstPositional) : -1
const hasSubcommand =
  firstPositional !== undefined &&
  SUBCOMMANDS.has(firstPositional) &&
  (dashDashIdx === -1 || subcommandIdx < dashDashIdx)

if (hasSubcommand) {
  const [sub, ...rest] = rawArgs.slice(subcommandIdx)
  switch (sub) {
    case 'state':
      cmdState()
      process.exit(0)
    case 'comments': {
      const filter = (rest[0] as 'open' | 'resolved' | 'replied' | 'all' | undefined) ?? 'all'
      if (!['open', 'resolved', 'replied', 'all'].includes(filter)) {
        console.error(`Unknown filter: ${filter}. Use one of: open, resolved, replied, all.`)
        process.exit(1)
      }
      await cmdComments(filter)
      process.exit(0)
    }
    case 'reply':
      await cmdReply(rest[0], rest.slice(1).join(' '))
      process.exit(0)
    case 'resolve':
      await cmdResolve(rest[0])
      process.exit(0)
    case 'reopen':
      await cmdReopen(rest[0])
      process.exit(0)
  }
}

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
})

if (values.help) {
  console.log(`diffx - Local code review tool for git diffs

Usage: diffx [options] [-- <git diff args>]
       diffx <subcommand> [args]

Options:
  -p, --port <port>  Port to run the server on (default: random available port)
  --host <host>      Host address to bind to (default: 127.0.0.1). Pass
                     0.0.0.0 to expose the server to the local network.
  --no-open          Don't open the browser automatically
  -v, --version      Show version number
  -h, --help         Show this help message

Subcommands (talk to the running diffx server for the current session):
  state                       Print state JSON (port, pid, url, etc.)
  comments [filter]           List comments. filter: open | resolved | replied | all (default: all)
  reply <id> <text...>        Reply to a comment
  resolve <id>                Mark a comment resolved
  reopen <id>                 Reopen a resolved comment

Examples:
  diffx                        Review uncommitted changes
  diffx -- --staged            Review staged changes
  diffx -- HEAD~3              Review last 3 commits
  diffx -- main..feature       Compare branches
  diffx --host 0.0.0.0         Allow other machines on the LAN to review
  diffx comments open          List unresolved comments
  diffx reply abc-123 "Done."  Reply to a comment

Session model:
  diffx writes a state file so subcommands can find the running server.
  Location priority:
    1. $DIFFX_STATE_FILE
    2. $CLAUDE_TMPDIR/diffx-state.json   (one diffx per Claude Code session)
    3. ~/.diffx/state-<sha1(cwd)[:12]>.json`)
  process.exit(0)
}

if (values.version) {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
  console.log(pkg.version)
  process.exit(0)
}

// Everything after -- becomes custom git diff args
const customDiffArgs = positionals.length > 0 ? positionals : undefined

if (!isGitRepo()) {
  console.error('Error: not inside a git repository')
  process.exit(1)
}

const port = await getPort(values.port ? { port: parseInt(values.port, 10) } : undefined)
const host = values.host ?? '127.0.0.1'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(__dirname, 'client')
const { existsSync } = await import('node:fs')
const resolvedClientDir = existsSync(clientDir)
  ? clientDir
  : resolve(process.cwd(), 'dist/client')

const { port: actualPort } = await startServer({ port, host, clientDir: resolvedClientDir, customDiffArgs })

const localUrl = `http://${host}:${actualPort}`

console.log(`diffx server running at ${localUrl}`)

const statePath = defaultStatePath()
writeState({
  port: actualPort,
  pid: process.pid,
  cwd: process.cwd(),
  host,
  url: localUrl,
  startedAt: Date.now(),
}, statePath)
console.log(`state file: ${statePath}`)

const cleanup = () => removeState(statePath)
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
process.on('exit', cleanup)

if (!values['no-open']) {
  const settings = loadSettings()
  const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const openUrl = `http://${openHost}:${actualPort}`
  const openModule = await import('open')
  let appName: string | readonly string[] | undefined
  if (settings.browser) {
    const apps = openModule.apps as Record<string, string | readonly string[]>
    appName = apps[settings.browser] || settings.browser
  }
  const options = appName ? { app: { name: appName } } : {}
  openModule.default(openUrl, options)
}
