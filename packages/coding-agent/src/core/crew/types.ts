/** Shared types for the crew subsystem. */

export interface CrewProfile {
	name: string;
	description: string;
	persona?: string;
	model?: string;
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
}

export interface SyncOptions {
	cwd: string;
	model?: string;
	thinking?: string;
	cwdOverride?: string;
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
