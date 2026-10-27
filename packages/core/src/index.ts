// pi-policy-core
//
// The shared engine behind the Pi command-policy extensions.
//
// WHAT THIS IS
// A command-policy extension decides whether a shell command is allowed. The
// decision is deny-only: it can ADD a denial, never grant a permission. Pi's
// `tool_call` dispatch short-circuits on the first handler that returns a
// truthy `block`, and the agent loop reads only `block` — so a handler
// returning `{ block: false }` is identical to returning `undefined`, and no
// extension can lift a confirmation another layer already raised.
//
// WHAT LIVES HERE
// The parts every policy extension needs and none of them should own:
//   - splitting a command into segments the way gentle-pi does
//   - tracking the effective directory across `cd` and `git -C`
//   - matching policy rules, and confining a path-scoped command to its
//     allowed roots
//   - loading policy files, with a user override beating a packaged default
//   - the `tool_call` handler, the tier semantics, and failing closed
//
// WHAT DOES NOT LIVE HERE
// Domain knowledge. Which branches are protected, what a `git push` is
// allowed to target, which files may be deleted — that belongs to the
// packages that own those domains, not here.
//
// NO RUNTIME DEPENDENCY ON PI
// The Pi package types are used with `import type` only, so they are erased
// before the module runs. Pi injects `@earendil-works/pi-coding-agent` as a
// virtual module to the extensions it loads, but a published library must not
// require it at runtime.

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

// --- Types -----------------------------------------------------------------

export type Tier = "block" | "confirm" | "silent";

export interface PatternRule {
	pattern: string;
	reason?: string;
}

/** Confines a command's targets to a set of directories. */
export interface PathScopeRule {
	/** Command name the rule applies to, e.g. "rm". */
	command: string;
	/**
	 * Directories the command may touch. `<project>` is the session's working
	 * directory, `<projects>` the canonical project collection, `<tmpdir>` the
	 * system temporary directory; anything else is a literal path.
	 */
	allowed_roots: string[];
	reason: string;
}

export interface DomainPolicy {
	domain: string;
	protected_branches?: string[];
	always_block: PatternRule[];
	always_confirm: PatternRule[];
	always_allow: PatternRule[];
	path_scoped?: PathScopeRule[];
}

export type PolicySet = Record<string, DomainPolicy>;

export interface Decision {
	tier: Tier;
	reason?: string;
	domain?: string;
	segment?: string;
	matched?: string;
}

/** One command segment together with the directory it actually runs in. */
export interface SegmentInfo {
	text: string;
	head: string;
	cwd: string;
}

export interface PolicySource {
	path: string;
	origin: "user" | "packaged";
}

/** A decision made from a rule, with the tier it implies. */
export type RuleKind = "block" | "confirm";

// --- Command tools ---------------------------------------------------------

/**
 * The tools that run shell commands. `bash_background` and `monitor` are
 * included because a gate that only covers `bash` is bypassed by running the
 * same command under one of them.
 */
export const SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"bash_background",
	"monitor",
]);

// --- Segment plumbing ------------------------------------------------------

/**
 * gentle-pi's own segment boundary (YOLO_SEGMENT_END_RE). Reused rather than
 * invented, so this engine and gentle-pi agree on what a "command" is.
 */
const SEGMENT_SPLIT = /&&|\|\||;|\||\n|\r/;

/** `git` reached by name or by path. */
const GIT_HEAD = /^(?:[\w./-]*\/)?git\b/;

const CD_HEAD = /^cd(?:\s|$)/;
const GIT_C_DIR = /^(?:[\w./-]*\/)?git\s+-C\s+(?:'([^']*)'|"([^"]*)"|(\S+))/;

/** Split on sequential and pipe operators; keep non-empty trimmed segments. */
export function splitSegments(command: string): string[] {
	return command
		.split(SEGMENT_SPLIT)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

/** Drop leading `VAR=value` assignments and `env` / `command` wrappers. */
export function commandHead(segment: string): string {
	let current = segment.trim();
	for (let previous = ""; current !== previous; ) {
		previous = current;
		current = current.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]*)\s+)+/, "");
		current = current.replace(/^(?:env|command)\s+(?:-{1,2}[^\s]+\s+)*/, "");
	}
	return current;
}

