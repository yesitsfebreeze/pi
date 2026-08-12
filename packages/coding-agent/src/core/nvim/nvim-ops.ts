/**
 * Combined nvim operations — a single factory that returns all operation types.
 *
 * Each operation checks at call time whether the nvim client is connected;
 * if so, delegates to nvim; otherwise falls back to local filesystem.
 * This allows the same session to work with or without nvim.
 */

import type { BashOperations } from "../tools/bash.js";
import type { EditOperations } from "../tools/edit.js";
import type { FindOperations } from "../tools/find.js";
import type { GrepOperations } from "../tools/grep.js";
import type { LsOperations } from "../tools/ls.js";
import type { ReadOperations } from "../tools/read.js";
import type { WriteOperations } from "../tools/write.js";
import {
	createNvimBashOps,
	createNvimEditOps,
	createNvimFindOps,
	createNvimGrepOps,
	createNvimLsOps,
	createNvimReadOps,
	createNvimWriteOps,
} from "./nvim-operations.js";
import type { NvimSocketClient } from "./nvim-socket-client.js";

type ClientGetter = () => NvimSocketClient | undefined;

export interface NvimOps {
	read: ReadOperations;
	edit: EditOperations;
	write: WriteOperations;
	bash: BashOperations;
	find: FindOperations;
	grep: GrepOperations;
	ls: LsOperations;
}

export function createNvimOps(getClient: ClientGetter): NvimOps {
	return {
		read: createNvimReadOps(getClient),
		edit: createNvimEditOps(getClient),
		write: createNvimWriteOps(getClient),
		bash: createNvimBashOps(getClient),
		find: createNvimFindOps(getClient),
		grep: createNvimGrepOps(getClient),
		ls: createNvimLsOps(getClient),
	};
}
