import { getKeybindings } from "../keybindings.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { visibleWidth } from "../utils.ts";

export interface TreeNode {
	id: string;
	label: string;
	children?: TreeNode[];
	collapsed?: boolean;
}

export interface TreeListTheme {
	selectedText: (text: string) => string;
	normalText: (text: string) => string;
	mutedText: (text: string) => string;
}

const DEFAULT_THEME: TreeListTheme = {
	selectedText: (t) => t,
	normalText: (t) => t,
	mutedText: (t) => t,
};

const NO_COLOR = process.env.NO_COLOR;

const EXPANDED_MARKER = NO_COLOR ? "v " : "▾ ";
const COLLAPSED_MARKER = NO_COLOR ? "> " : "▸ ";
const LEAF_MARKER = "  ";

/** Flat visible node produced by flattening the tree. */
interface FlatNode {
	node: TreeNode;
	depth: number;
	index: number; // position in flattened visible list
}

export class TreeList implements Component, Focusable {
	focused: boolean = false;
	private theme: TreeListTheme;
	private roots: TreeNode[] = [];
	private flatNodes: FlatNode[] = [];
	private selectedIndex = 0;

	public onSelect?: (node: TreeNode) => void;
	public onFocusLeave?: () => void;
	public onRequestRender?: () => void;

	constructor(opts?: { theme?: Partial<TreeListTheme>; expanded?: Record<string, boolean> }) {
		this.theme = { ...DEFAULT_THEME, ...opts?.theme };
	}

	setRoots(roots: TreeNode[], preserveState?: Map<string, boolean>): void {
		if (preserveState) {
			const applyCollapsed = (nodes: TreeNode[]) => {
				for (const n of nodes) {
					const saved = preserveState.get(n.id);
					if (saved !== undefined) n.collapsed = saved;
					if (n.children) applyCollapsed(n.children);
				}
			};
			applyCollapsed(roots);
		}
		this.roots = roots;
		this.rebuild();
	}

	invalidate(): void {
		this.rebuild();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const len = this.flatNodes.length;
		if (len === 0) return;

		if (kb.matches(data, "tui.select.up")) {
			if (this.selectedIndex === 0 && this.onFocusLeave) {
				this.onFocusLeave();
				return;
			}
			this.selectedIndex = (this.selectedIndex - 1 + len) % len;
			this.onInputChanged();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.selectedIndex >= len - 1 && this.onFocusLeave) {
				this.onFocusLeave();
				return;
			}
			this.selectedIndex = (this.selectedIndex + 1) % len;
			this.onInputChanged();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn && this.onSelect) {
				this.onSelect(fn.node);
			}
			return;
		}
		if (kb.matches(data, "tui.select.collapse")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn?.node.children && fn.node.children.length > 0) {
				fn.node.collapsed = true;
				this.rebuild();
				this.selectedIndex = Math.min(this.selectedIndex, this.flatNodes.length - 1);
			}
			return;
		}
		if (kb.matches(data, "tui.select.expand")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn?.node.children && fn.node.children.length > 0) {
				fn.node.collapsed = false;
				this.rebuild();
				this.selectedIndex = Math.min(this.selectedIndex, this.flatNodes.length - 1);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onFocusLeave) this.onFocusLeave();
			return;
		}
	}

	selectedNode(): TreeNode | null {
		return this.flatNodes[this.selectedIndex]?.node ?? null;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const innerWidth = Math.max(1, width);
		const t = this.theme;

		for (let i = 0; i < this.flatNodes.length; i++) {
			const fn = this.flatNodes[i];
			const hasKids = fn.node.children && fn.node.children.length > 0;
			const marker = hasKids ? (fn.node.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER) : LEAF_MARKER;
			const indent = "  ".repeat(fn.depth);
			const rawLabel = indent + marker + fn.node.label;
			const isSelected = i === this.selectedIndex && this.focused;
			const label = isSelected ? t.selectedText(rawLabel) : t.normalText(rawLabel);
			const vis = visibleWidth(label);
			const pad = Math.max(0, innerWidth - vis);
			lines.push(label + (isSelected ? CURSOR_MARKER : "") + " ".repeat(pad));
		}

		return lines;
	}

	private rebuild(): void {
		this.flatNodes = [];
		const walk = (nodes: TreeNode[], depth: number) => {
			for (const n of nodes) {
				this.flatNodes.push({ node: n, depth, index: this.flatNodes.length });
				const kids = n.children;
				if (kids && kids.length > 0 && !n.collapsed) {
					walk(kids, depth + 1);
				}
			}
		};
		walk(this.roots, 0);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.flatNodes.length - 1));
		this.onRequestRender?.();
	}

	/** Extension point for subclasses to react to selection changes. */
	protected onInputChanged(): void {
		this.onRequestRender?.();
	}
}
