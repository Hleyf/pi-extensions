# pi-policy-core

The shared engine behind the [Pi command-policy extensions](../..).

A policy extension decides whether a shell command is allowed to run. It is
**deny-only**: it can add a denial, never grant a permission. Pi's `tool_call`
dispatch short-circuits on the first handler that returns a truthy `block`, and
the agent loop reads only `block` — so a handler returning `{ block: false }` is
identical to returning `undefined`, and no extension can lift a confirmation
another layer already raised.

This package holds the parts every policy extension needs and none of them
should own:

- splitting a command into segments the way gentle-pi does
- tracking the effective directory across `cd` and `git -C`
- matching policy rules, and confining a path-scoped command to its allowed roots
- loading policy files, with a user override beating a packaged default
- the `tool_call` handler, the tier semantics, and failing closed

Domain knowledge does not live here. Which branches are protected, what a
`git push` may target, which files may be deleted — that belongs to the
packages that own those domains.

## No runtime dependency on Pi

The Pi package types are used with `import type` only, so they are erased
before the module runs. Pi injects `@earendil-works/pi-coding-agent` as a
virtual module to the extensions it loads, but a published library must not
require it at runtime.

## Install

```sh
pi install npm:pi-policy-core
```

Usually installed as a dependency of `pi-bash-policy` or `pi-git-policy`
rather than directly.
