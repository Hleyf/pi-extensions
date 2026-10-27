# bash-policy enforcer

User-level Pi extension that hard-protects `main`/`master` and enforces a deny-only
bash policy. Confirmed gap: gentle-pi has no protected-branch concept at all, and
its YOLO path silently waives an ordinary `git push origin main` via
`isReversibleYoloCommand`. Scope: `~/.pi/agent/` only.

## Specs

### S1 — Compound-command classification (verbatim from the handoff)

Required: split on `&&`, `||`, `;`, `|` and newlines; evaluate every segment; take
the strictest tier found. Never short-circuit on a first allow match. `git -C <dir>`
and `cd <dir> &&` must still trigger branch protection.

| Input                                    | Expected           |
|------------------------------------------|--------------------|
| `git status; git push --force origin main` | blocked            |
| `echo ok && git push origin master`        | blocked            |
| `git add . \|\| rm -rf node_modules`       | confirm or blocked |
| `git -C /other/repo push origin main`      | blocked            |
| `cd /other/repo && git push origin main`   | blocked            |
| leading whitespace / tabs                  | still classified   |
| `git   push    origin main`                | still classified   |

Alternative rejected by decision: a strict metacharacter gate that rejects chained
commands wholesale. Evidence: gentle-pi already establishes
`YOLO_SEGMENT_END_RE = /&&|\|\||;|\||\n|\r/` as this codebase's convention, and a
wholesale gate would block everyday safe work (`npm run build && npm test`,
`ruff check . | head`), training the user to disable the extension.

### S2 — Evaluation contract (verbatim from the handoff)

Evaluate per command: classify domain → split into segments → drop or flag any
containing metacharacters → take the strictest tier across all segments.

- `always_block` → `{ block: true, reason }`, no prompt
- `always_confirm` → `ctx.ui.confirm(...)`, block unless approved
- `always_allow` → return `undefined` (silent pass; do **not** return `{ block: false }`)

```json
{
  "domain": "git",
  "protected_branches": ["main", "master", "production", "live"],
  "always_block": [
    { "pattern": "git\\s+push\\s+(--force|-f)\\b", "reason": "history rewrite" },
    { "pattern": "git\\s+reset\\s+--hard", "reason": "destructive" },
    { "pattern": "git\\s+push\\s+origin\\s+(main|master)\\b", "reason": "protected branch" }
  ],
  "always_confirm": [
    { "pattern": "git\\s+rebase", "reason": "rewrites history" },
    { "pattern": "git\\s+clean\\s+-[a-z]*f", "reason": "removes untracked files" }
  ],
  "always_allow": [
    { "pattern": "^git\\s+(status|log|diff|branch|add|commit|show|rev-parse)\\b" }
  ]
}
```

### S3 — Files

```
~/.pi/agent/extensions/bash-policy.ts      # deny-only enforcer
~/.pi/agent/policies/git.json              # git domain rules
~/.pi/agent/policies/local.json            # local/build domain rules
```

### S4 — Non-negotiable constraints (verbatim from the handoff)

- Protect main/master at three layers: policy block, repo-level hooks, and never
  rely on the agent's judgement.
- Fail closed on internal error. Wrap risky logic; an exception already blocks by
  accident, but never let one silently widen access.
- Branch protection must fire regardless of cwd.
- Do not weaken any existing gentle-pi deny. Order your handler last in
  `settings.json` so it observes final arguments — but understand this changes only
  what it sees, never what gentle-pi decides.
- Tool annotations are not a gate. `readOnlyHint` / `destructiveHint` are
  unverified hints with conservative MCP defaults.
- Never rely on `{ block: false }`. It does nothing.

### S5 — The inert extension (verbatim from the handoff)

> Strong hypothesis to verify first in the next session: gentle-pi's own YOLO mode
> already permits `gh pr create`, which makes `gh-pr-create-yolo-override.ts` not
> merely inert but redundant. If so, the correct action is to delete it and register
> nothing in its place for that command.

### S6 — Enforcer is deny-only (verbatim from the handoff)

> Adjusted: the enforcer is a deny-only gate, not a permissions system. Its job is to
> make the dangerous commands impossible and the safe ones silent, not to grant
> anything the harness would refuse.

### S7 — Branch-aware commit/push lock

