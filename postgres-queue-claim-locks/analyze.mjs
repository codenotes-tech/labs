#!/usr/bin/env node
// Summarize results/<tag>/runs.csv: medians per variant, strategy, and client
// count, the spread across repeats, a Markdown report, and SVG charts.
//
//   node analyze.mjs              # results/main/
//   node analyze.mjs pg18-cause   # results/pg18-cause/
//   node analyze.mjs long-run     # claims/s over time from long-run.mjs, results/long-run/

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tag = process.argv[2] || 'main'
const dir = join(HERE, 'results', tag)

const readCsv = (path) => {
  const [head, ...body] = readFileSync(path, 'utf8').trim().split('\n')
  const names = head.split(',')
  return body.map((line) => {
    const row = Object.fromEntries(line.split(',').map((v, i) => [names[i], v]))
    for (const key of Object.keys(row)) if (row[key] !== '' && !isNaN(Number(row[key]))) row[key] = Number(row[key])
    return row
  })
}

if (tag === 'long-run') {
  // One chart: claims per second over time, default vs tuned autovacuum, per version file.
  const W = 720, H = 420, L = 70, R = 20, T = 50, B = 80
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()
  const series = []
  const colors = { default: '#d1495b', tuned: '#2e86ab' }
  for (const file of files) {
    const rows = readCsv(join(dir, file))
    const version = file.split('-')[0]
    for (const setting of ['default', 'tuned']) {
      // The final sample overlaps pgbench shutting down, so it is dropped.
      const points = rows.filter((r) => r.setting === setting).map((r) => ({ x: r.t_s, y: r.claims_per_s })).slice(0, -1)
      if (points.length) series.push({ label: `${version}, ${setting} autovacuum`, color: colors[setting], dash: version.endsWith('18') ? '6 4' : '', points })
    }
  }
  const maxX = Math.max(...series.flatMap((s) => s.points.map((p) => p.x)))
  const yMax = Math.ceil(Math.max(...series.flatMap((s) => s.points.map((p) => p.y))) / 5000) * 5000
  const xPos = (x) => L + (x / maxX) * (W - L - R)
  const yPos = (y) => T + (1 - y / yMax) * (H - T - B)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13">\n`
  svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>\n<text x="${L}" y="28" font-size="16" font-weight="600" fill="#111">SKIP LOCKED, 16 workers: rows claimed per second over a long run</text>\n`
  for (let y = 0; y <= yMax; y += 5000) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${yPos(y)}" y2="${yPos(y)}" stroke="#e5e7eb"/>`
    svg += `<text x="${L - 8}" y="${yPos(y) + 4}" text-anchor="end" fill="#4b5563">${y.toLocaleString('en-US')}</text>\n`
  }
  for (let x = 0; x <= maxX; x += 30) svg += `<text x="${xPos(x)}" y="${H - B + 20}" text-anchor="middle" fill="#4b5563">${x}</text>\n`
  svg += `<text x="${(L + W - R) / 2}" y="${H - B + 42}" text-anchor="middle" fill="#111">Seconds since the run started (queue of 5,000,000 jobs)</text>\n`
  svg += `<text transform="translate(18 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#111">Claims per second</text>\n`
  series.forEach((s, i) => {
    const d = s.points.map((p, j) => `${j ? 'L' : 'M'}${xPos(p.x).toFixed(1)},${yPos(p.y).toFixed(1)}`).join(' ')
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>\n`
    const lx = L + (i % 2) * 300
    const ly = H - 22 + Math.floor(i / 2) * 18
    svg += `<line x1="${lx}" x2="${lx + 22}" y1="${ly - 4}" y2="${ly - 4}" stroke="${s.color}" stroke-width="3"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`
    svg += `<text x="${lx + 28}" y="${ly}" fill="#111">${s.label}</text>\n`
  })
  svg += '</svg>\n'
  mkdirSync(join(dir, 'charts'), { recursive: true })
  writeFileSync(join(dir, 'charts', 'claims-over-time.svg'), svg)
  for (const s of series) {
    const tail = s.points.slice(-6).map((p) => p.y)
    console.log(`${s.label}: first ${s.points[0].y}/s, mean of last 30 s ${Math.round(tail.reduce((a, b) => a + b, 0) / tail.length)}/s`)
  }
  process.exit(0)
}

const [header, ...lines] = readFileSync(join(dir, 'runs.csv'), 'utf8').trim().split('\n')
const cols = header.split(',')
const runs = lines.map((line) => {
  const row = Object.fromEntries(line.split(',').map((v, i) => [cols[i], v]))
  for (const key of Object.keys(row)) if (row[key] !== '' && !isNaN(Number(row[key]))) row[key] = Number(row[key])
  return row
})

const STRATEGY_LABEL = { for_update: 'FOR UPDATE', skip_locked: 'SKIP LOCKED', advisory: 'Advisory locks' }
const STRATEGY_COLOR = { for_update: '#d1495b', skip_locked: '#2e86ab', advisory: '#edae49' }
const strategies = Object.keys(STRATEGY_LABEL).filter((s) => runs.some((r) => r.strategy === s))
const variants = [...new Set(runs.map((r) => r.variant))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
const clientCounts = [...new Set(runs.map((r) => r.clients))].sort((a, b) => a - b)

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round = (x, digits = 0) => (x == null ? null : Math.round(x * 10 ** digits) / 10 ** digits)

// One summary row per variant / strategy / clients.
const summary = []
for (const variant of variants)
  for (const strategy of strategies)
    for (const clients of clientCounts) {
      const group = runs.filter((r) => r.variant === variant && r.strategy === strategy && r.clients === clients)
      if (!group.length) continue
      const claims = group.map((r) => r.claims_per_s)
      // Most frequent dominant wait event across the repeats.
      const dominant = {}
      for (const r of group) {
        const first = String(r.top_waits || '').split(';')[0]
        if (first) dominant[first.split('=')[0]] = (dominant[first.split('=')[0]] || 0) + 1
      }
      summary.push({
        variant, pg_major: group[0].pg_major, data_checksums: group[0].data_checksums, strategy, clients,
        reps: group.length,
        claims_per_s: round(median(claims)),
        claims_min: Math.min(...claims),
        claims_max: Math.max(...claims),
        spread_pct: round(((Math.max(...claims) - Math.min(...claims)) / median(claims)) * 100, 1),
        tps: round(median(group.map((r) => r.tps))),
        empty_pct: round(median(group.map((r) => r.empty_pct)), 1),
        p50_ms: round(median(group.map((r) => r.p50_ms)), 2),
        p95_ms: round(median(group.map((r) => r.p95_ms)), 2),
        p99_ms: round(median(group.map((r) => r.p99_ms)), 2),
        avg_lock_wait: round(median(group.map((r) => r.avg_lock_wait)), 1),
        avg_lwlock_wait: round(median(group.map((r) => r.avg_lwlock_wait)), 1),
        avg_io_wait: round(median(group.map((r) => r.avg_io_wait)), 1),
        dominant_wait: Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
        drift_pct: round(median(group.map((r) => ((r.tps_last_quarter - r.tps_first_quarter) / r.tps_first_quarter) * 100)), 1),
        queue_drained: group.some((r) => r.queue_drained === 'true' || r.queue_drained === true),
      })
    }

const summaryCols = Object.keys(summary[0])
writeFileSync(join(dir, 'summary.csv'), [summaryCols.join(','), ...summary.map((s) => summaryCols.map((c) => s[c]).join(','))].join('\n') + '\n')

// Markdown report.
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'))
const get = (variant, strategy, clients) => summary.find((s) => s.variant === variant && s.strategy === strategy && s.clients === clients)
let md = `# Results: ${tag}\n\nMedians of ${Math.max(...summary.map((s) => s.reps))} runs per cell. Generated by \`node analyze.mjs ${tag}\` from \`runs.csv\`.\n`
md += `\n"Claims/s" counts rows actually claimed. pgbench's tps also counts advisory-lock calls that returned no job.\n`
for (const variant of variants) {
  md += `\n## ${variant}\n\n### Claims per second\n\n| Clients | ${strategies.map((s) => STRATEGY_LABEL[s]).join(' | ')} |\n|---:|${strategies.map(() => '---:').join('|')}|\n`
  for (const c of clientCounts) md += `| ${c} | ${strategies.map((s) => fmt(get(variant, s, c)?.claims_per_s)).join(' | ')} |\n`
  md += `\n### p95 latency (ms)\n\n| Clients | ${strategies.map((s) => STRATEGY_LABEL[s]).join(' | ')} |\n|---:|${strategies.map(() => '---:').join('|')}|\n`
  for (const c of clientCounts) md += `| ${c} | ${strategies.map((s) => fmt(get(variant, s, c)?.p95_ms)).join(' | ')} |\n`
  md += `\n### Dominant wait event (avg sessions waiting on heavyweight locks / LWLocks)\n\n| Clients | ${strategies.map((s) => STRATEGY_LABEL[s]).join(' | ')} |\n|---:|${strategies.map(() => '---').join('|')}|\n`
  for (const c of clientCounts)
    md += `| ${c} | ${strategies.map((s) => {
      const x = get(variant, s, c)
      return x ? `${x.dominant_wait || '–'} (${x.avg_lock_wait} / ${x.avg_lwlock_wait})` : '–'
    }).join(' | ')} |\n`
  if (strategies.includes('advisory')) {
    md += `\n### Advisory: share of calls that returned no job\n\n| Clients | Empty claims |\n|---:|---:|\n`
    for (const c of clientCounts) md += `| ${c} | ${fmt(get(variant, 'advisory', c)?.empty_pct)}% |\n`
  }
}
const noisy = summary.filter((s) => s.spread_pct > 15)
md += `\n## Noise check\n\nCells where the fastest and slowest repeat differ by more than 15% of the median: ${noisy.length} of ${summary.length}.\n`
for (const s of noisy) md += `- ${s.variant} ${STRATEGY_LABEL[s.strategy]} c=${s.clients}: ${fmt(s.claims_min)}–${fmt(s.claims_max)} claims/s (${s.spread_pct}%)\n`
if (summary.some((s) => s.queue_drained)) md += `\n**Warning:** at least one run drained the queue; increase --seed-rows.\n`
writeFileSync(join(dir, 'summary.md'), md)

// SVG line chart: claims/s by client count, one line per series.
function lineChart({ title, series, yLabel, file }) {
  const W = 720, H = 420, L = 70, R = 20, T = 50, B = 70
  const xs = clientCounts
  const maxY = Math.max(...series.flatMap((s) => s.points.map((p) => p.y))) * 1.1
  const niceStep = (() => {
    const raw = maxY / 5
    const p = 10 ** Math.floor(Math.log10(raw))
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)
  })()
  const yMax = Math.ceil(maxY / niceStep) * niceStep
  // Client counts on a log2 axis so 1 to 64 spread evenly.
  const xPos = (c) => L + ((Math.log2(c) - Math.log2(xs[0])) / (Math.log2(xs.at(-1)) - Math.log2(xs[0]))) * (W - L - R)
  const yPos = (v) => T + (1 - v / yMax) * (H - T - B)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13">\n`
  svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>\n<text x="${L}" y="28" font-size="16" font-weight="600" fill="#111">${title}</text>\n`
  for (let v = 0; v <= yMax; v += niceStep) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${yPos(v)}" y2="${yPos(v)}" stroke="#e5e7eb"/>`
    svg += `<text x="${L - 8}" y="${yPos(v) + 4}" text-anchor="end" fill="#4b5563">${v.toLocaleString('en-US')}</text>\n`
  }
  for (const c of xs) svg += `<text x="${xPos(c)}" y="${H - B + 20}" text-anchor="middle" fill="#4b5563">${c}</text>\n`
  svg += `<text x="${(L + W - R) / 2}" y="${H - B + 42}" text-anchor="middle" fill="#111">Concurrent workers (pgbench clients)</text>\n`
  svg += `<text transform="translate(18 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#111">${yLabel}</text>\n`
  series.forEach((s, i) => {
    const d = s.points.map((p, j) => `${j ? 'L' : 'M'}${xPos(p.x).toFixed(1)},${yPos(p.y).toFixed(1)}`).join(' ')
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>\n`
    for (const p of s.points) svg += `<circle cx="${xPos(p.x).toFixed(1)}" cy="${yPos(p.y).toFixed(1)}" r="3.5" fill="${s.color}"/>`
    const lx = L + 10 + i * 170
    svg += `\n<line x1="${lx}" x2="${lx + 22}" y1="${H - 12}" y2="${H - 12}" stroke="${s.color}" stroke-width="3"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`
    svg += `<text x="${lx + 28}" y="${H - 8}" fill="#111">${s.label}</text>\n`
  })
  svg += '</svg>\n'
  mkdirSync(join(dir, 'charts'), { recursive: true })
  writeFileSync(join(dir, 'charts', file), svg)
}

for (const variant of variants)
  lineChart({
    title: `Rows claimed per second by strategy (${variant}, median of repeats)`,
    yLabel: 'Claims per second',
    file: `${variant}-claims.svg`,
    series: strategies.map((s) => ({
      label: STRATEGY_LABEL[s], color: STRATEGY_COLOR[s],
      points: clientCounts.map((c) => ({ x: c, y: get(variant, s, c)?.claims_per_s ?? 0 })),
    })),
  })

const VERSION_COLORS = ['#94a3b8', '#64748b', '#334155', '#2e86ab', '#0f172a', '#7c3aed']
for (const strategy of strategies)
  lineChart({
    title: `${STRATEGY_LABEL[strategy]}: rows claimed per second by version`,
    yLabel: 'Claims per second',
    file: `${strategy}-by-variant.svg`,
    series: variants.map((v, i) => ({
      label: v, color: VERSION_COLORS[i % VERSION_COLORS.length],
      points: clientCounts.map((c) => ({ x: c, y: get(v, strategy, c)?.claims_per_s ?? 0 })),
    })),
  })

console.log(md)
