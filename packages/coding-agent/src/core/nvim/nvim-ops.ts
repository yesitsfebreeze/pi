/**
 * Combined nvim operations — a single factory that returns all operation types.
 *
 * Each operation checks at call time whether the nvim client is connected;
 * if so, delegates to nvim; otherwise falls back to local filesystem.
 * This allows the same session to work with or without nvim.
 */

import type { EditOperations } from "../tools/edit.ts";
import type { FindOperations } from "../tools/find.ts";
import type { GrepOperations } from "../tools/grep.ts";
import type { LsOperations } from "../tools/ls.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";
import {
	createNvimEditOps,
	createNvimFindOps,
	createNvimGrepOps,
	createNvimLsOps,
	createNvimReadOps,
	createNvimWriteOps,
} from "./nvim-operations.ts";
import type { NvimSocketClient } from "./nvim-socket-client.ts";
import type { BashOperations } from "../tools/bash.ts";

type ClientGetter = () => NvimSocketClient | undefined;

export interface NvimOps {
	read: ReadOperations;
	edit: EditOperations;
	write: WriteOperations;
	find: FindOperations;
	grep: GrepOperations;
	ls: LsOperations;
	/** @deprecated bash no longer forwards through nvim; kept until the interactive-mode stops wiring it. */
	bash: BashOperations;
}

export function createNvimOps(getClient: ClientGetter): NvimOps {
	return {
		read: createNvimReadOps(getClient),
		edit: createNvimEditOps(getClient),
		write: createNvimWriteOps(getClient),
		find: createNvimFindOps(getClient),
		grep: createNvimGrepOps(getClient),
		ls: createNvimLsOps(getClient),
		bash: {
			exec: async () => {
				throw new Error("bash is not forwarded through nvim (decoupled)");
			},
		},
	};
}
