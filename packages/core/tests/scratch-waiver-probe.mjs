// scratch-waiver-probe.mjs
//
// Evaluates real command shapes against gentle-pi's own temp-scratch waiver and
// prints the verdicts as JSON.
//
// This script must run under bun: gentle-pi ships TypeScript source only, and
// node refuses to strip types inside node_modules.
//
// It is driven by bash-policy-scratch-waiver.test.ts, which asserts that the
// guidance written into ~/.pi/agent/policy/operator-policy.md still matches
// what gentle-pi actually does.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync } from "node:fs";

const GENTLE = "/home/hleyf/.pi/agent/npm/node_modules/gentle-pi";
const { recognizeDestructiveCommands } = await import(`${GENTLE}/lib/destructive-command-guard.ts`);
const { defaultTempScratchFs, isTempScratchRemoval } = await import(`${GENTLE}/lib/yolo-temp-scratch.ts`);

const fs = defaultTempScratchFs();

/** Mirrors gentle-pi's isReversibleYoloCommand scratch condition. */
function waived(command) {
	const effects = recognizeDestructiveCommands(command);
	return effects.some((e) => e.removalTargets !== undefined && isTempScratchRemoval(e, fs));
}

/** A non-git destructive effect is what raises the data-loss confirmation. */
function raisesDialog(command) {
	const effects = recognizeDestructiveCommands(command);
	return effects.some((e) => e.kind !== "git");
}

const real = execFileSync("mktemp", ["-d", "-p", "/tmp", "tmp.XXXXXX"], { encoding: "utf8" }).trim();
const link = `/tmp/scratch-waiver-probe-${process.pid}`;
symlinkSync(real, link);
const file = `/tmp/scratch-waiver-probe-${process.pid}.log`;
execFileSync("touch", [file]);

const verdicts = {
	// Documented as prompt-free.
	mktemp_dir_alone: waived(`rm -rf ${real}`),
	mktemp_dir_first_in_chain: waived(`rm -rf ${real} && mkdir -p /tmp/next`),
	symlink_removed: waived(`rm -rf ${link}`),
	// Documented as still prompting.
	cd_prefix: waived(`cd /tmp && rm -rf ${real}`),
	relative_path: waived(`rm -rf ${real.slice("/tmp/".length)}`),
	descriptive_name: waived(`rm -rf /tmp/rules-probe`),
	pipe_after: waived(`rm -rf ${real} | tee /tmp/log`),
	// A redirect on the rm line is read as another target.
	redirect_on_rm_line: waived(`rm -rf ${real} 2>/dev/null`),
	// Any earlier rm, even a non-recursive one, resets the chain.
	rm_f_before_recursive_rm: waived(`rm -f /tmp/a.txt && rm -rf ${real}`),
	recursive_rm_before_rm_f: waived(`rm -rf ${real} && rm -f /tmp/a.txt`),
	// A plain file removal never raises the dialog.
	file_without_recursive_flag: raisesDialog(`rm -f ${file}`),
};

rmSync(link, { force: true });
if (existsSync(file)) rmSync(file, { force: true });
if (existsSync(real)) rmSync(real, { recursive: true, force: true });

process.stdout.write(JSON.stringify(verdicts));