// Questionnaire — the agent asks, the user answers, in an overlay.
//
// Each question carries a briefing — the problem being decided, a short
// explanation of the tradeoff, and the reason behind the recommendation —
// so the user answers with context instead of guessing what the bare prompt
// means. The agent may mark options as its recommendation (★), and `c`
// copies the highlighted option into an editable draft.  From the draft,
// enter ADDS it as an extra option (the original survives) and ctrl+s
// REPLACES the original with the rewrite.  Either way the answer records
// what it was based on, so the agent sees its recommendation was edited
// rather than just a bare string.

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	type Answer,
	bail,
	formatResult,
	normalize,
	type Opt,
	OTHER,
	type Question,
	QuestionsParams,
	type Result,
} from "./types.ts";

// The width handed to a custom render can exceed the real terminal width (a
// pi-tui region-sizing quirk), so every line is capped to process.stdout.columns.
const termCols = (): number =>
	typeof process !== "undefined" && process.stdout && process.stdout.columns ? process.stdout.columns : 0;

export function createQuestionnaireTool(): ToolDefinition<typeof QuestionsParams, Result> {
	return {
		name: "questionnaire",
		label: "Questionnaire",
		promptSnippet: "Ask the user questions in a full-screen TUI overlay",
		description:
			"Ask the user one or more questions in a TUI overlay. Brief each question first — `problem` (what is being decided and why it came up), `explanation` (what separates the options) and `recommendation` (why you recommend the starred one) — then give a few concrete options and mark one `recommended`. The user picks it, or presses `c` to rewrite it into an extra option. Set `multi: true` to let the user pick several options with space. Use it to settle requirements, preferences and decisions instead of guessing.",
		parameters: QuestionsParams,

		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") return bail("questionnaire needs the TUI (non-interactive mode)");
			const questions = normalize(params.questions ?? []);
			if (questions.length === 0) return bail("questionnaire: no questions given");

			const multi = questions.length > 1;
			const tabs = questions.length + 1;

			const result: Result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (r: Result) => void) => {
				let tab = 0;
				let sel = 0;
				let draft: { qid: string; from?: Opt } | null = null;
				let notice: string | null = null;
				let cache: string[] | undefined;
				const answers = new Map<string, Answer>();
				// multi-select: checked option values + committed custom text per question id.
				const checked = new Map<string, Set<string>>();
				const typedExtras = new Map<string, string>();

				const setFor = (cur: Question): Set<string> => {
					let set = checked.get(cur.id);
					if (!set) {
						set = new Set(cur.options.filter((o) => o.recommended).map((o) => o.value));
						checked.set(cur.id, set);
					}
					return set;
				};

				const edTheme: EditorTheme = {
					borderColor: (s: string) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, edTheme);

				const refresh = () => {
					cache = undefined;
					tui.requestRender();
				};
				const q = (): Question | undefined => questions[tab];
				const rows = (): Opt[] => {
					const cur = q();
					if (!cur) return [];
					return cur.allowOther
						? [
								...cur.options,
								{
									value: OTHER,
									label: "Write your own…",
									origin: "agent" as const,
								},
							]
						: cur.options;
				};
				const answered = () => questions.every((x) => answers.has(x.id));

				const startAt = (i: number) => {
					const cur = questions[i];
					if (!cur) return 0;
					if (cur.multi) {
						const set = checked.get(cur.id);
						if (set) {
							const at = cur.options.findIndex((o) => set.has(o.value));
							if (at >= 0) return at;
						}
						const rec = cur.options.findIndex((o) => o.recommended);
						return rec >= 0 ? rec : 0;
					}
					const prev = answers.get(cur.id);
					if (prev) {
						const at = cur.options.findIndex((o) => o.value === prev.value);
						if (at >= 0) return at;
					}
					const rec = cur.options.findIndex((o) => o.recommended);
					return rec >= 0 ? rec : 0;
				};

				const goTab = (i: number) => {
					tab = ((i % tabs) + tabs) % tabs;
					sel = startAt(tab);
					notice = null;
					refresh();
				};

				const save = (a: Answer) => {
					answers.set(a.id, a);
					if (!multi) {
						done({ answers: [...answers.values()], cancelled: false });
						return;
					}
					goTab(tab < questions.length - 1 ? tab + 1 : questions.length);
				};

				const pick = (o: Opt) => {
					const cur = q();
					if (!cur) return;
					save({
						id: cur.id,
						value: o.value,
						label: o.label,
						mode: o.origin === "added" ? "added" : o.origin === "rewritten" ? "replaced" : "picked",
						basedOn: o.basedOn,
						wasRecommended: o.recommended === true,
					});
				};

				const openDraft = (from?: Opt) => {
					const cur = q();
					if (!cur) return;
					draft = { qid: cur.id, from };
					editor.setText(from ? from.label : "");
					notice = null;
					refresh();
				};

				const closeDraft = () => {
					draft = null;
					editor.setText("");
					refresh();
				};

				const commitDraft = (replace: boolean) => {
					const cur = q();
					const text = editor.getText().trim();
					if (!cur || !draft) return;
					if (!text) {
						notice = "empty — write something or esc to cancel";
						refresh();
						return;
					}
					if (cur.multi) {
						// multi: the draft text becomes one more checked value — the option
						// list stays stable, no rewrite semantics.
						typedExtras.set(cur.id, text);
						closeDraft();
						refresh();
						return;
					}
					const from = draft.from;
					if (replace && from) {
						const was = from.basedOn ?? from.value;
						from.label = text;
						from.value = text;
						from.origin = "rewritten";
						from.basedOn = was;
						from.description = undefined;
						closeDraft();
						pick(from);
						return;
					}
					const added: Opt = {
						value: text,
						label: text,
						origin: from ? "added" : "agent",
						basedOn: from?.value,
					};
					const at = from ? cur.options.indexOf(from) + 1 : cur.options.length;
					cur.options.splice(at, 0, added);
					sel = at;
					closeDraft();
					if (!from) {
						save({
							id: cur.id,
							value: text,
							label: text,
							mode: "wrote",
							wasRecommended: false,
						});
						return;
					}
					pick(added);
				};

				const handleInput = (data: string) => {
					if (draft) {
						if (matchesKey(data, Key.escape)) return closeDraft();
						if (matchesKey(data, "ctrl+s")) return commitDraft(true);
						if (matchesKey(data, Key.enter)) return commitDraft(false);
						editor.handleInput(data);
						refresh();
						return;
					}
					if (multi) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return goTab(tab + 1);
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return goTab(tab - 1);
					}
					if (tab === questions.length) {
						if (matchesKey(data, Key.enter) && answered())
							return done({
								answers: [...answers.values()],
								cancelled: false,
							});
						if (matchesKey(data, Key.escape)) return done({ answers: [], cancelled: true });
						return;
					}
					const opts = rows();
					const curMulti = q()?.multi === true;

					if (curMulti) {
						if (data === " ") {
							const o = opts[sel];
							if (!o) return;
							if (o.value === OTHER) return openDraft();
							const set = setFor(q()!);
							if (set.has(o.value)) set.delete(o.value);
							else set.add(o.value);
							notice = null;
							return refresh();
						}
						if (matchesKey(data, Key.enter)) {
							const set = setFor(q()!);
							const picked = q()!.options.filter((o) => set.has(o.value));
							const extra = typedExtras.get(q()!.id);
							const values = [...picked.map((o) => o.value), ...(extra ? [extra] : [])];
							const labels = [...picked.map((o) => o.label), ...(extra ? [extra] : [])];
							if (values.length === 0) {
								notice = "space toggles options — pick at least one";
								refresh();
								return;
							}
							save({
								id: q()!.id,
								value: values[0],
								label: labels.join(", "),
								mode: "multi",
								values,
								labels,
								wasRecommended: picked.some((o) => o.recommended),
							});
							return;
						}
					}

					if (matchesKey(data, Key.up)) {
						sel = Math.max(0, sel - 1);
						return refresh();
					}
					if (matchesKey(data, Key.down)) {
						sel = Math.min(opts.length - 1, sel + 1);
						return refresh();
					}
					if (data === "c" || data === "C") {
						const o = opts[sel];
						if (!o || o.value === OTHER) return openDraft();
						return openDraft(o);
					}
					if (matchesKey(data, Key.enter)) {
						const o = opts[sel];
						if (!o) return;
						if (o.value === OTHER) return openDraft();
						return pick(o);
					}
					if (matchesKey(data, Key.escape)) done({ answers: [], cancelled: true });
				};

				const render = (width: number): string[] => {
					if (cache) return cache;
					const tc = termCols();
					const w = Math.max(20, tc ? Math.min(width, tc) : width);
					const out: string[] = [];
					const put = (prefix: string, text: string) => {
						const pw = visibleWidth(prefix);
						if (pw >= w) {
							out.push(...wrapTextWithAnsi(prefix + text, w));
							return;
						}
						const wrapped = wrapTextWithAnsi(text, w - pw);
						for (let i = 0; i < wrapped.length; i++) out.push((i === 0 ? prefix : " ".repeat(pw)) + wrapped[i]);
					};
					const rule = () => out.push(theme.fg("dim", "─".repeat(w)));

					rule();
					if (multi) {
						const bar = questions.map((x, i) => {
							const mark = answers.has(x.id) ? "■" : "□";
							const t = ` ${mark} ${x.label} `;
							return i === tab
								? theme.bg("selectedBg", theme.fg("text", t))
								: theme.fg(answers.has(x.id) ? "success" : "muted", t);
						});
						const sub = " ✓ submit ";
						bar.push(
							tab === questions.length
								? theme.bg("selectedBg", theme.fg("text", sub))
								: theme.fg(answered() ? "success" : "dim", sub),
						);
						put(" ", bar.join(theme.fg("dim", "·")));
						out.push("");
					}

					const cur = q();
					if (tab === questions.length) {
						put(" ", theme.bold(theme.fg("accent", "ready to submit")));
						out.push("");
						for (const x of questions) {
							const a = answers.get(x.id);
							const val = a
								? `${a.mode === "picked" ? "" : `(${a.mode}) `}${a.label}`
								: theme.fg("warning", "—");
							put(" ", `${theme.fg("muted", `${x.label}: `)}${theme.fg("text", val)}`);
						}
						out.push("");
						put(
							" ",
							answered()
								? theme.fg("success", "enter submit · tab back")
								: theme.fg(
										"warning",
										`unanswered: ${questions
											.filter((x) => !answers.has(x.id))
											.map((x) => x.label)
											.join(", ")}`,
									),
						);
						rule();
						cache = out;
						return out;
					}
					if (!cur) {
						rule();
						cache = out;
						return out;
					}

					put(" ", theme.bold(theme.fg("text", cur.prompt)));
					if (cur.problem) {
						out.push("");
						put(" ", theme.fg("text", cur.problem));
					}
					if (cur.explanation) {
						out.push("");
						put(" ", theme.fg("muted", cur.explanation));
					}
					if (cur.recommendation) {
						out.push("");
						put(theme.fg("success", " ★ "), theme.fg("muted", cur.recommendation));
					}
					out.push("");
					const opts = rows();
					const isMulti = cur.multi === true;
					for (let i = 0; i < opts.length; i++) {
						const o = opts[i];
						const on = i === sel && !draft;
						const star = o.recommended ? theme.fg("success", "★ ") : "  ";
						const box = isMulti
							? setFor(cur).has(o.value)
								? theme.fg("accent", "☑ ")
								: theme.fg("dim", "☐ ")
							: "";
						const tag =
							o.origin === "added"
								? theme.fg("dim", " (yours)")
								: o.origin === "rewritten"
									? theme.fg("dim", " (edited)")
									: "";
						put(
							on ? theme.fg("accent", "> ") : "  ",
							`${box}${star}${theme.fg(on ? "accent" : "text", `${i + 1}. ${o.label}`)}${tag}`,
						);
						if (o.description) put("      ", theme.fg("muted", o.description));
					}
					if (isMulti) {
						const extra = typedExtras.get(cur.id);
						if (extra) put("  ", theme.fg("accent", `✎ ${extra}`));
					}

					if (draft) {
						out.push("");
						put(" ", theme.fg("muted", draft.from ? `rewriting: ${draft.from.label}` : "your own answer:"));
						for (const l of editor.render(Math.max(10, w - 2))) out.push(` ${l}`);
					}
					if (notice) {
						out.push("");
						put(" ", theme.fg("warning", notice));
					}
					out.push("");
					put(
						" ",
						theme.fg(
							"dim",
							draft
								? draft.from
									? "enter add as new option · ctrl+s replace the original · esc cancel"
									: "enter answer · esc cancel"
								: isMulti
									? "↑↓ move · space toggle · enter submit · c add your own · esc cancel"
									: `↑↓ pick · enter choose · c rewrite${multi ? " · tab next" : ""} · esc cancel`,
						),
					);
					rule();
					cache = out;
					return out;
				};

				goTab(0);
				return {
					render,
					invalidate: () => {
						cache = undefined;
					},
					handleInput,
				};
			});

			if (!result || result.cancelled)
				return {
					content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
					details: result ?? { answers: [], cancelled: true },
				};

			return {
				content: [
					{
						type: "text" as const,
						text: formatResult(result, questions),
					},
				],
				details: result,
			};
		},

		renderCall(args: any, theme: any) {
			const qs = args?.questions ?? [];
			const labels = qs.map((x: any, i: number) => x.label || x.id || `Q${i + 1}`).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("questionnaire ")) +
					theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`) +
					(labels ? theme.fg("dim", ` (${labels})`) : ""),
				0,
				0,
			);
		},

		renderResult(result: any, _o: any, theme: any) {
			const d = result?.details as Result | undefined;
			if (!d) return new Text(result?.content?.[0]?.text ?? "", 0, 0);
			if (d.cancelled) return new Text(theme.fg("warning", "cancelled"), 0, 0);
			return new Text(
				d.answers
					.map(
						(a) =>
							`${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${a.mode === "picked" || a.mode === "typed" ? "" : theme.fg("muted", `(${a.mode}) `)}${a.label}`,
					)
					.join("\n"),
				0,
				0,
			);
		},
	};
}
