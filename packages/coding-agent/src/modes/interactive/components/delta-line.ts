import type { Usage } from "@earendil-works/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

const SEP = " \x1b[2m·\x1b[22m ";

/** Icon prefix that identifies the delta line. */
const ICON = "▸";

/** Thick horizontal fill character drawn to the right edge after the content. */
const FILL = "━";

/** Absolute minimum model name width before dropping the field entirely. */
const MODEL_MIN_WIDTH = 5;

/**
 * Per-response delta line rendered below each completed assistant message.
 * Shows the resource delta (tokens, cost, throughput, duration) for that response.
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
			const line = parts.join(SEP);
			const prefix = theme.fg("dim", ICON) + " ";
			const content = prefix + line;
			const cw = visibleWidth(content);
			if (cw < width) return [content + theme.fg("dim", FILL.repeat(width - cw))];
			return [truncateToWidth(content, width, theme.fg("dim", "..."))];
		}

		const fields: string[] = [];
		const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;

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

		// Model name: accent color
		if (this.modelName && fields.length > 0) {
			const modelStyled = theme.fg("accent", this.modelName);
			if (visibleWidth(fields.join(SEP) + SEP + modelStyled) <= width) {
				fields.push(modelStyled);
			} else {
				const truncated = truncateToWidth(theme.fg("accent", this.modelName), MODEL_MIN_WIDTH, "…");
				if (visibleWidth(fields.join(SEP) + SEP + truncated) <= width) {
					fields.push(truncated);
				}
			}
		} else if (this.modelName && fields.length === 0) {
			fields.push(theme.fg("accent", this.modelName));
		}

		// Reasoning level: dim
		if (this.thinkingLevel && this.thinkingLevel !== "off") {
			const reasoning = theme.fg("dim", `reasoning: ${this.thinkingLevel}`);
			if (visibleWidth(fields.join(SEP) + SEP + reasoning) <= width) {
				fields.push(reasoning);
			}
		}

		if (fields.length === 0) return [];

		// Build line left-to-right, dropping low-priority fields on overflow.
		let line = fields[0] ?? "";
		for (let i = 1; i < fields.length; i++) {
			const candidate = line + SEP + (fields[i] ?? "");
			if (visibleWidth(candidate) <= width) {
				line = candidate;
			}
		}

		const prefix = theme.fg("dim", ICON) + " ";
		const content = prefix + line;
		const cw = visibleWidth(content);
		if (cw < width) return [content + theme.fg("dim", FILL.repeat(width - cw))];
		return [truncateToWidth(content, width, theme.fg("dim", "..."))];
	}
}
