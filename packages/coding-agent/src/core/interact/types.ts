// Shared types for ask / questionnaire tools.
// Both tools ship questions with optional context (problem, explanation,
// recommendation), let the user pick or write an answer, and return answers
// annotated with *how* they were reached.

import { Type } from "typebox";

export interface Opt {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
	origin?: "agent" | "added" | "rewritten";
	basedOn?: string;
}

export interface Question {
	id: string;
	label: string;
	prompt: string;
	problem?: string;
	explanation?: string;
	recommendation?: string;
	options: Opt[];
	allowOther: boolean;
	/** true: the user may pick several options (space toggles); the answer carries values[]. */
	multi?: boolean;
}

export interface Answer {
	id: string;
	value: string;
	label: string;
	mode: "picked" | "typed" | "added" | "replaced" | "wrote" | "multi";
	basedOn?: string;
	wasRecommended: boolean;
	/** multi-select: every selected option value (plus any typed custom value). */
	values?: string[];
	/** multi-select: every selected option label (plus any typed custom text). */
	labels?: string[];
}

export interface Result {
	answers: Answer[];
	cancelled: boolean;
}

export const OTHER = "__other__";

/** TypeBox schema matching the tool parameter contract. */
export const OptSchema = Type.Object({
	value: Type.String({ description: "value returned when this option wins" }),
	label: Type.String({ description: "one-line display label" }),
	description: Type.Optional(Type.String({ description: "second line, dimmed" })),
	recommended: Type.Optional(
		Type.Boolean({
			description: "mark as your recommendation — starred and pre-selected",
		}),
	),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "unique id for this question" }),
	label: Type.Optional(Type.String({ description: "short tab label, e.g. 'Scope' (default Q1, Q2)" })),
	prompt: Type.String({ description: "the question as asked, one line" }),
	problem: Type.Optional(
		Type.String({
			description:
				"what is actually being decided and why it came up — the situation in the code or the task that forces a choice (1-3 sentences)",
		}),
	),
	explanation: Type.Optional(
		Type.String({
			description:
				"short explanation of what separates the options — the tradeoff, cost or consequence the user is weighing (1-3 sentences)",
		}),
	),
	recommendation: Type.Optional(
		Type.String({
			description: "why you recommend the starred option — your reasoning, not a restatement of its label",
		}),
	),
	options: Type.Array(OptSchema, {
		description: "options, best first; mark one recommended",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "allow free-text answers (default true)" })),
	multi: Type.Optional(
		Type.Boolean({
			description: "allow selecting multiple options — space toggles each, enter submits the set (default false)",
		}),
	),
});

export const QuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "one or more questions to ask",
	}),
});

export function normalize(raw: any[]): Question[] {
	return raw.map((q, i) => ({
		id: String(q.id ?? `q${i + 1}`),
		label: String(q.label || `Q${i + 1}`),
		prompt: String(q.prompt ?? ""),
		problem: q.problem ? String(q.problem) : undefined,
		explanation: q.explanation ? String(q.explanation) : undefined,
		recommendation: q.recommendation ? String(q.recommendation) : undefined,
		allowOther: q.allowOther !== false,
		multi: q.multi === true,
		options: (q.options ?? []).map((o: any) => ({
			value: String(o.value ?? o.label ?? ""),
			label: String(o.label ?? o.value ?? ""),
			description: o.description ? String(o.description) : undefined,
			recommended: o.recommended === true,
			origin: "agent" as const,
		})),
	}));
}

export function bail(text: string): any {
	return {
		content: [{ type: "text" as const, text }],
		details: { answers: [], cancelled: true },
	};
}

export function formatResult(result: Result, questions: Question[]): string {
	if (result.cancelled) return "User cancelled";
	const lines = result.answers.map((a) => {
		const label = questions.find((x) => x.id === a.id)?.label ?? a.id;
		if (a.mode === "multi") {
			return `${label}: user selected${a.wasRecommended ? " (your recommendation)" : ""}: ${(a.labels ?? [a.label]).join(", ")}`;
		}
		const how =
			a.mode === "picked"
				? `selected${a.wasRecommended ? " (your recommendation)" : ""}`
				: a.mode === "replaced"
					? `rewrote an option${a.basedOn ? ` "${a.basedOn}"` : ""}`
					: a.mode === "added"
						? `added their own option${a.basedOn ? ` based on "${a.basedOn}"` : ""}`
						: "wrote";
		return `${label}: user ${how}: ${a.label}`;
	});
	return lines.join("\n");
}
