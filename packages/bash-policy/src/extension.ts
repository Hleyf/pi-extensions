// pi-bash-policy
//
// A deny-only Pi extension that confines destructive shell commands to the
// project folder and temporary directories.
//
// WHAT THIS IS
// The `rm` path scope is the centrepiece: every target of an `rm` segment must
// resolve inside the session's own directory, inside the system temporary
// directory, or inside /tmp or /var/tmp. A target that resolves elsewhere is
// denied before it runs. A target that cannot be resolved at all — a variable,
// a command substitution, a quoted path — is denied too, because a policy that
// trusts what it cannot see is not a policy.
//
// WHY IT IS DENY-ONLY
// Pi's `tool_call` dispatch short-circuits on the first handler that returns a
// truthy `block`, and the agent loop reads only `block`. A handler returning
// `{ block: false }` is therefore identical to returning `undefined`: this
// extension can ADD a denial, never grant a permission. The engine in
// `pi-policy-core` owns that contract; this package only supplies the local
// domain rules.
//
// NO RUNTIME DEPENDENCY ON PI
// The Pi package types are imported with `import type` only, so they are erased
// before the module runs and a published library never requires the agent at
// runtime.

import { fileURLToPath } from "node:url";
import {
	buildToolCallHandler,
	classify,
	loadPolicy,
	type ContextLike,
	type Decision,
	type PolicySet,
	type ToolCallLike,
	type ToolCallResultLike,
} from "pi-policy-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The policy directory shipped inside this package. */
export const packagedPolicyDir = fileURLToPath(new URL("../policies/", import.meta.url));

/** The handler shape this extension registers with Pi. */
export type ToolCallHandler = (
	event: ToolCallLike,
	ctx: ContextLike,
) => Promise<ToolCallResultLike | undefined>;

/**
 * Load the local domain policy.
 *
 * Read on every tool call rather than cached at module load, so an edited
 * override takes effect without restarting the agent. The engine resolves the
 * file: a user override under the agent's policy directory beats the packaged
 * default, so the shipped rules are a floor, not a cage.
 */
export function loadPolicies(): PolicySet {
	return { local: loadPolicy("local", packagedPolicyDir) };
}

/**
 * Classify one command against a policy set.
 *
 * The engine decides the tier: `block`, `confirm` or `silent`. Anything the
 * engine cannot read fails closed, so a broken policy narrows access instead
 * of widening it.
 */
export async function classifyCommand(
	command: string,
	policies: PolicySet,
	options: { cwd: string },
): Promise<Decision> {
	return await classify(command, policies, { cwd: options.cwd });
}

/**
 * Build the `tool_call` handler.
 *
 * The engine's handler already fails closed: an internal error becomes a
 * block, and the silent path returns `undefined` rather than `{ block: false }`.
 */
export function createToolCallHandler(): ToolCallHandler {
	return buildToolCallHandler(loadPolicies, classifyCommand, "bash policy");
}

export default function bashPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => createToolCallHandler()(event, ctx));
}
