# Scratch deletion without the data-loss dialog

The bash tool asks before a recursive delete, because it cannot tell scratch
from data. It does not have to ask — but only for the one command shape that
proves the target is disposable.

This is a property of **gentle-pi**, not of the packages in this repository.
The `tool_call` layer is deny-only: gentle-pi's handler is registered first
(it is a package, and packages resolve before local extension entries), so it
raises the data-loss confirmation before any extension of ours is consulted. An
extension can add a denial; it cannot lift one.

The lever is the shape of the command, which gentle-pi's YOLO temp-scratch
waiver recognises. `packages/core/tests/scratch-waiver.test.ts` pins this
document to gentle-pi's actual behaviour.

## Deleting individual files never triggers it

Use `rm -f` for those. Without a recursive flag there is no destructive effect
at all, so there is nothing to confirm.

## For directories

Create scratch with `mktemp` and never with a hand-written name:

    mktemp -d -p /tmp tmp.XXXXXX          # -> /tmp/tmp.AGfpoG

`mktemp -d` alone also works, but it lands under `$TMPDIR` when that is set, so
`-p /tmp` keeps the location predictable.

To keep a memorable handle, make it a symlink. Symlinks are accepted whatever
their name:

    ln -s /tmp/tmp.AGfpoG /tmp/rules-probe

Then delete with the absolute path, and put the `rm` FIRST in the command:

    rm -rf /tmp/tmp.AGfpoG && rm -f /tmp/rules-probe

## The rules

All four path properties are required: the `rm` comes first, the path is
absolute, the directory is a direct child of a temporary root, and its name is
`tmp.` followed by letters and digits only.

Two more rules about the command itself:

- The `rm` line must contain nothing but the `rm` and its targets. A redirect
  on that line is read as another target, and the removal stops being
  recognised as scratch:

      rm -rf /tmp/tmp.AGfpoG 2>/dev/null    # prompts — "2>/dev/null"
                                           # is read as a target

- The recursive `rm` must be the first `rm` in the chain. An earlier `rm`, even
  a plain `rm -f`, resets it:

      rm -f /tmp/a.txt && rm -rf /tmp/tmp.AGfpoG   # prompts
      rm -rf /tmp/tmp.AGfpoG && rm -f /tmp/a.txt   # no prompt

A `cd` before the `rm`, a relative path, a descriptive directory name, or a
pipe after the `rm` each bring the prompt back:

    cd /tmp && rm -rf /tmp/tmp.AGfpoG      # prompts
    rm -rf tmp.AGfpoG                     # prompts
    rm -rf /tmp/rules-probe                # prompts
    rm -rf /tmp/tmp.AGfpoG | tee /tmp/log  # prompts

A descriptive name is impossible for the directory itself: only `tmp.` plus
letters and digits is accepted, so `/tmp/tmp.probe.XXXXXX` prompts where
`/tmp/tmp.XXXXXX` does not. That is why the handle is a symlink and not the
directory.

## Reuse, don't churn

Reuse one scratch directory for the whole task instead of creating and
destroying one per command. Fewer deletes, fewer prompts.

## Deletion outside the permitted roots

`pi-bash-policy` refuses deletion outside the session's own directory and the
temporary directories. That is a separate concern from the dialog above: the
dialog is gentle-pi asking, the refusal is this repository denying.

## One caveat

The waiver is **YOLO-only**. Without YOLO active, every `rm -rf` confirms
regardless of shape — the data-loss confirmation is not configurable through
`runtime-guardrails.json`, which governs only the guarded git and npm keys.
