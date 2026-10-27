// pi-git-policy
//
// Locks commits and pushes to protected branches, and blocks dangerous git
// operations.
//
// WHAT THIS IS
// A deny-only git policy gate, built on pi-policy-core. It adds the two
// protections a git command line cannot express by itself:
//
//   1. The hidden-argument rule. A `git push` whose arguments are hidden behind
//      a variable, a substitution, a glob or quoting could be aiming at a
//      protected branch while the command string says nothing, so it is
//      refused rather than trusted.
//
//   2. The branch lock. `git commit` and a bare `git push` move whatever branch
//      HEAD points at, so they are blocked when the current branch of the
//      segment's effective directory is protected.
//
// WHAT IT IS NOT
// It cannot grant permission. Pi's `tool_call` dispatch is deny-only: the first
// handler that returns a truthy `block` short-circuits every later handler, and
// the agent loop reads only `block`. A handler returning `{ block: false }` is
// therefore identical to returning `undefined`. The silent path here returns
// `undefined`, never `{ block: false }`.
//
// THE PROTECTED-BRANCH PATTERN IS BUILT AT RUNTIME
// The list of protected branches lives in the policy file, and the pattern that
// recognises a push to one of them is compiled from that list on every call.
// A hardcoded regex would silently ignore a user override; deriving the
// pattern keeps the policy file the single source of truth.
//
// A protected branch is matched as a WHOLE TOKEN: it must be delimited by
// whitespace, a quote, a colon or a plus, and must not be followed by a word
// character or a hyphen. That is what keeps `git push origin domain` (which
// merely ends with the letters "main") and `git push origin main-branch` out of
// the blocked set.
//
// DIVISION OF LABOUR
// Commands that NAME a protected branch are caught here: the intent is
// provable from the command string alone. Commands decided by the CURRENT
// branch are caught here too: the branch lock reads the branch of the
// segment's effective directory. Everything else — an ordinary `git merge`
// that happens to run on main, a force push inside a helper script, a hook
// that rewrites history — is the repository's own hook's job.
//
// LIMITS (deliberate)
//   - `git merge <feature>` while ON main also moves main and is not blocked;
//     only `commit` and `push` are locked.
//   - `git merge $BRANCH` is not blocked: only `push` can reach a remote.
//   - `git push origin refs/heads/main` is not recognised as a push to main:
//     the whole-token rule deliberately refuses to guess inside a path.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildToolCallHandler,
	classify as coreClassify,
	loadPolicy,
	type Decision,
	type DomainPolicy,
	type PolicySet,
	type SegmentInfo,
} from "pi-policy-core";

const execFileAsync = promisify(execFile);

/** The packaged policy directory, resolved from this module's own location. */
const packagedPolicyDir = fileURLToPath(new URL("../policies/", import.meta.url));

/**
 * Read the git policy.
 *
 * Re-read on every tool call rather than cached at module load, so an edited
 * override takes effect without restarting the agent. The core's `loadPolicy`
 * resolves a user override (~/.pi/agent/policies/git.json) before the
 * packaged default, so the user's file always wins.
 */
export function loadPolicies(): PolicySet {
	return { git: loadPolicy("git", packagedPolicyDir) };
}

// --- Patterns --------------------------------------------------------------

/**
 * `git push` reached by name or by path, with optional global flags
 * (`-C <dir>`, `-c k=v`, `--git-dir`, ...).
 */
const GIT_PUSH_HEAD = /^(?:[\w./-]*\/)?git(?:\s+--?\S+(?:\s+[^-\s]\S*)?)*\s+push\b/;

/**
 * Arguments the policy cannot see through. A `git push` containing any of
 * these could be hiding its real target, so it is refused rather than trusted.
 */
