# The load contract

This repository is a **loadable Pi package**. That is a contract, not a
convenience, and it is enforced by tests.

## The failure this prevents

The repository was restructured into an npm workspace monorepo. The workspace
root is a directory with no entry point and no Pi manifest, and the machine's
Pi configuration still pointed at it. Pi hands a package directory that
declares no resources to the module loader, so every agent subprocess died
before the agent started:

```
Error: Failed to load extension "/home/hleyf/Projects/pi-extensions":
Failed to load extension: Cannot find module '/home/hleyf/Projects/pi-extensions'
```

Every route through the agent was dead with it: the writer, the verifier, and
every session that read the same configuration.

Nothing about the policies was wrong. The *packaging* was wrong, so the
packaging is what is tested.

## The rules

1. **The root package.json carries a `pi` manifest.** It names the extensions
   this workspace ships:

   ```json
   "pi": {
     "extensions": [
       "./packages/bash-policy/src/extension.ts",
       "./packages/git-policy/src/extension.ts"
     ]
   }
   ```

2. **Every named entry exists** on disk, inside this repository.

3. **The root names exactly the extensions the workspace packages ship.** The
   union of the packages' own manifests and the root's manifest are the same
   set: nothing declared twice, nothing missing.

4. **Every entry module imports cleanly** and exports a default extension
   factory. This is the import Pi performs, over the same module graph.

5. **The root resolves as a module.** The root's `main` points at `index.ts`,
   which re-exports the shared engine. The "Cannot find module" failure is
   then impossible for this path, whatever a loader does with the manifest.
   (`main` is what carries this: a directory is resolved by its `main` or an
   index file, and `exports` is not consulted for a path. `exports` is here
   for the bare-specifier import, `import "pi-extensions"`.)

## Where each rule is enforced

| Rule | Enforced by |
|---|---|
| 1, 2, 3, 4, 5 | `tests/load-contract.test.ts` |
| The whole contract as Pi sees it | `tests/pi-loads-repository.test.ts` |
| The path this machine's configuration points at | `npm run check:installed` |

`tests/pi-loads-repository.test.ts` is the end-to-end one: it points Pi's own
loader at this repository through a scratch agent directory and asserts that
Pi resolves both extensions, registers their `tool_call` handlers, and reports
no errors. The test itself reads nothing outside the repository, so it holds
in CI. Pi's loader, once it runs, reads the user's own skill directories —
as it does on every startup anywhere.

## The machine-local half

The suite asserts the contract this repository declares. It cannot assert
that the configuration on one particular machine points at something that
loads — that is not true on every machine, so it cannot be a CI test.

`npm run check:installed` asserts it, and it is opt-in:

```sh
npm run check:installed
```

It resolves every local path in the global and project settings the way Pi
resolves it, and reports the three ways that can go wrong:

- a path that does not exist — Pi skips it **silently**, so the policy is
  simply not loaded;
- a directory with no manifest and no entry point — Pi hands it to the module
  loader and fails with "Cannot find module";
- a manifest naming entries that do not exist — Pi loads what it can and says
  nothing about the rest.

It reads the configuration. It never writes it.

## What is not in the contract

The **behaviour** of the policies is not here. The policies are deny-only and
their rules are pinned by the package suites. This document is about how the
packages are *loaded*.

Nor is the machine's global configuration: `~/.pi/agent/settings.json` belongs
to the owner of the machine, and this repository does not change it.