export function domainOf(head: string): "git" | "local" {
	return GIT_HEAD.test(head) ? "git" : "local";
}

/** Expand `~`, `~/…`, `$HOME` and `${HOME}` in a path argument. */
export function expandHome(path: string): string {
	const home = homedir();
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	if (path === "$HOME" || path === "${HOME}") return home;
	if (path.startsWith("$HOME/")) return join(home, path.slice(6));
	if (path.startsWith("${HOME}/")) return join(home, path.slice(8));
	return path;
}

/** Strip one layer of surrounding quotes from a shell word. */
export function unquote(word: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(word);
	return match === null ? word : (match[2] ?? word);
}

/**
 * The segments of a command together with the directory each one runs in.
 *
 * A compound command's later segments run in a different directory than the
 * session's cwd, so both the path scope and any cwd-sensitive check must
 * follow `cd` and `git -C` rather than assuming cwd. This is purely lexical:
 * no filesystem access, and therefore no failure mode.
 */
export function segmentInfos(command: string, baseDir: string): SegmentInfo[] {
	let cwd = resolve(baseDir);
	const infos: SegmentInfo[] = [];
	for (const text of splitSegments(command)) {
		const head = commandHead(text);
		if (CD_HEAD.test(head)) {
			// The `cd` segment itself runs in the directory it starts in; the
			// change applies to the segments that follow it.
			infos.push({ text, head, cwd });
			const target = unquote(head.slice(3).trim().split(/\s+/)[0] ?? "");
			if (target !== "") {
				try {
					const expanded = expandHome(target);
					cwd = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
				} catch {
					// Leave cwd unchanged; the segment itself will fail in the shell.
				}
			}
			continue;
		}
		const gitC = GIT_C_DIR.exec(head);
		let segmentCwd = cwd;
		if (gitC !== null) {
			const target = expandHome(unquote(gitC[1] ?? gitC[2] ?? gitC[3] ?? ""));
			if (target !== "") {
				try {
					segmentCwd = isAbsolute(target) ? target : resolve(cwd, target);
				} catch {
					segmentCwd = cwd;
				}
			}
		}
		infos.push({ text, head, cwd: segmentCwd });
	}
	return infos;
}

// --- Rule matching ---------------------------------------------------------

const regexCache = new Map<string, RegExp>();

/**
 * Compile a policy pattern. An invalid pattern throws, which the fail-closed
 * boundary turns into a block: a rule the engine cannot read must never widen
 * access.
 */
export function compile(pattern: string): RegExp {
	let cached = regexCache.get(pattern);
	if (cached === undefined) {
		cached = new RegExp(pattern);
		regexCache.set(pattern, cached);
	}
	return cached;
}

export function firstMatch(
	rules: readonly PatternRule[] | undefined,
	subject: string,
): PatternRule | undefined {
	if (rules === undefined) return undefined;
	for (const rule of rules) {
		if (compile(rule.pattern).test(subject)) return rule;
	}
	return undefined;
}

/** The first matching rule, expressed as a decision. */
export function matchDecision(
	rules: readonly PatternRule[] | undefined,
	subject: string,
	kind: RuleKind,
	domain: string,
	fallbackReason: string,
): Decision | undefined {
	const hit = firstMatch(rules, subject);
	if (hit === undefined) return undefined;
	return {
		tier: kind,
		reason: hit.reason ?? fallbackReason,
		domain,
		matched: hit.pattern,
	};
}

// --- Path scope ------------------------------------------------------------

/**
 * Shell expansion that would make a target unknowable at admission time.
 * Globs are deliberately NOT in this set: `rm -rf dist/*` is ordinary work and
 * its literal prefix still bounds the check.
 */
