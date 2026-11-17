#!/usr/bin/env node
// One chart for the write-up: per condition, (left) runs that caught the billing role
// check out of 3, and (right) mean findings on the three clean PRs.
//   node chart.mjs   ->  results/charts/conditions.svg

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const readCsv = (p) => {
  const [head, ...rows] = readFileSync(p, 'utf8').trim().split('\n')
  const cols = head.split(',')
  return rows.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])))
}
const main = readCsv(join(HERE, 'results', 'scored.csv'))
const follow = readCsv(join(HERE, 'results', 'followup', 'scored.csv'))
const CONDS = [['diff-plain', 'Diff only'], ['diff-checklist', 'Diff + checklist'], ['repo-plain', 'Whole repo'], ['repo-checklist', 'Whole repo + checklist']]
const role = CONDS.map(([c]) => follow.filter((r) => r.pr === 'pr13-invoice-pdf-download' && r.condition === c))
const caughtBlocking = role.map((rs) => rs.filter((r) => r.caught_blocking === 'true').length)
const caughtAny = role.map((rs) => rs.filter((r) => r.caught === 'true').length)
const noise = CONDS.map(([c]) => {
  const rs = main.filter((r) => r.planted === 'clean' && r.condition === c)
  return rs.reduce((n, r) => n + Number(r.findings), 0) / rs.length
})

const W = 760, H = 330, T = 64, rowH = 52, labelW = 170, panelW = 230, gap = 70
const x0 = labelW, x1 = labelW + panelW + gap
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13">\n<rect width="${W}" height="${H}" fill="#ffffff"/>\n`
svg += `<text x="20" y="28" font-size="16" font-weight="600" fill="#111">Claude Code as PR reviewer: what the context changed</text>\n`
svg += `<text x="${x0}" y="${T - 12}" font-weight="600" fill="#111">Caught the repo-only role check (of 3 runs)</text>\n`
svg += `<text x="${x1}" y="${T - 12}" font-weight="600" fill="#111">Comments on a clean PR (mean)</text>\n`
CONDS.forEach(([, label], i) => {
  const y = T + i * rowH
  svg += `<text x="${labelW - 12}" y="${y + 22}" text-anchor="end" fill="#111">${label}</text>\n`
  const wB = (caughtBlocking[i] / 3) * panelW, wA = (caughtAny[i] / 3) * panelW
  svg += `<rect x="${x0}" y="${y + 6}" width="${panelW}" height="24" fill="#f1f5f9"/>`
  if (wA > wB) svg += `<rect x="${x0}" y="${y + 6}" width="${wA}" height="24" fill="#f4c27a"/>`
  svg += `<rect x="${x0}" y="${y + 6}" width="${wB}" height="24" fill="#2e86ab"/>`
  svg += `<text x="${x0 + Math.max(wA, 4) + 8}" y="${y + 23}" fill="#111">${caughtAny[i]}/3${caughtAny[i] > caughtBlocking[i] ? ' (as a nit)' : ''}</text>\n`
  const max = 4, wN = (noise[i] / max) * panelW
  svg += `<rect x="${x1}" y="${y + 6}" width="${panelW}" height="24" fill="#f1f5f9"/><rect x="${x1}" y="${y + 6}" width="${wN}" height="24" fill="#d1495b"/>`
  svg += `<text x="${x1 + wN + 8}" y="${y + 23}" fill="#111">${noise[i].toFixed(1)}</text>\n`
})
svg += `<text x="20" y="${H - 18}" fill="#4b5563">All 9 textbook bugs (injection, race, off-by-one, retried charge, ...) were caught as blocking in every run of every condition.</text>\n</svg>\n`
mkdirSync(join(HERE, 'results', 'charts'), { recursive: true })
writeFileSync(join(HERE, 'results', 'charts', 'conditions.svg'), svg)
console.log({ caughtBlocking, caughtAny, noise: noise.map((n) => n.toFixed(1)) })
