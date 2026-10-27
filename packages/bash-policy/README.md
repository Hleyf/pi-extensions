# pi-bash-policy

A deny-only [Pi](https://github.com/badlogic/pi-mono) extension that confines
destructive shell commands to the project folder and temporary directories.

Its centrepiece is the `rm` path scope: every target of an `rm` segment must
resolve inside the session's own directory, inside the system temporary
directory, or inside `/tmp` or `/var/tmp`. A target that resolves anywhere else
is denied before it runs.

```sh
rm -rf dist            # allowed: inside the project
rm -rf /tmp/report.md  # allowed: inside a temporary directory
rm -rf /etc/hosts      # denied: outside the project and outside every temporary root
rm -rf $TARGET         # denied: a target that cannot be verified at admission time is not trusted
```

## Deny-only

This package can add a denial; it can never grant a permission. Pi's
`tool_call` dispatch short-circuits on the first handler that returns a truthy
`block`, and the agent loop reads only `block` — so a handler returning
`{ block: false }` is identical to returning `undefined`, and no extension can
lift a confirmation another layer already raised. The silent path here returns
`undefined`, never `{ block: false }`.

The engine also fails closed: if the policy cannot be read or a rule cannot be
applied, the command is denied rather than let through.

## Install

```sh
pi install npm:pi-bash-policy
```

## The policy

The shipped policy lives in `policies/local.json` inside the package and covers
the `local` domain: the `rm` path scope, a few commands that destroy data
irreversibly (`mkfs`, raw writes to a block device, `wipefs`), and a few that
deserve a confirmation (`dd of=`, `shred`, `truncate -s`, piping a download
into a shell, world-writable permissions).

To tune it, copy the file into the user policy directory. A user override always
beats the packaged default, and it is read on every tool call — an edited
override takes effect without restarting the agent:

```sh
mkdir -p ~/.pi/agent/policies
cp ~/.pi/agent/npm/node_modules/pi-bash-policy/policies/local.json ~/.pi/agent/policies/local.json
```

The shipped defaults are deliberately generic. Personal choices — where your
projects live, which directories count as scratch space — belong in your own
override, not in a package that other people install.

## The rule

Deletion is confined to the project folder and to temporary directories.

| Root | Meaning |
|---|---|
| `<project>` | The session's own working directory. |
| `<tmpdir>` | The system temporary directory. |
| `/tmp`, `/var/tmp` | The conventional temporary directories. |

A root itself may not be deleted: `rm -rf /tmp` would erase every scratch
report and every other process's temporary files. Only what is strictly inside
a root is deletable, with one exception — a glob anchored exactly at a root
(`rm /tmp/*.md`, `rm *.log`) names entries within it and stays allowed.

The confinement follows `cd`, so a command is judged against the directory it
actually runs in, and it is judged per segment, so `rm -rf dist && rm -rf
/etc/hosts` is denied on its second segment.

## Development

```sh
npm install
npm run typecheck
npm test
```

## Licence

MIT — see [LICENSE](LICENSE).