> we want to lock commit and push to main/master. checkout could be allowed since
> it cant damage the main/master branch.

`git commit` and a bare `git push` are blocked when the CURRENT branch of the
effective directory is protected. This reads the branch with
`git symbolic-ref --short HEAD`, so it follows `cd <dir> &&` and `git -C <dir>`
rather than assuming the session cwd. `git checkout <protected>` stays allowed:
it moves HEAD, not the branch tip.

This closes the layer the first release deliberately left to repo hooks. It
fails OPEN only when git itself cannot answer (not a repository, git missing,
detached HEAD) — in each case the `git commit` about to run fails too.

### S8 — rm confined to the project folder and temporary directories

> ideally, rm command could be allowed only when it is on the project folder or
> /temp. We must retrict it outside of those boundaries

Deletion is **blocked** unless every target resolves inside the session's
working directory, the system temp directory, `/tmp` or `/var/tmp`. Targets are
resolved per segment, so `cd /other && rm …` is judged against `/other`. A glob
is bounded by its literal prefix, so `./dist/*` stays inside but `/etc/*` does
not. A target the shell would expand at runtime (`$VAR`, `` `cmd` ``, quotes)
is refused rather than trusted.

**The deny-only limit, stated plainly:** this can only ADD a denial. Inside the
project, `rm -rf` is left to gentle-pi's existing data-loss confirmation, which
an extension cannot lift. So the achievable half is the restriction the request
emphasised; the "allowed" half was never ours to grant.

### S9 — A root itself is not a deletable target (refinement of S8)

Raised after review: reports and scratch output are routinely written **directly
into `/tmp`**, not under a scratch subdirectory. That case already worked; the
gap found alongside it was that `rm -rf /tmp` was itself permitted, which would
erase every such report and every other process's temporary files.

A target must therefore resolve *strictly inside* a root. What is inside stays
allowed (`/tmp/report.md`, `dist`, `/var/tmp/checkout`); a root is refused
(`/tmp`, `/var/tmp`, `$TMPDIR`, `.`). One deliberate exception: a glob anchored
exactly at a root names entries within it rather than the directory, so
`rm /tmp/*.md` and `rm *.log` remain allowed.

Note: a project located *inside* `/tmp` is legitimately reachable through the
`/tmp` root. Real projects under `/home` are unaffected.

### S10 — Deletion confined to `~/Projects` and temporary directories

Stated intent: agents should never work outside `~/Projects` or `/tmp`.

**Premise correction.** Not every directory under the home directory is a
project. `~/logiops`, `~/xpadneo` and `~/RazerBatteryTray` are installed programs
on this machine, not work the user does in. With `<project>` (the session's own
directory) still an allowed root, a session that merely *started* in one of them
would have been allowed to delete parts of it. So `<project>` was **removed** from
the allowed roots; the collection is named explicitly instead.

Final allowed roots: `<projects>`, `<tmpdir>`, `/tmp`, `/var/tmp`.

| Command | cwd | Result |
|---|---|---|
| `rm -rf dist`, `rm -rf .` | `~/Projects/cordix` | allowed |
| `rm -rf ~/Projects` | any | **blocked** |
| `rm -rf config` | `~/logiops` | **blocked** |
| `rm -f bin/app` | `~/xpadneo` | **blocked** |
| `rm -rf notes` | `~/Downloads` | **blocked** |
| `rm -rf /tmp/report.md` | any | allowed |
| `rm -rf /tmp` | any | **blocked** |

**Scope limit, stated plainly.** This gate is path-scoped to `rm` only. Confining
it to those roots does NOT stop an agent reading, editing or writing outside them;
it only stops deletion. Enforcing the boundary on every tool is separate work and
is not implied here.

**Operational consequence.** A session whose directory is outside `~/Projects` and
outside `/tmp` will have all `rm` refused there. That is the stated policy, but it
means a session started in, say, `~/scratchpad` cannot delete anything until it
moves into a project or a temp directory.

### S11 — Scratch deletion without the data-loss dialog

The "Allow recognized data-loss command?" prompt for a recursive delete comes
from gentle-pi's destructive-command recogniser. The `tool_call` layer is
deny-only, so **no extension change can remove that dialog** — a rule in this
extension can only add a denial. The only lever is the shape of the command,
which gentle-pi's YOLO temp-scratch waiver recognises.

