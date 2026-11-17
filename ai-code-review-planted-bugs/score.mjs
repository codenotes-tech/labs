#!/usr/bin/env node
// Score every review in results/raw/ against prs/answer-key.json.
//
//   node score.mjs                 # main set
//   node score.mjs --set followup  # follow-up set
//
// Rules, fixed before any review was run (see results/preregistration.json):
//
// - A planted bug counts as CAUGHT when at least one finding
//     (a) points at the answer's file (the finding's file path ends with it, or the
//         finding's text names the file), and
//     (b) contains at least one of the answer's keywords in its title or explanation
//         (case-insensitive).
//   The finding's severity is recorded; "caught as blocking" requires severity "blocking".
//   Line numbers are recorded (within 5 lines of the planted bug) but not required.
// - Every other finding is NOISE. On the three clean PRs every finding is a false alarm.
// - A review whose output is not valid JSON in the requested shape is scored as
//   "unparseable" and counted as a miss with no findings.
// - Manual corrections: after scoring, misses and a sample of catches are read by hand.
//   Any change goes into results/score-overrides.json with a written reason and is
//   applied on top of the automatic score; the automatic score is kept alongside it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'main'
const BASE = SET === 'main' ? HERE : join(HERE, SET)
const OUT = SET === 'main' ? join(HERE, 'results') : join(HERE, 'results', SET)
const answers = Object.fromEntries(JSON.parse(readFileSync(join(BASE, 'prs', 'answer-key.json'), 'utf8')).map((a) => [a.id, a.planted_bug]))
const overridesPath = join(OUT, 'score-overrides.json')
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : []

const CONDITIONS = ['diff-plain', 'diff-checklist', 'repo-plain', 'repo-checklist']
const CONDITION_LABEL = {
  'diff-plain': 'Diff only',
  'diff-checklist': 'Diff + checklist',
  'repo-plain': 'Whole repo',
  'repo-checklist': 'Whole repo + checklist',
}

const text = (f) => `${f.title ?? ''} ${f.explanation ?? ''}`.toLowerCase()
const pointsAt = (f, file) => {
  const path = String(f.file ?? '').replace(/^\.?\//, '')
  const base = file.split('/').pop().toLowerCase()
  return (path && (path.endsWith(file) || file.endsWith(path))) || text(f).includes(base)
}

function scoreReview(review) {
  const answer = answers[review.pr]
  const findings = Array.isArray(review.findings) ? review.findings : []
  let match = null
  if (answer) {
    match = findings.find((f) => pointsAt(f, answer.file) && answer.keywords.some((k) => text(f).includes(k.toLowerCase())))
  }
  const noise = findings.filter((f) => f !== match)
  return {
    pr: review.pr,
    condition: review.condition,
    rep: review.rep,
    planted: answer ? answer.category : 'clean',
    visibility: answer ? answer.visibility : 'clean',
    parse_ok: review.parse_ok,
    findings: findings.length,
    caught: answer ? Boolean(match) : null,
    caught_blocking: answer ? Boolean(match && match.severity === 'blocking') : null,
    line_within_5: answer && match && Number.isFinite(match.line) ? Math.abs(match.line - answer.line) <= 5 : null,
    noise: noise.length,
    noise_blocking: noise.filter((f) => f.severity === 'blocking').length,
    files_read: (review.files_read || []).map((p) => p.replace(/^.*review-[A-Za-z0-9]+\//, '')).join(';'),
    read_conventions: (review.files_read || []).some((p) => p.endsWith('docs/CONVENTIONS.md')),
    turns: review.num_turns,
    cost_usd: review.cost_usd,
  }
}

const rawDir = join(OUT, 'raw')
const reviews = readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(rawDir, f), 'utf8')))
const scored = reviews.map(scoreReview).sort((a, b) => a.pr.localeCompare(b.pr) || a.condition.localeCompare(b.condition) || a.rep - b.rep)

for (const o of overrides) {
  const row = scored.find((r) => r.pr === o.pr && r.condition === o.condition && r.rep === o.rep)
  if (!row) throw new Error(`override for unknown review ${o.pr}/${o.condition}/${o.rep}`)
  row.auto_caught = row.caught
  row.caught = o.caught
  if ('caught_blocking' in o) row.caught_blocking = o.caught_blocking
  row.override_reason = o.reason
}

const cols = ['pr', 'condition', 'rep', 'planted', 'visibility', 'parse_ok', 'findings', 'caught', 'caught_blocking', 'line_within_5', 'noise', 'noise_blocking', 'read_conventions', 'turns', 'cost_usd', 'files_read', 'auto_caught', 'override_reason']
const csv = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
writeFileSync(join(OUT, 'scored.csv'), [cols.join(','), ...scored.map((r) => cols.map((c) => csv(r[c])).join(','))].join('\n') + '\n')

