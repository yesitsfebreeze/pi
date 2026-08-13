// ask — the agent asks a question, the user answers inline, below the chat.
//
// The agent's question panel replaces the editor area and shows:
//   1. A bold bordered "N Open Questions" header board
//   2. A scrollable list of all questions with answer status
//   3. The current question's prompt, context, and recommendation
//   4. A solid bordered options box with full-row selection highlights
//   5. A normal text input for typed custom answers
//
// Navigation: ↑↓ selects among options or the custom-answer field; type any
// text and press enter to submit it as a custom answer.  Tab / shift+tab
// moves between questions (multi-question mode).  Esc cancels.

import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { getOpenQuestions, setOpenQuestions } from "./open-questions.ts";
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

const termCols = (): number =>
	typeof process !== "undefined" && process.stdout && process.stdout.columns ? process.stdout.columns : 0;

// ── border glyphs ──────────────────────────────────────────
const G = {
	h: "─",
	v: "│",
	tl: "╭",
	tr: "╮",
	bl: "╰",
	br: "╯",
} as const;

type Sel = { kind: "none" } | { kind: "opt"; opt: Opt } | { kind: "typed" };

/** Draw a bordered box sized to `w`. The title is centered in the top border. */
function box(w: number, lines: string[], theme: any, title?: string): string[] {
	const out: string[] = [];
	const innerW = w - 2;
	const c = (s: string) => theme.fg("border", s);

	if (title) {
		const _titleVis = visibleWidth(title);
		const avail = innerW - 2; // 2 for spaces around title
		// Truncate visually: slice chars from end until width fits.
		let trimmed = title;
		while (visibleWidth(trimmed) > avail && trimmed.length > 0) trimmed = trimmed.slice(0, -1);
		const pre = Math.max(0, Math.floor((innerW - visibleWidth(trimmed) - 2) / 2));
		const post = Math.max(0, innerW - pre - visibleWidth(trimmed) - 2);
		out.push(c(G.tl) + c(G.h.repeat(pre)) + c(" ") + trimmed + c(" ") + c(G.h.repeat(post)) + c(G.tr));
	} else {
		out.push(c(G.tl) + c(G.h.repeat(innerW)) + c(G.tr));
	}

	for (const l of lines) {
		const vis = visibleWidth(l);
		const blank = Math.max(0, innerW - vis);
		out.push(c(G.v) + l + " ".repeat(blank) + c(G.v));
	}
	out.push(c(G.bl) + c(G.h.repeat(innerW)) + c(G.br));
	return out;
}

