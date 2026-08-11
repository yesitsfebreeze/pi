import type { Usage } from "@earendil-works/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

const SEP = " · ";

/** Max display width for the model name before truncation. */
const MODEL_MAX_WIDTH = 30;
/** Absolute minimum model name width before dropping the field entirely. */
const MODEL_MIN_WIDTH = 5;

/**
 * Per-response status line rendered below each completed assistant message.
 *
 * Width budget (priority left-to-right, lowest priority fields drop first):
 *   1. tokens ↑N ↓N          (~20 chars)
 *   2. cost  $N              (~10 chars)
 *   3. throughput  N t/s     (~10 chars)
 *   4. duration  Ns          (~7 chars)
 *   5. model name            (max 30, min 5, truncatable)
 *   6. reasoning level       (droppable)
 *   7. cumulative total $N   (droppable)
 *
 * At 40 cols: tokens cost throughput → ~37 chars
 * At 80 cols: full line with truncated model → ~65 chars
 * At 200 cols: all fields, full model name
 */
export class MessageStatusComponent implements Component {
	private readonly usage: Usage;
	private readonly durationMs: number;
	private readonly modelName: string;
	private readonly thinkingLevel: string | undefined;
	private readonly sessionCost: number;
	private readonly isError: boolean;
	private readonly errorLabel?: string;

	constructor(opts: {
		usage: Usage;
		durationMs: number;
		modelName: string;
		thinkingLevel?: string;
		sessionCost: number;
		isError?: boolean;
		errorLabel?: string;
	}) {
		this.usage = opts.usage;
		this.durationMs = opts.durationMs;
		this.modelName = opts.modelName;
		this.thinkingLevel = opts.thinkingLevel;
		this.sessionCost = opts.sessionCost;
		this.isError = opts.isError ?? false;
		this.errorLabel = opts.errorLabel;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.isError) {
			const label = this.errorLabel ?? "Error";
			const parts: string[] = [label];
			const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
			if (promptTokens > 0 || this.usage.output > 0) {
				const tokParts: string[] = [];
				if (promptTokens > 0) tokParts.push(`↑${formatTokens(promptTokens)}`);
				if (this.usage.output > 0) tokParts.push(`↓${formatTokens(this.usage.output)}`);
				parts.push(tokParts.join(" "));
			}
			if (this.usage.cost.total > 0) {
				parts.push(`$${this.usage.cost.total.toFixed(3)}`);
			}
			const line = theme.fg("dim", parts.join(" · "));
			return [truncateToWidth(line, width, theme.fg("dim", "..."))];
		}

		const mandatory: string[] = [];
		const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;

		// Tokens: one logical field (↑N ↓N)
		const tokenParts: string[] = [];
		if (promptTokens > 0) tokenParts.push(`↑${formatTokens(promptTokens)}`);
		if (this.usage.output > 0) tokenParts.push(`↓${formatTokens(this.usage.output)}`);
		if (tokenParts.length > 0) mandatory.push(tokenParts.join(" "));

		if (this.usage.cost.total > 0) {
			mandatory.push(`$${this.usage.cost.total.toFixed(3)}`);
		}

		const durationSec = this.durationMs / 1000;
		const totalTokens = promptTokens + this.usage.output;
		if (durationSec >= 0.1 && totalTokens > 0) {
			mandatory.push(`${(totalTokens / durationSec).toFixed(1)} t/s`);
		}
		if (durationSec >= 0.1) {
			mandatory.push(`${durationSec.toFixed(1)}s`);
		}

		// Build line left-to-right, dropping low-priority fields on overflow.
		let line = mandatory.join(SEP);
		if (!line && !this.modelName) return [];
		if (!line) line = this.modelName;

		const tryAppend = (field: string): boolean => {
			const candidate = line + SEP + field;
			if (visibleWidth(candidate) <= width) {
				line = candidate;
				return true;
			}
			return false;
		};

		// Model name: fit at full width, truncate, or drop.
		// Skip if modelName was already used as the sole content (no mandatory fields).
		if (mandatory.length > 0 && this.modelName) {
			if (visibleWidth(this.modelName) <= MODEL_MAX_WIDTH) {
				if (!tryAppend(this.modelName)) {
					const truncated = truncateToWidth(this.modelName, MODEL_MIN_WIDTH, "…");
					if (visibleWidth(truncated) > 0 && visibleWidth(line + SEP + truncated) <= width) {
						line = line + SEP + truncated;
					}
				}
			} else {
				const candidate = truncateToWidth(this.modelName, MODEL_MAX_WIDTH, "…");
				if (!tryAppend(candidate)) {
					const short = truncateToWidth(this.modelName, MODEL_MIN_WIDTH, "…");
					if (visibleWidth(short) > 0 && visibleWidth(line + SEP + short) <= width) {
						line = line + SEP + short;
					}
				}
			}
		}

		// Reasoning level (droppable)
		if (this.thinkingLevel && this.thinkingLevel !== "off") {
			tryAppend(`reasoning: ${this.thinkingLevel}`);
		}

		// Cumulative session cost (droppable)
		if (this.sessionCost > 0) {
			tryAppend(`total $${this.sessionCost.toFixed(3)}`);
		}

		return [theme.fg("dim", line)];
	}
}