The waiver requires ALL of: the `rm` first in the command, an absolute literal
path, a direct child of a temporary root, a directory name of exactly `tmp.`
plus letters and digits, and YOLO active. Verified against gentle-pi's own
functions:

| Shape | Waived |
|---|---|
| `rm -rf /tmp/tmp.XXXXXX` | yes |
| `rm -rf /tmp/tmp.XXXXXX && mkdir -p /tmp/next` | yes |
| `rm -rf <symlink>` | yes (symlinks always qualify) |
| `cd /tmp && rm -rf /tmp/tmp.XXXXXX` | no |
| `rm -rf tmp.XXXXXX` | no (relative) |
| `rm -rf /tmp/rules-probe` | no (name) |
| `rm -rf /tmp/tmp.XXXXXX \| tee /tmp/log` | no (pipe) |
| `rm -f /tmp/file` | no dialog at all (no recursive flag) |

**Two further traps, found by testing the two commands that actually produced
dialogs.** Both are recorded in the policy file and pinned by the test:

1. **A redirect on the `rm` line becomes a phantom target.** The tokeniser reads
   `2>/dev/null` as a third target, and the waiver requires *every* target to be
   scratch, so the whole removal stops qualifying — even for a compliant path:
   `rm -rf /tmp/tmp.XXXXXX 2>/dev/null` prompts where `rm -rf /tmp/tmp.XXXXXX`
   does not. The `rm` line must contain nothing but the `rm` and its targets.
2. **Any earlier `rm` resets the chain, even a non-recursive one.**
   `rm -f /tmp/a.txt && rm -rf /tmp/tmp.XXXXXX` prompts;
   `rm -rf /tmp/tmp.XXXXXX && rm -f /tmp/a.txt` does not. The recursive `rm`
   must be the first `rm` in the chain.

Both reported commands therefore still prompt: the first carries a
task-derived directory name *and* the redirect, the second opens with
`cd /tmp &&` *and* puts `rm -f` before the recursive `rm`.

A descriptive directory name is therefore **impossible** — only `tmp.` plus
alphanumerics is accepted, so `/tmp/tmp.probe.XXXXXX` prompts where
`/tmp/tmp.XXXXXX` does not. The memorable handle is carried by a **symlink**
instead, which qualifies whatever its name.

**The rejected alternative.** A project-name prefix rule was considered and
rejected: in a deny-only layer it can only block, and the requirement is a
permission. It would add blocks and remove zero dialogs.

**Delivered as guidance, not code.** The contract is written into
`~/.pi/agent/policy/operator-policy.md` (injected at session start by
`operator-policy.ts`), with a note in the extension header recording why it
lives there and not in code. `tests/bash-policy-scratch-waiver.test.ts` pins
the guidance to gentle-pi's actual behaviour, so a gentle-pi upgrade that
changes the waiver fails the suite instead of silently re-introducing the
dialog. The extension itself needed no functional change.

### S12 — The monorepo split

The single extension became three packages, because the two concerns have
different owners and different audiences:

| Package | Owns |
|---|---|
| `pi-policy-core` | The engine: segment splitting, effective-directory tracking, path scoping, policy loading, the tier semantics, failing closed. |
| `pi-bash-policy` | The `local` domain: the `rm` path scope and the other local rules. |
| `pi-git-policy` | The `git` domain: protected branches, the hidden-argument rule, the branch lock. |

Two decisions inside that split:

- **The protected-branch pattern is compiled at runtime** from the policy's
  `protected_branches` array, not hardcoded in a regex. The policy file is the
  single source of truth, so a user override of that array actually changes
  behaviour. The earlier implementation hardcoded the names in both the array
  and the regex, which meant overriding the array did nothing.
