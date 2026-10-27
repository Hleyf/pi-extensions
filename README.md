# pi-extensions

Command-policy extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono).

A policy extension decides whether a shell command is allowed to run. It is
**deny-only**: it can add a denial, never grant a permission.

That limit is not a design preference, it is the shape of the platform. Pi's
`tool_call` dispatch short-circuits on the first handler that returns a truthy
`block`, and the agent loop reads only `block`. So a handler returning
`{ block: false }` is identical to returning `undefined`, and no extension can
lift a confirmation another layer already raised. Where a permission is needed,
it has to come from the harness's own configuration — not from here.

## Packages

| Package | What it does |
|---|---|
| [`pi-policy-core`](packages/core) | The shared engine: segment splitting, effective-directory tracking, path scoping, policy loading, and a fail-closed `tool_call` handler. |
| [`pi-bash-policy`](packages/bash-policy) | Confines destructive shell commands to the project folder and temporary directories. |
| [`pi-git-policy`](packages/git-policy) | Locks commits and pushes to protected branches. |

## Install

Install one package, or all of them:

```sh
pi install npm:pi-bash-policy
pi install npm:pi-git-policy

# from a git checkout
pi install git:github.com/hleyf/pi-extensions
```

## Configuring a policy

Every package ships a default policy file. To tune it, copy the file to the
user policy directory — a user override always beats the packaged default:

```sh
mkdir -p ~/.pi/agent/policies
cp ~/.pi/agent/npm/node_modules/pi-git-policy/policies/git.json ~/.pi/agent/policies/git.json
```

| Package | Domain | File |
|---|---|---|
| `pi-bash-policy` | `local` | `policies/local.json` |
| `pi-git-policy` | `git` | `policies/git.json` |

The shipped defaults are deliberately generic. Personal choices — which
branches count as protected, where your projects live — belong in your own
override, not in a package that other people install.

## How the two layers interact

gentle-pi is a package, so its `tool_call` handler is always registered before
any user extension. These packages therefore run **after** it, observe final
arguments, and can only ever add a denial.

gentle-pi owns the hard denies and the data-loss confirmation. These packages
own the gaps it leaves: protected branches, and deletion outside the project
folder.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run with Node's built-in runner. Two of them need `bun`, because
gentle-pi ships TypeScript source and Node cannot strip types inside
`node_modules`; they skip when `bun` is unavailable.

## Licence

MIT — see [LICENSE](LICENSE).
