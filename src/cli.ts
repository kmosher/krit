#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import getPort from 'get-port'
import { isGitRepo, getRepoName, getBranchName } from './git.js'
import { startServer } from './server.js'
import { loadSettings, type Settings } from './settings.js'
import { defaultStatePath, writeState, removeState } from './state.js'
import { SUBCOMMANDS, cmdState, cmdComments, cmdReply, cmdResolve, cmdReopen, cmdWaitForSubmit, cmdWatch } from './subcommands.js'

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
    case 'wait-for-submit':
      await cmdWaitForSubmit()
      // cmdWaitForSubmit exits on its own
      process.exit(0)
    case 'watch':
      await cmdWatch()
      // cmdWatch exits on its own
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
  wait-for-submit             Block until the user clicks Done reviewing in the browser UI
                              (exit 0 on submit, 2 on disconnect, 130 on Ctrl+C)
  watch                       Stream comment events as JSON lines on stdout
                              (one line per new comment / reply; exits 0 on Done reviewing)

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

const doneReviewingHint = `When you're done reviewing, click "Done reviewing" in the browser (or run /diffx in your terminal — Ctrl+C to abort).`

// Common tail: tell the user where to point a browser and what to do when finished.
// Always called, regardless of whether we tried to auto-open — the URL is also the
// only positive-confirmation fallback when `open()` reports success but no tab actually
// rendered (sandboxed `open(1)` on macOS exits 0 silently in that case).
const printManualUrlHint = (url: string): void => {
  console.log(`If the tab didn't open, visit ${url} in your browser.`)
  console.log(doneReviewingHint)
}

// Best-effort window title for the desktop app — repo + branch. Cosmetic, so a
// git hiccup just drops it; the review still opens.
const reviewWindowTitle = (): string | undefined => {
  try {
    const repo = getRepoName()
    const branch = getBranchName()
    return branch ? `${repo} · ${branch}` : repo
  } catch {
    return undefined
  }
}

// Hand this review's URL to the configured UI: the diffx desktop app (a diffx://
// deep link, which the running app turns into a new window) or a browser tab.
// Either way, any failure degrades to the manual-URL hint rather than aborting —
// the server is already up, so a human can always just open the URL.
const launchReviewUI = async (openUrl: string, settings: Settings): Promise<void> => {
  const openModule = await import('open')

  if (settings.launcher === 'app') {
    // The desktop app claims the diffx:// scheme on first launch; this deep link
    // routes to the running instance (cold-starting it if needed), which reads
    // `url` and spawns a window pointed at this review's server.
    const params = new URLSearchParams({ url: openUrl })
    const title = reviewWindowTitle()
    if (title) params.set('title', title)
    try {
      await openModule.default(`diffx://review?${params.toString()}`)
      console.log(`Opened the diffx app. It's now waiting for you to leave inline comments.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Could not reach the diffx app (${msg}); is it installed? Falling back to the URL.`)
    }
    printManualUrlHint(openUrl)
    return
  }

  // Browser tab (default). settings.browser, when set, names a specific app.
  let appName: string | readonly string[] | undefined
  if (settings.browser) {
    const apps = openModule.apps as Record<string, string | readonly string[]>
    appName = apps[settings.browser] || settings.browser
  }
  const options = appName ? { app: { name: appName } } : {}
  // `open()` rejects on spawn failure; the spawned child may still exit non-zero shortly after.
  try {
    const child = await openModule.default(openUrl, options)
    console.log(`Opened a browser tab. diffx is now waiting for you to leave inline comments in the UI.`)
    printManualUrlHint(openUrl)
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Note: browser-open helper exited with code ${code}; the tab may not have opened.`)
      }
    })
    child.once('error', (err) => {
      console.error(`Note: browser-open helper failed after spawn: ${err.message}.`)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Could not open a browser tab automatically (${msg}).`)
    printManualUrlHint(openUrl)
  }
}

if (!values['no-open']) {
  const settings = loadSettings()
  const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const openUrl = `http://${openHost}:${actualPort}`
  await launchReviewUI(openUrl, settings)
} else {
  printManualUrlHint(localUrl)
}