const HIDDEN_ARGS = /[$`\\()[\]{}*?"']/;

/**
 * The git verb of a segment head, with the global flags before it skipped.
 */
const GIT_GLOBAL = /^(?:[\w./-]*\/)?git(?:\s+--?\S+(?:\s+[^-\s]\S*)?)*\s+([A-Za-z][\w-]*)/;

/** Push flags that move tags rather than the branch. */
const TAGS_ONLY_FLAGS = /^(?:--tags|--follow-tags|-t)$/;

/** The verbs that move whatever branch HEAD points at. */
const BRANCH_LOCKED_VERBS: ReadonlySet<string> = new Set(["commit", "push"]);

const HIDDEN_ARGS_REASON =
	"this git push hides its remote or branch behind a variable, substitution, glob or quoting, so the protected-branch policy cannot verify it. Write the remote and branch literally, e.g. `git push origin my-feature-branch`, and retry.";

const PROTECTED_PUSH_REASON =
	"push targets a protected branch; protected branches are guarded by policy, repo hooks and human review";

/** Escape a branch name so it can be used as a literal in a pattern. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The protected-branch push pattern, compiled from the policy's
 * `protected_branches` array.
 *
 * The shape is the one the reference implementation used, with the branch
 * names injected instead of hardcoded:
 *
 *   \bgit … \s+push\b (?= … [\s:'"+] (?:main|master) (?![\w-]) )
 *
 * The lookahead only looks inside the segment (the character class excludes
 * `;`, `&`, `|`, and newlines), so a protected name in a LATER segment cannot
 * make an EARLIER segment look protected.
 *
 * The name must be delimited on the left by whitespace, a quote, a colon or a
 * plus (the refspec forms `HEAD:main`, `+main`, `"main"`), and must not be
 * followed by a word character or a hyphen. That is what keeps
 * `git push origin domain` and `git push origin main-branch` allowed.
 */
const protectedPatternCache = new Map<string, RegExp | null>();

export function protectedPushPattern(branches: readonly string[]): RegExp | undefined {
	const names = branches.map((branch) => branch.trim()).filter((branch) => branch !== "");
	const key = names.join("\u0000");
	const cached = protectedPatternCache.get(key);
	if (cached !== undefined) return cached ?? undefined;

	const pattern =
		names.length === 0
			? null
			: new RegExp(
					`\\bgit(?:\\s+--?\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+push\\b(?=[^;&|\\n]*[\\s:'"+](?:${names
						.map(escapeRegExp)
						.join("|")})(?![\\w-]))`,
				);
	protectedPatternCache.set(key, pattern);
	return pattern ?? undefined;
}

// --- The static pass: one synchronous guard per segment ---------------------

/**
 * The per-segment guard.
 *
 * Two rules live here, both decidable from the command string alone:
 *   - a `git push` with hidden arguments is refused;
 *   - a `git push` that names a protected branch is refused.
 *
 * The protected-branch pattern is rebuilt from the policy on every call, so a
 * user override of `protected_branches` changes the behaviour immediately.
 */
export function segmentGuard(info: SegmentInfo, policy: DomainPolicy): Decision | undefined {
	// The protected-branch rule fires on a push COMMAND, not on any text that
	// happens to mention one. A commit message that says "git push origin main"
	// is prose, and blocking it would make the policy unusable for describing
	// the very thing it prevents.
	if (GIT_PUSH_HEAD.test(info.head)) {
		const pattern = protectedPushPattern(policy.protected_branches ?? []);
		if (pattern !== undefined && pattern.test(info.text)) {
			return { tier: "block", reason: PROTECTED_PUSH_REASON, domain: "git", segment: info.text };
		}
	}

	// Only `push` can move a protected branch on a remote. Refusing a hidden
	// argument on `checkout`/`merge` would block `git checkout "main"`, which
	// is harmless.
	if (GIT_PUSH_HEAD.test(info.head) && HIDDEN_ARGS.test(info.text)) {
		return { tier: "block", reason: HIDDEN_ARGS_REASON, domain: "git", segment: info.text };
	}

	return undefined;
}

// --- The branch lock: one asynchronous guard per segment -------------------

/**
 * Current branch name, or undefined when git cannot answer.
 *
 * Failing open here is deliberate: undefined means the directory is not a
 * repository, git is unavailable, or HEAD is detached — in each of those cases
 * the `git commit` or `git push` about to run fails too, so there is nothing
 * to protect. A protected branch always yields a name.
 */
async function currentBranch(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			timeout: 2000,
			maxBuffer: 1024,
			windowsHide: true,
		});
		const branch = stdout.trim();
		return branch === "" ? undefined : branch;
	} catch {
		return undefined;
	}
}

/** Non-flag words after the git verb. */
function gitOperands(head: string): string[] {
	const match = GIT_GLOBAL.exec(head);
	if (match === null) return [];
	const rest = head.slice(match[0].length);
	return rest
		.split(/\s+/)
		.filter((word) => word.length > 0 && !word.startsWith("-"));
}

/**
 * The branch lock.
 *
 * `git commit` and a bare `git push` move whatever branch HEAD points at, so
 * they are blocked when the current branch of the segment's effective
 * directory is protected. The effective directory comes from the core, which
 * follows `cd` and `git -C`, so `cd /other/repo && git commit` is judged
 * against /other/repo.
 */
export async function asyncGuard(
	info: SegmentInfo,
	policy: DomainPolicy,
): Promise<Decision | undefined> {
	const protectedBranches = new Set(policy.protected_branches ?? []);
	if (protectedBranches.size === 0) return undefined;

	const match = GIT_GLOBAL.exec(info.head);
	if (match === null) return undefined;
	const verb = match[1];
	if (verb === undefined || !BRANCH_LOCKED_VERBS.has(verb)) return undefined;

	// Tag-only pushes move tags, never the branch.
	if (verb === "push" && info.head.split(/\s+/).some((word) => TAGS_ONLY_FLAGS.test(word))) {
		return undefined;
	}

	// Two operands mean an explicit refspec, which the static patterns already
	// judge by name. One operand (or none) means the current branch is used.
	if (verb === "push" && gitOperands(info.head).length >= 2) return undefined;

	const branch = await currentBranch(info.cwd);
	if (branch === undefined || !protectedBranches.has(branch)) return undefined;

	return {
		tier: "block",
		reason: `protected branch '${branch}' is locked in ${info.cwd}; commit to a feature branch and open a pull request instead`,
		domain: "git",
		segment: info.text,
	};
}

// --- Classification and the handler ----------------------------------------

/**
 * Classify one command against a policy set.
 *
 * The core runs the static pass first — blocks, then path scope, then
 * confirms — with the segment guard plugged in, and only then the
 * asynchronous guard, which is where the branch lock lives.
 */
export async function classify(
	command: string,
	policies: PolicySet,
	options: { cwd: string },
): Promise<Decision> {
	return coreClassify(command, policies, {
		cwd: options.cwd,
		hooks: { segmentGuard, asyncGuard },
	});
}

/** Build the `tool_call` handler. */
export function createHandler(loader: () => PolicySet = loadPolicies) {
	return buildToolCallHandler(loader, classify, "git policy");
}

const handler = createHandler();

export default function gitPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => handler(event, ctx));
}