// ---- Summary -------------------------------------------------------------
const of = (rows, pred) => `${rows.filter(pred).length}/${rows.length}`
const pct = (rows, pred) => (rows.length ? Math.round((rows.filter(pred).length / rows.length) * 100) : 0)
const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0)
const conditions = CONDITIONS.filter((c) => scored.some((r) => r.condition === c))
const buggy = scored.filter((r) => r.planted !== 'clean')
const clean = scored.filter((r) => r.planted === 'clean')

let md = `# Results\n\nGenerated by \`node score.mjs\` from ${scored.length} reviews in \`${SET === 'main' ? 'results/raw' : `results/${SET}/raw`}/\`. Rules: see the header of \`score.mjs\`.${overrides.length ? ` ${overrides.length} manual correction(s) applied from \`results/score-overrides.json\`.` : ''}\n`

md += `\n## Planted bugs caught, by condition\n\n| | ${conditions.map((c) => CONDITION_LABEL[c]).join(' | ')} |\n|---|${conditions.map(() => '---:').join('|')}|\n`
const VIS_LABEL = { diff: 'Visible in the diff', context: 'Generic risk, context helps', 'repo-rule': 'Breaks a rule only this repo states' }
const bugCount = (vis) => new Set(buggy.filter((r) => r.visibility === vis).map((r) => r.pr)).size
md += `| All ${new Set(buggy.map((r) => r.pr)).size} bugs | ${conditions.map((c) => `${pct(buggy.filter((r) => r.condition === c), (r) => r.caught)}%`).join(' | ')} |\n`
for (const vis of Object.keys(VIS_LABEL).filter((v) => bugCount(v)))
  md += `| ${VIS_LABEL[vis]} (${bugCount(vis)} bugs) | ${conditions.map((c) => `${pct(buggy.filter((r) => r.condition === c && r.visibility === vis), (r) => r.caught)}%`).join(' | ')} |\n`
md += `| Caught and marked blocking | ${conditions.map((c) => `${pct(buggy.filter((r) => r.condition === c), (r) => r.caught_blocking)}%`).join(' | ')} |\n`

md += `\n## Per pull request (caught out of 3 runs)\n\n| PR | Planted bug | Needs | ${conditions.map((c) => CONDITION_LABEL[c]).join(' | ')} |\n|---|---|---|${conditions.map(() => '---:').join('|')}|\n`
for (const id of [...new Set(scored.map((r) => r.pr))]) {
  const rows = scored.filter((r) => r.pr === id)
  const first = rows[0]
  md += `| ${id} | ${first.planted} | ${first.visibility} | ${conditions.map((c) => {
    const rs = rows.filter((r) => r.condition === c)
    return first.planted === 'clean' ? `${mean(rs.map((r) => r.findings))} findings` : of(rs, (r) => r.caught)
  }).join(' | ')} |\n`
}

md += `\n## Noise\n\n| | ${conditions.map((c) => CONDITION_LABEL[c]).join(' | ')} |\n|---|${conditions.map(() => '---:').join('|')}|\n`
if (clean.length) md += `| Findings per clean PR (mean) | ${conditions.map((c) => mean(clean.filter((r) => r.condition === c).map((r) => r.findings))).join(' | ')} |\n`
if (clean.length) md += `| Blocking findings per clean PR (mean) | ${conditions.map((c) => mean(clean.filter((r) => r.condition === c).map((r) => r.noise_blocking))).join(' | ')} |\n`
md += `| Other findings per buggy PR (mean) | ${conditions.map((c) => mean(buggy.filter((r) => r.condition === c).map((r) => r.noise))).join(' | ')} |\n`

md += `\n## Effort\n\n| | ${conditions.map((c) => CONDITION_LABEL[c]).join(' | ')} |\n|---|${conditions.map(() => '---:').join('|')}|\n`
md += `| Mean turns | ${conditions.map((c) => mean(scored.filter((r) => r.condition === c).map((r) => r.turns))).join(' | ')} |\n`
md += `| Mean API-equivalent cost (USD) | ${conditions.map((c) => (Math.round(mean(scored.filter((r) => r.condition === c).map((r) => r.cost_usd * 1000))) / 1000).toFixed(3)).join(' | ')} |\n`
md += `| Read docs/CONVENTIONS.md | ${conditions.map((c) => (c.startsWith('repo') ? `${pct(scored.filter((r) => r.condition === c), (r) => r.read_conventions)}%` : 'n/a')).join(' | ')} |\n`
md += `\nUnparseable reviews: ${scored.filter((r) => !r.parse_ok).length}.\n`

writeFileSync(join(OUT, 'summary.md'), md)
console.log(md)
