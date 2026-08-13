/** Shared types for the crew subsystem. */

export interface CrewProfile {
	name: string;
	description: string;
	persona?: string;
	/** Explicit model override. When absent, the model is resolved from `role` via the model ledger. */
	model?: string;
	/** Role tier resolved against the model ledger to pick an available model. */
	role?: string;
	thinking?: string;
	tools?: string[];
	exclude?: string[];
	timeout?: number;
	scope?: string[];
	prompt: string;
	source: string;
}

export interface CrewSpec {
	agent: string;
	task: string;
	cwd: string;
	repo: string;
	profile: CrewProfile;
	model?: string;
	timeoutMin?: number;
	parentAddr: string;
	scopes: string[];
	depth: number;
}

export interface CrewRun {
	handle: string;
	agent: string;
	task: string;
	cwd: string;
	sessionId: string;
	state: string;
	resumes: number;
	started: number;
	ended?: number;
	tools: number;
	turns: number;
	text: string;
	stderr: string;
	exitCode?: number | null;
	dir: string;
	profile?: CrewProfile;
	depth: number;
	child?: import("node:child_process").ChildProcess;
	pid?: number;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	tool?: string;
	providerError?: string;
	/** Session id of the parent pi session that dispatched this run. Lets the
	 *  session tree nest sub-agents under their exact parent instead of by cwd. */
	parentSessionId?: string;
}

export interface SyncOptions {
	cwd: string;
	model?: string;
	thinking?: string;
	cwdOverride?: string;
	/** Resolve a model per profile (used to map a profile's `role` to an available model). */
	resolveModel?: (profile: CrewProfile) => string | undefined;
}

export interface SyncTask {
	agent: string;
	task: string;
	cwd?: string;
}

export interface SyncResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: SyncUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface SyncUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}
