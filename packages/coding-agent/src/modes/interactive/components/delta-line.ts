import type { Usage } from "@earendil-works/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { renderRoundedBox } from "./rounded-box.ts";

const SEP = " \x1b[2m|\x1b[22m ";

/** Border color for the rounded box — a border token not otherwise used by this line. */
const BORDER_COLOR: "borderMuted" = "borderMuted";

/** Absolute minimum model name width before dropping the field entirely. */
const MODEL_MIN_WIDTH = 5;

/**
 * Per-response delta line rendered below each completed assistant message.
 * Shows the resource delta (tokens, cost, throughput, duration) for that response,
 * wrapped in a rounded border box sized to its content.
 *
 * Sections use zentui-style styling:
 *   - tokens: bright-black (muted)
 *   - cost: bold green
 *   - throughput: dim
 *   - duration: dim
 *   - model name: accent (blue)
 *   - reasoning level: dim
 *   - cumulative cost: bold green
 */
export class DeltaLineComponent implements Component {
	private readonly usage: Usage;
	private readonly durationMs: number;
	private readonly modelName: string;
	private readonly thinkingLevel: string | undefined;
	private readonly isError: boolean;
	private readonly errorLabel?: string;

	constructor(opts: {
		usage: Usage;
		durationMs: number;
		modelName: string;
		thinkingLevel?: string;
		isError?: boolean;
		errorLabel?: string;
	}) {
		this.usage = opts.usage;
		this.durationMs = opts.durationMs;
		this.modelName = opts.modelName;
		this.thinkingLevel = opts.thinkingLevel;
		this.isError = opts.isError ?? false;
		this.errorLabel = opts.errorLabel;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 3) return [];

		const border = (s: string) => theme.fg(BORDER_COLOR, s);
		const contentWidth = width - 4; // width - 2 borders - 1 left padding cell - 1 right padding cell

		const wrap = (content: string): string[] =>
			renderRoundedBox({
				lines: [truncateToWidth(content, contentWidth, theme.fg("dim", "…"))],
				width,
				colorFn: border,
				leftPad: 1,
				rightPad: 1,
				sizeToContent: true,
			});

		if (this.isError) {
			const label = this.errorLabel ?? "Error";
			const parts: string[] = [theme.fg("error", label)];
			const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
			if (promptTokens > 0 || this.usage.output > 0) {
				const tokParts: string[] = [];
				if (promptTokens > 0) tokParts.push(`↑${formatTokens(promptTokens)}`);
				if (this.usage.output > 0) tokParts.push(`↓${formatTokens(this.usage.output)}`);
				parts.push(theme.fg("muted", tokParts.join(" ")));
			}
			if (this.usage.cost.total > 0) {
				parts.push(theme.bold(theme.fg("success", `$${this.usage.cost.total.toFixed(3)}`)));
			}
			return wrap(parts.join(SEP));
		}

		const fields: string[] = [];
		const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;

		// Model name first: accent color (highest priority — never dropped, only truncated)
		if (this.modelName) {
			const modelStyled = theme.fg("accent", this.modelName);
			if (visibleWidth(modelStyled) > contentWidth) {
				fields.push(truncateToWidth(modelStyled, Math.max(MODEL_MIN_WIDTH, contentWidth), "…"));
			} else {
				fields.push(modelStyled);
			}
		}

		// Tokens: one logical field (↑N ↓N)
		const tokenParts: string[] = [];
		if (promptTokens > 0) tokenParts.push(`↑${formatTokens(promptTokens)}`);
		if (this.usage.output > 0) tokenParts.push(`↓${formatTokens(this.usage.output)}`);
		if (tokenParts.length > 0) fields.push(theme.fg("muted", tokenParts.join(" ")));

		// Cost: bold green (zentui-style)
		if (this.usage.cost.total > 0) {
			fields.push(theme.bold(theme.fg("success", `$${this.usage.cost.total.toFixed(3)}`)));
		}

		// Throughput
		const durationSec = this.durationMs / 1000;
		const totalTokens = promptTokens + this.usage.output;
		if (durationSec >= 0.1 && totalTokens > 0) {
			fields.push(theme.fg("dim", `${(totalTokens / durationSec).toFixed(1)} t/s`));
		}

		// Duration
		if (durationSec >= 0.1) {
			fields.push(theme.fg("dim", `${durationSec.toFixed(1)}s`));
		}

		// Reasoning level: dim
		if (this.thinkingLevel && this.thinkingLevel !== "off") {
			fields.push(theme.fg("dim", `reasoning: ${this.thinkingLevel}`));
		}

		if (fields.length === 0) return [];

		// Build line left-to-right, dropping low-priority fields on overflow.
		// Model name (first) is highest priority; trailing fields drop first.
		let line = fields[0] ?? "";
		for (let i = 1; i < fields.length; i++) {
			const candidate = line + SEP + (fields[i] ?? "");
			if (visibleWidth(candidate) <= contentWidth) {
				line = candidate;
			}
		}

		return wrap(line);
	}
}
