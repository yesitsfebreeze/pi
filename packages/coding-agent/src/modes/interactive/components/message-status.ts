// Per-response status line — compatibility layer.
//
// MessageStatusComponent was integrated into DeltaLineComponent (commit
// d15545baf: rename MessageStatus to DeltaLineComponent, add NuShell
// statusline, remove footer slot): same fields — tokens, cost, throughput,
// duration, model name, reasoning level, cumulative cost — plus a rounded
// border box, the open-questions ask board and the kern-ingested counter.
//
// This module keeps the pre-rename class name resolving so consumers of the
// old API keep compiling. The DeltaLine constructor accepts a superset of the
// MessageStatus options, so the alias is drop-in.
export { DeltaLineComponent as MessageStatusComponent } from "./delta-line.ts";