const UNVERIFIABLE_TARGET = /[$`\\(){}"']/;

/**
 * A root itself is not a valid target: `rm -rf /tmp` would erase every
 * scratch report and every other process's temporary files, so it is refused.
 * What is strictly INSIDE a root is fine, which is the case that matters.
 *
 * The one exception is a glob anchored exactly at a root: `rm /tmp/*.md` and
 * `rm *.log` name entries within it rather than the directory.
 */
function isScopedTarget(candidate: string, roots: readonly string[], hasGlob: boolean): boolean {
	return roots.some((root) => {
		if (candidate === root) return hasGlob;
		return candidate.startsWith(root + sep);
	});
}

export function allowedRoots(rule: PathScopeRule, projectDir: string): string[] {
	return rule.allowed_roots.map((root) => {
		if (root === "<project>") return resolve(projectDir);
		if (root === "<projects>") return resolve(join(homedir(), "Projects"));
		if (root === "<tmpdir>") return resolve(tmpdir());
		return resolve(expandHome(root));
	});
}

/**
 * Arguments of a path-scoped command. Flags are skipped, `--` ends flag
 * parsing, and a glob is reduced to its literal prefix so `./dist/*` is bounded
 * by the project while `/etc/*` is still seen as escaping it.
 */
export function commandTargets(text: string): string[] {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	const targets: string[] = [];
	let flagsEnded = false;
	for (const word of words.slice(1)) {
		if (!flagsEnded && word === "--") {
			flagsEnded = true;
			continue;
		}
		if (!flagsEnded && word.startsWith("-") && word !== "-") continue;
		targets.push(word);
	}
	return targets;
}

/**
 * Evaluate the path scope rules against every segment of a command.
 * Returns a blocking decision for the first target that escapes its roots.
 */
export function evaluatePathScope(
	rules: readonly PathScopeRule[] | undefined,
	infos: readonly SegmentInfo[],
	projectDir: string,
): Decision | undefined {
	if (rules === undefined) return undefined;
	for (const info of infos) {
		for (const rule of rules) {
			const name = /^([\w./-]+)/.exec(info.head)?.[1];
			if (name !== rule.command) continue;
			const roots = allowedRoots(rule, projectDir);
			for (const target of commandTargets(info.text)) {
				if (UNVERIFIABLE_TARGET.test(target)) {
					return {
						tier: "block",
						reason: `${rule.reason}; this target cannot be verified at admission time: ${target}`,
						domain: "local",
						segment: info.text,
					};
				}
				const unquoted = unquote(target);
				const hasGlob = /[*?[]/.test(unquoted);
				const literalPrefix = unquoted.split(/[*?[]/)[0] ?? "";
				// An empty prefix means a bare glob, which resolves against the cwd.
				const anchor = literalPrefix === "" ? "." : literalPrefix;
				const expanded = expandHome(anchor);
				const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(info.cwd, expanded);
				if (!isScopedTarget(absolute, roots, hasGlob)) {
					return {
						tier: "block",
						reason: `${rule.reason}: ${target} resolves to ${absolute}, outside ${roots.join(", ")}`,
						domain: "local",
						segment: info.text,
					};
				}
			}
		}
	}
	return undefined;
}

// --- Policy loading --------------------------------------------------------

/** Where user policy overrides live. */
export function userPolicyDir(): string {
	const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "policies");
}

/**
 * Resolve a domain's policy file: a user override wins over the packaged
 * default, so a user can tune a policy without reinstalling the package.
 */
export function resolvePolicyPath(domain: string, packagedDir: string): PolicySource {
	const user = join(userPolicyDir(), `${domain}.json`);
	if (existsSync(user)) return { path: user, origin: "user" };
	return { path: join(packagedDir, `${domain}.json`), origin: "packaged" };
}

function readPolicyFile(path: string, domain: string, requireComplete: boolean): DomainPolicy {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (parsed === null || typeof parsed !== "object") {
		throw new Error(`policy ${domain}.json is not an object`);
	}
	const policy = parsed as Partial<DomainPolicy>;
	for (const key of ["always_block", "always_confirm", "always_allow"] as const) {
		if (policy[key] === undefined) {
			if (requireComplete) {
				throw new Error(`policy ${domain}.json is missing a ${key} array`);
			}
			policy[key] = [];
		} else if (!Array.isArray(policy[key])) {
			throw new Error(`policy ${domain}.json has a malformed ${key} array`);
		}
	}
	if (policy.path_scoped !== undefined && !Array.isArray(policy.path_scoped)) {
		throw new Error(`policy ${domain}.json has a malformed path_scoped entry`);
	}
	return policy as DomainPolicy;
}

/**
 * Merge a user override onto the packaged default.
 *
 * The override REPLACES nothing it does not mention. Without this, a user
 * wanting to add one branch to the protected list would have to copy the whole
 * packaged file, and every future default would be stranded in the package
 * rather than reaching them.
 *
 *   - `protected_branches` and `allowed_roots`: the user's value wins outright.
 *   - The rule lists: the user's rules are ADDED to the packaged ones.
 *   - `path_scoped`: merged by command name, so a user can replace the rule
 *     for one command and leave the rest alone.
 */
function mergePolicies(base: DomainPolicy, override: DomainPolicy): DomainPolicy {
	const merged: DomainPolicy = {
		domain: override.domain ?? base.domain,
		always_block: [...base.always_block, ...override.always_block],
		always_confirm: [...base.always_confirm, ...override.always_confirm],
		always_allow: [...base.always_allow, ...override.always_allow],
	};
	const branches = override.protected_branches ?? base.protected_branches;
	if (branches !== undefined) merged.protected_branches = branches;
	if (base.path_scoped !== undefined || override.path_scoped !== undefined) {
		const byCommand = new Map<string, PathScopeRule>();
		for (const rule of base.path_scoped ?? []) byCommand.set(rule.command, rule);
		for (const rule of override.path_scoped ?? []) byCommand.set(rule.command, rule);
		merged.path_scoped = [...byCommand.values()];
	}
	return merged;
}

/**
 * Load a domain's policy: the packaged default, with the user's override
 * merged onto it when one exists.
 */
export function loadPolicy(domain: string, packagedDir: string): DomainPolicy {
	const user = join(userPolicyDir(), `${domain}.json`);
	if (!existsSync(user)) {
		return readPolicyFile(join(packagedDir, `${domain}.json`), domain, true);
	}
	const base = readPolicyFile(join(packagedDir, `${domain}.json`), domain, true);
	const override = readPolicyFile(user, domain, false);
	return mergePolicies(base, override);
}

export function loadPolicySet(domains: readonly string[], packagedDir: string): PolicySet {
	const policies: PolicySet = {};
	for (const domain of domains) policies[domain] = loadPolicy(domain, packagedDir);
	return policies;
}

// --- Classification --------------------------------------------------------

export interface ClassifyHooks {
	/**
	 * Run for every segment before the generic analysis. Returning a decision
	 * short-circuits it. Used by domain packages for checks the engine cannot
	 * express generically.
	 */
	segmentGuard?: (info: SegmentInfo, policy: DomainPolicy) => Decision | undefined;
	/**
	 * Run for every segment after the static pass. May be asynchronous. Only
	 * reached when the static pass did not already block.
	 */
	asyncGuard?: (info: SegmentInfo, policy: DomainPolicy) => Promise<Decision | undefined>;
}

function policyEntries(policies: PolicySet): Array<[string, DomainPolicy]> {
	return Object.entries(policies);
}

/**
 * The generic classification, shared by every policy domain.
 *
 * Order matters and is not negotiable:
 *   1. A block, evaluated against the raw command with metacharacters intact
 *      so chaining, substitution and quoting cannot hide it. Segments are
 *      matched individually too, so a policy author may anchor a rule with `^`.
 *   2. The path scope, so a confinement breach always wins over a confirmation.
 *   3. A confirmation, evaluated against the raw command and each segment.
 *   4. The allow fast path, which skips the rest of a segment's analysis.
 */
export function classifyWithRules(
	command: string,
	policies: PolicySet,
	options: { cwd: string; hooks?: ClassifyHooks },
): Decision {
	const entries = policyEntries(policies);
	const infos = segmentInfos(command, options.cwd);

	// --- Blocks ------------------------------------------------------------
	for (const [domain, policy] of entries) {
		const hit = matchDecision(policy.always_block, command, "block", domain, `${domain} policy denies this command`);
		if (hit !== undefined) return hit;
	}
	for (const info of infos) {
		for (const [domain, policy] of entries) {
			const hit = matchDecision(policy.always_block, info.text, "block", domain, `${domain} policy denies this command`);
			if (hit !== undefined) return hit;
		}
	}

	// --- Path scope --------------------------------------------------------
	for (const [domain, policy] of entries) {
		const denied = evaluatePathScope(policy.path_scoped, infos, options.cwd);
		if (denied !== undefined) return denied;
	}

	// --- Confirms ----------------------------------------------------------
	let confirm: Decision | undefined;
	for (const [domain, policy] of entries) {
		const hit = matchDecision(policy.always_confirm, command, "confirm", domain, `${domain} policy requires confirmation`);
		if (hit !== undefined) {
			confirm = hit;
			break;
		}
	}

	for (const info of infos) {
		const head = info.head;
		for (const [domain, policy] of entries) {
			// A domain package's own check for this segment.
			const guarded = options.hooks?.segmentGuard?.(info, policy);
			if (guarded !== undefined) return guarded;

			if (confirm === undefined) {
				const hit = matchDecision(policy.always_confirm, info.text, "confirm", domain, `${domain} policy requires confirmation`);
				if (hit !== undefined) {
					confirm = { ...hit, segment: info.text };
				}
			}

			// The allow fast path skips the rest of this segment's analysis. It
			// is NOT a security control: the blocks above and the raw confirm
			// have already run, and an unmatched command defaults to silent
			// anyway. It exists so a policy author can record which commands
			// they consider safe, and so raising the default tier later has an
			// explicit escape list.
			if (firstMatch(policy.always_allow, head) !== undefined) continue;
		}
	}

	return confirm ?? { tier: "silent" };
}

/**
 * The full classification: the static pass first, then the asynchronous
 * guard when the static pass did not already deny.
 */
export async function classify(
	command: string,
	policies: PolicySet,
	options: { cwd: string; hooks?: ClassifyHooks },
): Promise<Decision> {
	const staticDecision = classifyWithRules(command, policies, options);
	if (staticDecision.tier === "block") return staticDecision;
	if (options.hooks?.asyncGuard !== undefined) {
		for (const info of segmentInfos(command, options.cwd)) {
			for (const [, policy] of policyEntries(policies)) {
				const guarded = await options.hooks.asyncGuard(info, policy);
				if (guarded !== undefined) return guarded;
			}
		}
	}
	return staticDecision;
}

// --- The tool_call handler -------------------------------------------------

/** Structural view of Pi's tool_call event. */
export interface ToolCallLike {
	toolName: string;
	input?: unknown;
}

/** Structural view of the parts of Pi's extension context this engine uses. */
export interface ContextLike {
	hasUI: boolean;
	cwd: string;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

export interface ToolCallResultLike {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export type Classifier = (
	command: string,
	policies: PolicySet,
	options: { cwd: string },
) => Decision | Promise<Decision>;

/**
 * Build the `tool_call` handler.
 *
 * The silent path returns `undefined`, never `{ block: false }`: the latter is
 * inert and misleading. A denial returns `{ block: true }` with a reason. A
 * confirmation asks the user, and blocks unless the answer is yes — and blocks
 * outright when there is no UI to ask, because failing open on an unaskable
 * confirmation is exactly the failure this engine exists to prevent.
 */
export function buildToolCallHandler(
	loader: () => PolicySet,
	classify: Classifier,
	label = "command policy",
): (event: ToolCallLike, ctx: ContextLike) => Promise<ToolCallResultLike | undefined> {
	return async (event, ctx) => {
		try {
			if (!SHELL_COMMAND_TOOLS.has(event.toolName)) return undefined;
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (typeof command !== "string" || command.trim() === "") return undefined;

			const decision = await classify(command, loader(), { cwd: ctx.cwd });

			if (decision.tier === "block") {
				return {
					block: true,
					reason: `${label} denied this command: ${decision.reason ?? "denied by policy"}`,
				};
			}

			if (decision.tier === "confirm") {
				const reason = decision.reason ?? "confirm this command?";
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `${label} requires interactive confirmation, which is unavailable here: ${reason}`,
					};
				}
				let approved = false;
				try {
					approved = (await ctx.ui.confirm(`${label} confirmation`, reason)) === true;
				} catch {
					approved = false;
				}
				if (!approved) {
					return { block: true, reason: `${label} confirmation was declined: ${reason}` };
				}
			}

			// Silent: return undefined. Never `{ block: false }`.
			return undefined;
		} catch (error) {
			// Fail closed: an internal error must never widen access.
			return {
				block: true,
				reason: `${label} failed closed and did not run this command: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};
}