export function createAskTool(): ToolDefinition<typeof QuestionsParams, Result> {
	return {
		name: "ask",
		label: "Ask",
		promptSnippet: "Ask the user questions inline, below the chat",
		description:
			'Ask the user one or more questions inline in a bordered question panel below the chat. Shows a live "N Open Questions" header board, a list of all questions with answer status, a bold options box with solid selection highlights, and a text input for typed custom answers. Navigate options with ↑↓, type any text and press enter to submit a custom answer, tab advances questions. Set multi: true on a question to allow picking several options — space toggles each, enter submits the set. Use for single-turn decisions where the user scans options or types directly.',
		parameters: QuestionsParams,

		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
			if (ctx.mode !== "tui") return bail("ask needs the TUI (non-interactive mode)");
			const questions = normalize(params.questions ?? []);
			if (questions.length === 0) return bail("ask: no questions given");

			setOpenQuestions(questions.length);

			const multi = questions.length > 1;
			const tabs = questions.length + 1; // questions + summary tab

			const result: Result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (r: Result) => void) => {
				let tab = 0;
				let sel = 0;
				let selKind: Sel = { kind: "none" };
				let notice: string | null = null;
				let cache: string[] | undefined;
				const answers = new Map<string, Answer>();
				// multi-select: checked option values per question id (persists across
				// tab navigations so the user can revisit and adjust before submit).
				const checked = new Map<string, Set<string>>();

				const setFor = (cur: Question): Set<string> => {
					let set = checked.get(cur.id);
					if (!set) {
						// Recommended options arrive pre-checked, matching single-select's
						// pre-selection of the starred row.
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
					return cur.allowOther !== false
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
				const nextUnanswered = (): number => {
					for (let i = 0; i < questions.length; i++) {
						if (!answers.has(questions[i].id)) return i;
					}
					return questions.length; // summary
				};

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
					selKind = { kind: "none" };
					editor.setText("");
					notice = null;
					refresh();
				};

				const save = (a: Answer) => {
					answers.set(a.id, a);
					setOpenQuestions(questions.length - answers.size);
					if (!multi) {
						setOpenQuestions(0);
						done({ answers: [...answers.values()], cancelled: false });
						return;
					}
					// Auto-advance to next unanswered question (or summary)
					goTab(nextUnanswered());
				};

				const pick = (o: Opt) => {
					const cur = q();
					if (!cur) return;
					if (o.value === OTHER) {
						editor.setText("");
						selKind = { kind: "typed" };
						notice = null;
						refresh();
						return;
					}
					save({
						id: cur.id,
						value: o.value,
						label: o.label,
						mode: o.origin === "added" ? "added" : o.origin === "rewritten" ? "replaced" : "picked",
						basedOn: o.basedOn,
						wasRecommended: o.recommended === true,
					});
				};

				// ── multi-select helpers ────────────────────────────────

				const toggle = (o: Opt) => {
					const cur = q();
					if (!cur) return;
					if (o.value === OTHER) {
						// custom value: focus the typed input; its text becomes an extra value
						editor.setText("");
						selKind = { kind: "typed" };
						notice = null;
						refresh();
						return;
					}
					const set = setFor(cur);
					if (set.has(o.value)) set.delete(o.value);
					else set.add(o.value);
					notice = null;
					refresh();
				};

				const submitMulti = () => {
					const cur = q();
					if (!cur) return;
					const set = setFor(cur);
					const picked = cur.options.filter((o) => set.has(o.value));
					const typed = editor.getText().trim();
					const values = [...picked.map((o) => o.value), ...(typed ? [typed] : [])];
					const labels = [...picked.map((o) => o.label), ...(typed ? [typed] : [])];
					if (values.length === 0) {
						notice = "space toggles options — pick at least one";
						refresh();
						return;
					}
					save({
						id: cur.id,
						value: values[0],
						label: labels.join(", "),
						mode: "multi",
						values,
						labels,
						wasRecommended: picked.some((o) => o.recommended),
					});
				};

				const submitTyped = () => {
					const cur = q();
					const text = editor.getText().trim();
					if (!cur) return;
					if (!text) {
						notice = "Type your answer or select an option";
						refresh();
						return;
					}
					save({
						id: cur.id,
						value: text,
						label: text,
						mode: "typed",
						wasRecommended: false,
					});
				};

				// ── input routing ─────────────────────────────────

				const handleInput = (data: string) => {
					// Summary screen: enter to finish, esc to cancel, tab to go back.
					if (tab === questions.length) {
						if (matchesKey(data, Key.enter) && answered())
							return done({
								answers: [...answers.values()],
								cancelled: false,
							});
						if (matchesKey(data, Key.escape)) {
							setOpenQuestions(0);
							return done({ answers: [], cancelled: true });
						}
						if (multi) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return goTab(0);
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))
								return goTab(questions.length - 1);
						}
						return;
					}

					if (multi) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
							return goTab(tab < questions.length - 1 ? tab + 1 : questions.length);
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))
							return goTab(tab > 0 ? tab - 1 : questions.length);
					}

					const opts = rows();
					const curMulti = q()?.multi === true;

					if (matchesKey(data, Key.up)) {
						if (selKind.kind === "typed") {
							selKind = { kind: "opt", opt: opts[opts.length - 1] };
							sel = opts.length - 1;
						} else {
							selKind = { kind: "opt", opt: opts[Math.max(0, sel - 1)] };
							sel = Math.max(0, sel - 1);
						}
						notice = null;
						return refresh();
					}
					if (matchesKey(data, Key.down)) {
						if (selKind.kind !== "opt") {
							selKind = { kind: "opt", opt: opts[0] };
							sel = 0;
						} else if (sel < opts.length - 1) {
							selKind = { kind: "opt", opt: opts[sel + 1] };
							sel++;
						} else {
							// Wrap: move to typed input
							selKind = { kind: "typed" };
						}
						notice = null;
						return refresh();
					}

					if (curMulti && data === " ") {
						// space toggles the highlighted option (multi-select only)
						if (selKind.kind === "opt") return toggle(selKind.opt);
						// typed input: space is a normal character
						selKind = { kind: "typed" };
						editor.handleInput(data);
						return refresh();
					}

					if (matchesKey(data, Key.enter)) {
						if (curMulti) {
							if (selKind.kind === "opt" && selKind.opt.value === OTHER && !editor.getText().trim()) {
								selKind = { kind: "typed" };
								editor.setText("");
								notice = null;
								return refresh();
							}
							return submitMulti();
						}
						const typed = editor.getText().trim();
						if (selKind.kind === "typed" && typed) return submitTyped();
						if (selKind.kind === "opt") {
							const o = selKind.opt;
							if (o.value === OTHER) {
								selKind = { kind: "typed" };
								editor.setText("");
								notice = null;
								return refresh();
							}
							return pick(o);
						}
						// If nothing selected and text exists, submit as typed
						if (typed) return submitTyped();
						notice = "Type your answer or use ↑↓ to select an option";
						return refresh();
					}

					if ((data === "c" || data === "C") && selKind.kind === "opt") {
						const o = selKind.opt;
						if (o && o.value !== OTHER) {
							// Copy the option text into the editor for editing
							editor.setText(o.label);
							selKind = { kind: "typed" };
							return refresh();
						}
					}

					if (matchesKey(data, Key.escape)) {
						setOpenQuestions(0);
						done({ answers: [], cancelled: true });
						return;
					}

					// Any other key → typed mode
					if (selKind.kind !== "typed") {
						selKind = { kind: "typed" };
					}
					editor.handleInput(data);
					refresh();
				};

				// ── render ─────────────────────────────────────

				const render = (width: number): string[] => {
					if (cache) return cache;
					const tc = termCols();
					const w = Math.max(30, tc ? Math.min(width, tc) : width);
					const out: string[] = [];
					const dim = (s: string) => theme.fg("dim", s);
					const muted = (s: string) => theme.fg("muted", s);
					const accent = (s: string) => theme.fg("accent", s);
					const bold = (s: string) => theme.bold(s);

					// ── 1. Header board: N Open Questions ──────
					const n = getOpenQuestions();
					const headerLine = `${theme.fg("accent", "?")}  ${bold(`${n} Open Question${n !== 1 ? "s" : ""}`)}`;
					out.push(...box(w, [headerLine], theme));

					// ── 2. Question list ────────────────────────
					if (multi) {
						for (let i = 0; i < questions.length; i++) {
							const x = questions[i];
							const a = answers.get(x.id);
							const isCurrent = i === tab;
							let line: string;
							if (a) {
								line = `${theme.fg("success", "✓")} ${muted(x.label)} ${theme.fg("success", `— ${a.label.length > 30 ? `${a.label.slice(0, 28)}…` : a.label}`)}`;
							} else if (isCurrent) {
								line = `${bold(accent("▸"))} ${bold(x.label)}`;
							} else {
								line = `${dim("○")} ${dim(x.label)}`;
							}
							// Left-pad question list by 1
							out.push(` ${line}`);
						}
						out.push("");
					}

					// ── 3. Summary tab ──────────────────────────
					if (tab === questions.length) {
						out.push(...box(w, [bold(accent("Ready to submit"))], theme));
						out.push("");
						for (const x of questions) {
							const a = answers.get(x.id);
							const val = a ? `${accent(a.label)}` : theme.fg("warning", "—");
							out.push(` ${muted(`${x.label}: `)}${val}`);
						}
						out.push("");
						out.push(
							" " +
								(answered()
									? theme.fg("success", "enter to submit · tab to review · esc to cancel")
									: theme.fg("warning", "unanswered — tab back to finish")),
						);
						cache = out;
						return out;
					}

					const cur = q();
					if (!cur) {
						cache = out;
						return out;
					}

					// ── 4. Current question ────────────────────
					if (cur.prompt) {
						out.push("");
						out.push(` ${bold(cur.prompt)}`);
					}
					if (cur.problem) {
						out.push("");
						out.push(` ${muted(cur.problem)}`);
					}
					if (cur.explanation) {
						out.push("");
						out.push(` ${dim(cur.explanation)}`);
					}
					if (cur.recommendation) {
						out.push("");
						out.push(` ${theme.fg("success", "★ ")}${dim(cur.recommendation)}`);
					}
					out.push("");

					// ── 5. Options box ─────────────────────────
					const opts = rows();
					const isMulti = cur.multi === true;
					const set = isMulti ? setFor(cur) : null;
					const optionLines: string[] = [];
					for (let i = 0; i < opts.length; i++) {
						const o = opts[i];
						const on = selKind.kind === "opt" && selKind.opt === o;
						const box = isMulti ? (set!.has(o.value) ? theme.fg("accent", "☑ ") : theme.fg("dim", "☐ ")) : "";
						const star = o.recommended ? theme.fg("success", "★ ") : "  ";
						const num = `${i + 1}. `;
						const label = on
							? bold(accent(num + o.label))
							: muted(num) + (o.value === OTHER ? dim(o.label) : o.label);
						// Full-row selection highlight using selectedBg
						const row = on ? theme.bg("selectedBg", box + star + label) : box + star + label;
						optionLines.push(row);
					}
					const optBoxW = Math.max(20, w - 2); // indent by 1 cell
					out.push(" "); // spacer
					out.push(...box(optBoxW, optionLines, theme, "Options").map((l) => ` ${l}`));

					// ── 6. Editor input ────────────────────────
					out.push("");
					const edW = Math.max(20, w - 4);
					const edLines = editor.render(edW);
					const color = (s: string) => theme.fg("border", s);
					if (edLines.some((l: string) => l.trim())) {
						const topB = color(G.tl) + color(G.h.repeat(edW)) + color(G.tr);
						const botB = color(G.bl) + color(G.h.repeat(edW)) + color(G.br);
						out.push(`  ${topB}`);
						for (const l of edLines) {
							const vis = visibleWidth(l);
							const blank = Math.max(0, edW - vis);
							out.push(`  ${color(G.v)}${l}${" ".repeat(blank)}${color(G.v)}`);
						}
						out.push(`  ${botB}`);
					} else {
						// Empty editor — show placeholder
						const ph = dim(isMulti ? "Type to add a custom value…" : "Type your answer or use ↑↓ to select…");
						const phVis = visibleWidth(ph);
						const padLeft = Math.max(0, Math.floor((edW - phVis) / 2));
						const padRight = Math.max(0, edW - phVis - padLeft);
						out.push(`  ${color(G.tl)}${color(G.h.repeat(edW))}${color(G.tr)}`);
						out.push(`  ${color(G.v)}${" ".repeat(padLeft)}${ph}${" ".repeat(padRight)}${color(G.v)}`);
						out.push(`  ${color(G.bl)}${color(G.h.repeat(edW))}${color(G.br)}`);
					}

					// ── 7. Hint line ───────────────────────────
					out.push("");
					out.push(
						" " +
							dim(
								isMulti
									? "↑↓ move · space toggle · enter submit · c edit · tab next · esc cancel"
									: multi
										? "↑↓ select · type answer · enter submit · c edit · tab next · esc cancel"
										: "↑↓ select · type answer · enter submit · c edit · esc cancel",
							),
					);
					if (notice) {
						out.push(` ${theme.fg("warning", notice)}`);
					}

					cache = out;
					return out;
				};

				goTab(0);

				// Set initial selection to the recommended option (or first).
				// goTab reset selKind to none, so re-assert it here synchronously.
				{
					const opts = rows();
					if (opts.length > 0) {
						const recIdx = opts.findIndex((o) => o.recommended);
						const idx = recIdx >= 0 ? recIdx : 0;
						sel = idx;
						selKind = { kind: "opt", opt: opts[idx] };
					}
				}

				return {
					render,
					invalidate: () => {
						cache = undefined;
					},
					handleInput,
				};
			});

			setOpenQuestions(0);

			if (!result || result.cancelled)
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled",
						},
					],
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
				theme.fg("toolTitle", theme.bold("ask ")) +
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
