// crew/questions.ts — durable peer questions over the channel: raise → answer
// → resolve. Ported from walkie-talkie's questions module (the wt_question
// lifecycle that was deliberately not part of the first bridge port).
//
// A question is raised by one session to an audience (exactly the sessions it
// was sent to — the answer goes back to the asker, not the scope). The first
// answer resolves it; every question is a durable decision point on disk and
// recorded to kern so future sessions see what was asked.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { channelDir } from "./channel.ts";

export type QuestionState = "open" | "resolved";

export interface QuestionAnswer {
	by: string;
	text: string;
	at: string;
}

export interface OpenQuestion {
	id: string;
	prompt: string;
	from: string;
	/** the asker's resolvable session id */
	fromId: string;
	/** exactly the sessions this question was sent to */
	audience: string[];
	createdAt: string;
	state: QuestionState;
	answers: QuestionAnswer[];
	resolvedAt?: string;
}

const id = () => `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function questionDir(repo: string): string {
	return join(channelDir(repo), "questions");
}

function path(repo: string, questionId: string): string {
	return join(questionDir(repo), `${questionId}.json`);
}

export function raiseQuestion(
	repo: string,
	from: string,
	fromId: string,
	audience: string[],
	prompt: string,
): OpenQuestion {
	const q: OpenQuestion = {
		id: id(),
		prompt: prompt.trim(),
		from,
		fromId,
		audience: [...new Set(audience)],
		createdAt: new Date().toISOString(),
		state: "open",
		answers: [],
	};
	mkdirSync(questionDir(repo), { recursive: true });
	writeFileSync(path(repo, q.id), JSON.stringify(q, null, 2));
	// Every cross-session question is a durable decision point — future
	// sessions should see what was asked without reading files.
	const kern = (globalThis as any).__kern;
	kern
		?.storeObservation?.(`crew: question ${q.id}`, `Question raised by ${from}: ${prompt.slice(0, 300)}`, [
			`questionId: ${q.id}`,
			`from: ${from}`,
		])
		.catch?.(() => {});
	return q;
}

export function getQuestion(repo: string, questionId: string): OpenQuestion | undefined {
	try {
		return JSON.parse(readFileSync(path(repo, questionId), "utf8")) as OpenQuestion;
	} catch {
		return undefined;
	}
}

/** All questions, newest first. */
export function listQuestions(repo: string): OpenQuestion[] {
	try {
		return readdirSync(questionDir(repo))
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(questionDir(repo), f), "utf8")) as OpenQuestion)
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	} catch {
		return [];
	}
}

/** Open questions addressed to this session (things awaiting my answer). */
export function questionsFor(repo: string, sessionId: string): OpenQuestion[] {
	return listQuestions(repo).filter((q) => q.state === "open" && q.audience.includes(sessionId));
}

/** Questions raised by this session (things I am waiting on). */
export function questionsBy(repo: string, fromId: string): OpenQuestion[] {
	return listQuestions(repo).filter((q) => q.fromId === fromId);
}

/**
 * Answer a question addressed to me. The first answer resolves it; answers
 * after resolution are still appended (the asker keeps the full record).
 */
export function answerQuestion(
	repo: string,
	questionId: string,
	by: string,
	text: string,
): { ok: true; question: OpenQuestion } | { ok: false; error: string } {
	const q = getQuestion(repo, questionId);
	if (!q) return { ok: false, error: `question '${questionId}' not found` };
	if (!q.audience.includes(by)) {
		return {
			ok: false,
			error: `'${by}' is not in the audience of ${questionId} — the answer goes to the asker, not the scope`,
		};
	}
	if (!text.trim()) return { ok: false, error: "answer must be non-empty" };
	q.answers.push({ by, text: text.trim(), at: new Date().toISOString() });
	if (q.state === "open") {
		q.state = "resolved";
		q.resolvedAt = new Date().toISOString();
	}
	writeFileSync(path(repo, q.id), JSON.stringify(q, null, 2));
	return { ok: true, question: q };
}
