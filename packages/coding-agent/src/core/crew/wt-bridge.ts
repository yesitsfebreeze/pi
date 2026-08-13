// Walkie-talkie bridge — compatibility layer.
//
// The bridge was integrated into crew-bridge.ts: the wt_send/wt_recv/wt_scope/
// wt_list tools became crew_send/crew_recv/crew_scope/crew_list, the
// `globalThis.__wt` holder became `globalThis.__crew`, and the channel wire
// protocol moved to channel.ts + presence.ts (see the RIGOR note: scopes are
// passed as a getter, not a snapshot, so live join/leave reflects through).
//
// This module keeps the pre-rename names resolving so consumers of the old API
// keep compiling. The tools themselves are registered once, under their new
// crew_* names, by the crew extension.
export {
	type ChannelMessage,
	createWalkieTalkie,
	registerWalkieTalkieTools,
	type WalkieTalkie,
} from "./crew-bridge.ts";
