# AI code review on planted bugs: diff only vs. whole repository

**Question:** when an AI reviews a pull request with a known bug in it, does it catch the bug, and does giving it the rest of the repository or a risk checklist change the answer?

Article: [What AI Code Review Misses: A Planted-Bug Test](https://codenotes.tech/blog/why-ai-code-review-misses-real-risks)

## Findings (November 2026)

180 reviews by Claude Code 2.1.326 with `claude-sonnet-5-5`, 3 runs per pull request and setup. Full tables: [`results/summary.md`](results/summary.md) and [`results/followup/summary.md`](results/followup/summary.md).

| | Diff only | Diff + checklist | Whole repo | Whole repo + checklist |
| --- | ---: | ---: | ---: | ---: |
| 9 textbook bugs, caught (of 27 reviews) | 27 | 27 | 27 | 27 |
| Repo-only billing role check, caught (of 3) | 0 | 1 (as a nit) | 3 | 3 |
| Repo-only money and soft-delete bugs, caught (of 6) | 6 | 6 | 6 | 6 |
| Findings on a clean pull request (mean) | 3.4 | 1.9 | 1.3 | 1.0 |
| Other findings on a buggy pull request (mean) | 5.3 | 4.9 | 3.4 | 3.4 |

- Every textbook catch was marked blocking, including the four bugs we expected to need context.
- The two repo-only bugs caught from the diff alone were inferred from function names in git's hunk headers (`activeProjectNames`, `monthlyPriceMinor`).
- In the 90 whole-repository reviews, the reviewer opened no file in 32, only the changed files in 31, and other files in 27; it never opened `docs/CONVENTIONS.md` or `README.md`.
- No clean pull request got a blocking finding. The 180 reviews cost $3.48 at API prices, median 13 s each.

## What is here

| Path | Contents |
| --- | --- |
| [`app/`](app/) | The test repository: a TypeScript billing API (Express, PostgreSQL migrations, a web client, tests, `docs/CONVENTIONS.md`) |
| [`prs/definitions.mjs`](prs/definitions.mjs) | The 12 main pull requests: title, description, exact edits, and answer key |
| `prs/<id>/` | Each pull request's `pr.md` and `patch.diff`, built by [`build-prs.mjs`](build-prs.mjs) |
| [`followup/`](followup/) | The 3 follow-up pull requests and the copy of the repository with three repo-specific rules (billing role check, money minor units, soft-deleted projects) |
| [`prompts/`](prompts/) | The system prompt, review prompt, repository note, and checklist |
| [`review.mjs`](review.mjs) | Runs Claude Code headless on each pull request in four setups |
| [`score.mjs`](score.mjs) | Scores every review against the answer key |
| `results/raw/`, `results/followup/raw/` | Every review: prompt, tool calls, files read, findings, result text, tokens, cost |
| [`results/preregistration.json`](results/preregistration.json) | Fingerprints of the answer key, scoring rules, and prompts, recorded before any review ran, and every later change with its reason |

## Setups

| Setup | What the reviewer got |
| --- | --- |
| `diff-plain` | The pull request's title, description, and diff; no tools |
| `diff-checklist` | The same, plus [`prompts/checklist.txt`](prompts/checklist.txt) |
| `repo-plain` | The same as `diff-plain`, run inside a git checkout of the pull request with `Read`, `Grep`, and `Glob` |
| `repo-checklist` | Both |

Isolation: a fixed system prompt (`--system-prompt`), no MCP servers (`--strict-mcp-config`), no user or local settings (`--setting-sources project`), no saved session, and a working directory in a temporary folder outside this lab, so the reviewer cannot read the answer key. Reviews return JSON findings with file, line, severity, title, and explanation.

## Scoring

A planted bug is caught when a finding points at the answer's file and contains one of the answer's keywords; severity and line distance are recorded. Everything else is noise; on the three clean pull requests every finding is a false alarm. The rules are in the header of [`score.mjs`](score.mjs). Misses and a sample of catches were read by hand; no automatic score needed correcting (an override file would be applied and listed in the summary).

## Run it

Requires the Claude Code CLI (`claude`), git, and Node.js 18 or newer. Reviews count against your Claude plan or API usage.

```bash
node build-prs.mjs                 # build prs/<id>/ from prs/definitions.mjs
node review.mjs                    # 12 PRs x 4 setups x 3 runs into results/raw/
node score.mjs                     # results/summary.md, results/scored.csv

node build-prs.mjs --set followup
node review.mjs --set followup     # into results/followup/raw/
node score.mjs --set followup
node chart.mjs                     # results/charts/conditions.svg
```

`review.mjs --prs <id> --conditions diff-plain --reps 1` runs a subset; rerunning skips reviews already saved.

## Limits

- One tool and one model; other reviewers, and newer models, may behave differently.
- Bugs from familiar categories, one per pull request, in diffs of 8 to 33 lines.
- A small repository (about 30 files); in a large one the reviewer cannot read everything.
- A fixed JSON prompt rather than a pull-request bot's own prompting.
- The follow-up set was designed after the main run had caught every bug; it was registered before it ran.
