#!/usr/bin/env node
// Run Claude Code as a pull-request reviewer on every PR in prs/, in four conditions:
//
//   diff-plain      the PR description and diff only, no tools
//   diff-checklist  the same, plus a risk checklist (prompts/checklist.txt)
//   repo-plain      the PR description and diff, run inside a checkout of the PR head
//                   with read-only tools (Read, Grep, Glob)
//   repo-checklist  the same, plus the risk checklist
//
// Requires the Claude Code CLI (`claude`) and git. No npm packages.
//
//   node review.mjs                          # 12 PRs x 4 conditions x 3 repeats
//   node review.mjs --prs pr04-invoice-next-page --conditions diff-plain --reps 1
//   node review.mjs --set followup           # follow-up PRs in followup/, results in results/followup/
//
// Isolation: each review starts from a fixed system prompt (prompts/system.txt), with
// no MCP servers (--strict-mcp-config), no user or local settings (--setting-sources
// project), no session saved, and its working directory in a fresh temporary folder
// outside this lab, so the reviewer cannot see the answer key. Re-running skips
// reviews already in results/raw/.

import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODEL = 'claude-sonnet-5-5'
const CONDITIONS = ['diff-plain', 'diff-checklist', 'repo-plain', 'repo-checklist']

const opts = { set: 'main', prs: null, conditions: CONDITIONS, reps: 3, parallel: 3, shuffleSeed: 2026 }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const list = () => {
    const values = []
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
    return values
  }
  if (argv[i] === '--prs') opts.prs = list()
  else if (argv[i] === '--conditions') opts.conditions = list()
  else if (argv[i] === '--reps') opts.reps = Number(argv[++i])
  else if (argv[i] === '--parallel') opts.parallel = Number(argv[++i])
  else if (argv[i] === '--set') opts.set = argv[++i]
  else {
    console.error(`Unknown option: ${argv[i]}`)
    process.exit(2)
  }
}

const BASE = opts.set === 'main' ? HERE : join(HERE, opts.set)
const prompt = (name) => readFileSync(join(HERE, 'prompts', name), 'utf8')
const SYSTEM = prompt('system.txt').trim()
const allPrs = readdirSync(join(BASE, 'prs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const prIds = opts.prs ?? allPrs

function buildPrompt(prId, condition) {
  const md = readFileSync(join(BASE, 'prs', prId, 'pr.md'), 'utf8')
  const [titleLine, ...rest] = md.split('\n')
  return prompt('review.txt')
    .replace('{{title}}', titleLine.replace(/^# /, ''))
    .replace('{{description}}', rest.join('\n').trim())
    .replace('{{patch}}', readFileSync(join(BASE, 'prs', prId, 'patch.diff'), 'utf8').trimEnd())
    .replace('{{repo_note}}', condition.startsWith('repo') ? prompt('repo-note.txt').trimEnd() + '\n' : '')
    .replace('{{checklist}}', condition.endsWith('checklist') ? prompt('checklist.txt').trimEnd() + '\n' : '')
}

// A git checkout of the PR head in a fresh temp folder: base commit on main, PR on its branch.
function checkout(prId) {
  const dir = mkdtempSync(join(tmpdir(), 'review-'))
  cpSync(join(BASE, 'app'), dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=Acme', '-c', 'user.email=dev@acme.example', 'commit', '-q', '-m', 'Base')
  git('checkout', '-q', '-b', prId)
  git('apply', join(BASE, 'prs', prId, 'patch.diff'))
  git('add', '-A')
  git('-c', 'user.name=Acme', '-c', 'user.email=dev@acme.example', 'commit', '-q', '-m', 'PR head')
  return dir
}

function runClaude(cwd, text, tools) {
  const args = [
    '-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config', '--system-prompt', SYSTEM, '--tools', tools, '--max-turns', '40',
  ]
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(text)
  })
}

function parseFindings(resultText) {
  const start = resultText.indexOf('{')
  const end = resultText.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const parsed = JSON.parse(resultText.slice(start, end + 1))
    return Array.isArray(parsed.findings) ? parsed.findings : null
  } catch {
    return null
  }
}

async function runOne(prId, condition, rep, rawDir) {
  const isRepo = condition.startsWith('repo')
  const cwd = isRepo ? checkout(prId) : mkdtempSync(join(tmpdir(), 'review-empty-'))
  const text = buildPrompt(prId, condition)
  const started = Date.now()
  const { code, out, err } = await runClaude(cwd, text, isRepo ? 'Read,Grep,Glob' : '')

  const events = out.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const toolCalls = []
  for (const e of events)
    if (e.type === 'assistant')
      for (const block of e.message?.content ?? [])
        if (block.type === 'tool_use') toolCalls.push({ tool: block.name, input: block.input })
  const result = events.find((e) => e.type === 'result') ?? {}
  // Tool paths come back under /private/var on macOS while cwd is /var, so strip everything up to the checkout folder.
  const filesRead = [...new Set(toolCalls.filter((c) => c.tool === 'Read' && c.input?.file_path).map((c) => c.input.file_path.replace(/^.*review-[A-Za-z0-9]+\//, '')))]
  const findings = parseFindings(result.result ?? '')
  rmSync(cwd, { recursive: true, force: true })

  const review = {
    pr: prId, condition, rep, model: MODEL,
    claude_code: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    exit_code: code,
    is_error: result.is_error ?? true,
    num_turns: result.num_turns ?? null,
    cost_usd: result.total_cost_usd ?? null,
    usage: result.usage ?? null,
    tool_calls: toolCalls,
    files_read: filesRead,
    parse_ok: findings !== null,
    findings: findings ?? [],
    result_text: result.result ?? '',
    stderr: err.slice(0, 2000),
    prompt: text,
  }
  writeFileSync(join(rawDir, `${prId}--${condition}--r${rep}.json`), JSON.stringify(review, null, 2))
  return review
}

function seededShuffle(items, seed) {
  let a = seed >>> 0
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const rawDir = opts.set === 'main' ? join(HERE, 'results', 'raw') : join(HERE, 'results', opts.set, 'raw')
mkdirSync(rawDir, { recursive: true })
let plan = []
for (const pr of prIds) for (const condition of opts.conditions) for (let rep = 1; rep <= opts.reps; rep++) plan.push({ pr, condition, rep })
plan = seededShuffle(plan.filter((p) => !existsSync(join(rawDir, `${p.pr}--${p.condition}--r${p.rep}.json`))), opts.shuffleSeed)
console.log(`${plan.length} reviews to go (${MODEL}, ${opts.parallel} at a time)`)

let next = 0
let done = 0
await Promise.all(
  Array.from({ length: opts.parallel }, async () => {
    while (next < plan.length) {
      const { pr, condition, rep } = plan[next++]
      const r = await runOne(pr, condition, rep, rawDir)
      done++
      console.log(`[${done}/${plan.length}] ${pr.padEnd(30)} ${condition.padEnd(15)} r${rep} findings=${r.findings.length} parse=${r.parse_ok} turns=${r.num_turns} read=${r.files_read.length} $${(r.cost_usd ?? 0).toFixed(3)}${r.is_error ? ' ERROR' : ''}`)
    }
  }),
)
