#!/usr/bin/env node
// Build the 12 pull requests from prs/definitions.mjs: copy app/ into a scratch git
// repository, commit it as main, apply each PR's edits on its own branch, and write
// prs/<id>/patch.diff, prs/<id>/pr.md, and prs/answer-key.json (with line numbers).
//
//   node build-prs.mjs                 # main set: app/ and prs/
//   node build-prs.mjs --set followup  # follow-up set: followup/app and followup/prs

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'main'
const BASE = SET === 'main' ? HERE : join(HERE, SET)
const { PRS } = await import(join(BASE, 'prs', 'definitions.mjs'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

const repo = mkdtempSync(join(tmpdir(), 'review-build-'))
cpSync(join(BASE, 'app'), repo, { recursive: true })
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'add', '-A')
git(repo, '-c', 'user.name=Acme', '-c', 'user.email=dev@acme.example', 'commit', '-q', '-m', 'Base')

const answerKey = []
for (const pr of PRS) {
  git(repo, 'checkout', '-q', '-B', pr.id, 'main')
  for (const edit of pr.edits) {
    const path = join(repo, edit.file)
    if (edit.create !== undefined) {
      if (existsSync(path)) throw new Error(`${pr.id}: ${edit.file} already exists`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, edit.create)
    } else if (edit.append !== undefined) {
      writeFileSync(path, readFileSync(path, 'utf8') + edit.append)
    } else {
      const text = readFileSync(path, 'utf8')
      const count = text.split(edit.find).length - 1
      if (count !== 1) throw new Error(`${pr.id}: expected one match in ${edit.file}, found ${count}`)
      writeFileSync(path, text.replace(edit.find, edit.replace))
    }
  }
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.name=Acme', '-c', 'user.email=dev@acme.example', 'commit', '-q', '-m', pr.title)
  const patch = git(repo, 'diff', '--no-color', 'main', pr.id)

  const out = join(BASE, 'prs', pr.id)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'patch.diff'), patch)
  writeFileSync(join(out, 'pr.md'), `# ${pr.title}\n\n${pr.description}\n`)

  let answer = null
  if (pr.answer) {
    const lines = readFileSync(join(repo, pr.answer.file), 'utf8').split('\n')
    const line = lines.findIndex((l) => l.includes(pr.answer.marker)) + 1
    if (!line) throw new Error(`${pr.id}: marker not found in ${pr.answer.file}`)
    answer = { ...pr.answer, line }
  }
  answerKey.push({ id: pr.id, title: pr.title, planted_bug: answer })
  console.log(`${pr.id.padEnd(30)} ${patch.split('\n').length} diff lines${answer ? `, bug at ${answer.file}:${answer.line} (${answer.visibility})` : ', clean'}`)
}

writeFileSync(join(BASE, 'prs', 'answer-key.json'), JSON.stringify(answerKey, null, 2) + '\n')
rmSync(repo, { recursive: true, force: true })