- **Shipped defaults are generic; personalisation lives in a user override.**
  The packaged policies use `"<project>"` (the session's own directory) and
  `["main", "master"]`. A machine whose projects live elsewhere, or whose
  protected branches differ, changes the override in `~/.pi/agent/policies/` —
  never the package.

The engine has no runtime dependency on Pi: the Pi types are `import type` only
and are erased before the module runs.

### S13 — Distribution

- `pi install npm:<name>` for a published package, `pi install git:github.com/hleyf/pi-extensions` for the repository.
- The repository is a monorepo with npm workspaces, so the engine is written
  once and there is no version lockstep between it and its consumers.
- A local install is a live path reference, so edits are picked up without a
  reinstall.

## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1 | inline | RED tests for the S1 table + protected-branch gaps |
| T2 | S2, S3 | inline | `policies/git.json`, `policies/local.json` |
| T3 | S2, S4, S6 | inline | `extensions/bash-policy.ts` |
| T4 | S5 | inline | delete `gh-pr-create-yolo-override.ts`, wire `settings.json` |
| T5 | S4 | inline | typecheck + full suite + load-order proof |
| T6 | S7, S8 | inline | RED tests (real temp git repos + path scope) |
| T7 | S7, S8 | inline | branch detection and rm path scoping |
| T8 | S7, S8 | inline | policy update, full suite, Pi load re-verification |
| T9 | S11 | inline | operator-policy scratch section + extension header note |
| T10 | S11 | inline | scratch-waiver test pinning guidance to gentle-pi behaviour |
| T11 | S12 | inline | split into pi-policy-core, pi-bash-policy, pi-git-policy |
| T12 | S12 | inline | core engine unit tests |
| T13 | S13 | inline | monorepo scaffolding, CI, licence, README |
| T14 | S13 | inline | install into Pi, atomic cutover, end-to-end verification |

No Engram mirror: no `mem_*` tool is available in this session.

## Log

- L1 (original request, verbatim intent): build a user-level Pi extension enforcing
  bash policy — one domain for git, one for local/build, plus hard protection for
  main/master. Scope `~/.pi/agent/` only.

### Verified findings (this session)

- **RISK 1 confirmed.** `dist/core/extensions/runner.js:958-971` — first truthy
  `block` returns immediately; a later handler is never invoked and cannot rescue
  the call. `agent-loop.js:504-513` reads only `beforeResult.block` and, inside the
  block branch, `terminate`. So `{ block: false }` ≡ `undefined`. A throwing handler
  blocks (`agent-session.js:332-344` rethrows).
- **Load order confirmed.** `package-manager.js:718` resolves package sources before
  `resolveLocalEntries` at 721-734 and `addAutoDiscoveredResources` at 736, so
  gentle-pi's handler is always registered ahead of a user extension.
- **Open question 1 confirmed.** `gh` appears nowhere in gentle-pi's
  `DENIED_BASH_PATTERNS`, `GUARDED_KEY_PATTERNS` or guard tables. `gh pr create`
  classifies `not-guarded`, so `confirmCommand` returns `autoGate?.()` = `undefined`
  under YOLO. YOLO already permits it ⇒ the extension is inert *and* redundant.
  **Action: delete it, register nothing for that command.**
- **Open question 3 resolved.** `herdr-agent-state.ts` is a herdr-managed file
  ("managed by herdr; reinstalling overwrites this file"), currently unregistered.
  Not ours to edit; leave untouched.
- **Open question 4 resolved — gentle-pi inventory.** Hard deny: `rm -rf /~/$HOME/./..`,
  `git reset --hard`, `git clean -f -d`, force-push, `chmod -R 777`, `chown -R`,
  plus a real shell tokeniser in `lib/destructive-command-guard.ts` covering `rm -rf`,
  `find -delete/-exec`, `sh -c`/`eval`/backtick recursion, DB payloads, and git
  `reset/clean/push -f/branch -D/restore/rebase/checkout -f/stash drop`.
  Guard → confirm: `gitPush`, `gitRebase`, `gitBranchDeleteForce`, `npmPublish`,
  `piRemove`. **No `runtime-guardrails.json` exists**, so `autonomousMode` is false
  and every guarded key confirms.
- **The gap.** Nothing in gentle-pi knows about protected branches.
  `git push origin main` is an ordinary push, and `YOLO_WAIVABLE_KEYS` contains
  `gitPush`, so YOLO silently waives it. This is the entire justification for T3.
- **Open question 2 (global vs per-project) decided** by S3: global only. The loader
  is written so a project overlay could merge later; not built now (unrequested).

### Design decisions

- **Segment split, not wholesale reject** (see S1 for evidence).
- **Two passes.** Pass 1 applies `always_block` to the *raw* command with
  metacharacters intact, so no chaining, substitution or quoting can hide a
  protected-branch push. Pass 2 splits into segments for `always_confirm`, the
  unanalysable-argument check and the allow fast-path. Strictest tier wins.
- **Unanalysable-argument rule.** A git segment whose verb can mutate refs
  (`push|merge|rebase|reset|checkout|switch|restore|commit`) and which hides
  arguments behind `$ ` \ ( ) [ ] { } * ? " '` is blocked. This is what defeats
  `git push origin $B` and `git push origin 'ma''in'`. `git commit -m "fix"` is
  untouched because `commit` is not a ref-mutating verb for this purpose.
- **`always_allow` is a fast-path, not a security control.** Unmatched commands pass
  through silently to gentle-pi, which remains the default-deny layer. Documented as
  such rather than presented as a gate.
- **No import from `gentle-pi/lib/`.** That is another package's private internals
  and would not survive a version bump; a small self-contained splitter is cheaper
  than the coupling.
- **Unanalysable rule narrowed to `git push` only** (changed after writing the
  tests). `git checkout "main"` and `git merge $BRANCH` are local ref motion: they
  cannot reach a remote protected branch and are reflog-recoverable. Blocking them
  would have been a false positive on `git checkout "main"`, which is harmless and
  common. Tests were corrected to assert the narrow, defensible scope.
- **`always_allow` reordered after `always_confirm`** (found while reviewing the
  finished code). The allow fast path originally `continue`d before the per-segment
  confirm scan, so an allow entry could silently disarm a confirm entry for the same
  command. Confirm now runs first; allow only skips what remains.
- **Protected-branch pattern requires a delimiter before the branch name.** The
  first version used a bare word-boundary guard, which blocked `git push origin
  domain` — `domain` literally ends in `main`, so the trailing `(?![\w-])` could not
  help. Caught by a RED case, fixed by requiring `[\s:'"+]` before the name. Also
  removes the same false positive for `alive`/`olive` against `live`.
- **Cover `bash_background` and `monitor`, not just `bash`.** gentle-pi treats all
  three as shell-command tools; a `bash`-only gate would have been trivially
  bypassed by running the same command under `bash_background`.
- **`rm -rf` overlaps gentle-pi deliberately.** S1's table requires the enforcer
  itself to return confirm-or-block for `git add . || rm -rf node_modules`.
  gentle-pi already confirms it, so an approval now costs a second dialog. Accepted:
  it makes the gate self-contained rather than dependent on gentle-pi's guardrail
  config.
- **Bare `git push` is not blocked** and is documented in the extension header as a
  layer-2 concern, together with bare `git commit` on main.

## Outcome

- Tests: 103 pass, 0 fail (`~/.pi/agent/tests/`, `node --test`). RED was observed
  first at 28 pass / 42 fail (pattern tier), then 9 pass / 15 fail (scope tier).
- Load check: `bash-policy.ts` loads through Pi's own `discoverAndLoadExtensions`
  with 0 errors and 0 warnings, matching the two extensions already in use.
- Architecture guards: 5 tests pin the RISK 1 load-order and deny-only claims
  against the installed runtime; they skip rather than fail if Pi relocates code.
- No commits: `~/.pi/agent` is not a git repository, so there is no work-unit
  commit to record. The retired extension was **moved** to
  `~/.pi/agent/retired/gh-pr-create-yolo-override.ts.bak` rather than deleted,
  because it is untracked and therefore not recoverable from history.

### Requirement change (second round)

S7 and S8 arrived after the first release. Consequences recorded here rather
than left implicit:

- **S1's `git add . || rm -rf node_modules` row is superseded.** It required
  confirm-or-block; the new directive confines `rm` by path instead, so an
  in-project target is no longer this gate's business. The test now asserts the
  supersession explicitly rather than being deleted.
- **`rm -rf` was removed from `local.json` `always_confirm`** and replaced by the
  `path_scoped` rule. This also removes the double-dialog overlap with
  gentle-pi that the first release accepted.
- **A first commit to an unborn protected branch is blocked.** `git init` on
  this machine defaults to `master`, so bootstrapping a new repo needs
  `git checkout -b <branch>` first. Deliberate: it is still a commit to main.
- **Not locked, flagged for the user:** `git merge <feature>` while ON main also
  moves main, as do `git revert` and `git reset` on main. Only `commit` and
  `push` were specified. Adding them is one more entry in
  `BRANCH_LOCKED_VERBS`.