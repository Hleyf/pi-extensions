# pi-git-policy

Locks commits and pushes to protected branches, and blocks dangerous git
operations.

The package plugs two git-specific rules into
[`pi-policy-core`](../core), the shared command-policy engine:

| Rule | What it stops |
|---|---|
| **Protected-branch push** | `git push origin main` and every other spelling of a push that names a protected branch. |
| **Hidden-argument push** | `git push origin $BRANCH`, `git push origin $(git rev-parse HEAD)`, `git push origin "main"` — a push whose real target the policy cannot see. |
| **Branch lock** | `git commit` and a bare `git push` while the current branch of the directory is protected. |

It also carries the generic git rules: force pushes, `git reset --hard` and
`git clean -f` are blocked; history rewrites (`git filter-branch`, `git
update-ref`, `git reflog expire`) need confirmation.

## It cannot grant permission

This package is **deny-only**. Pi's `tool_call` dispatch short-circuits on the
first handler that returns a truthy `block`, and the agent loop reads only
`block` — so a handler returning `{ block: false }` is identical to returning
`undefined`, and no extension can lift a confirmation another layer already
raised. Everything here can only ever *add* a denial. Where a permission is
needed, it has to come from the harness's own configuration.

The policy is read from disk on **every** tool call, so an edited policy file
takes effect without restarting the agent.

## Install

```sh
pi install npm:pi-git-policy
```

## The policy file

The shipped default lives at `policies/git.json` inside the package. To tune
it, copy it into the user policy directory — a user override always beats the
packaged default:

```sh
mkdir -p ~/.pi/agent/policies
cp ~/.pi/agent/npm/node_modules/pi-git-policy/policies/git.json ~/.pi/agent/policies/git.json
```

| Setting | Meaning |
|---|---|
| `protected_branches` | The branches that may not be pushed to and may not be committed on. The shipped default is `["main", "master"]`. |
| `always_block` | Patterns that are always denied. |
| `always_confirm` | Patterns that always need a human. |
| `always_allow` | Patterns that are known-safe. Not a security control: an allow entry never suppresses a block or a confirmation. |

The shipped defaults are deliberately generic. `main` and `master` are the two
names every repository agrees on; `production` and `live` are a personal
choice and belong in your own override:

```json
{
  "protected_branches": ["main", "master", "production", "live"]
}
```

The protected-branch push pattern is **built at runtime** from
`protected_branches`, so editing that array changes the behaviour
immediately. A protected branch is matched as a whole token and only as the
push destination, which is why `git push origin domain` (which merely ends
with the letters "main") and `git push origin main-branch` stay allowed.

## Division of labour

- **This package** catches commands that *name* a protected branch, and
  commands decided by the *current* branch — the branch lock reads the branch
  of the directory the segment actually runs in, following `cd` and `git -C`.
- **The repository's own hooks** catch everything else: a `git merge` that
  happens to run on `main`, a force push inside a helper script, a hook that
  rewrites history, a server-side rule.
- **The human** has the final say. A confirmation is only a confirmation.

## Deliberate limits

- `git merge <feature>` while on `main` also moves `main` and is **not**
  blocked. Only `commit` and `push` are locked.
- `git merge $BRANCH` is not blocked: only `push` can reach a remote.
- `git push origin refs/heads/main` is not recognised as a push to `main`:
  the whole-token rule deliberately refuses to guess inside a path.

## Development

```sh
npm install
npm run typecheck
npm test
```

## Licence

MIT — see [LICENSE](../../LICENSE).
