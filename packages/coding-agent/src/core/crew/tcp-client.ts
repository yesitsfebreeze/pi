/**
 * TCP client for connecting to a parent agent's TCP server.
 *
 * Used by subagents (crew) to connect to the parent agent for fast
 * bidirectional messaging. Falls back to filesystem-based walkie-talkie
 * if the TCP connection fails.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";
import type { RpcCommand, RpcResponse } from "../../modes/rpc/rpc-types.js";
import { createFrameParser, writeFrame } from "./tcp-protocol.js";

export interface TcpAgentClient {
	readonly connected: boolean;
	send(command: RpcCommand): Promise<RpcResponse>;
	onEvent(listener: (event: unknown) => void): () => void;
	close(): void;
}

function discoverPort(): number | null {
	try {
		const portFile = path.join(process.cwd(), CONFIG_DIR_NAME, "tcp-port");
		const portStr = fs.readFileSync(portFile, "utf-8").trim();
		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port) || port < 1 || port > 65535) return null;
		return port;
	} catch {
		return null;
	}
}

export async function connectToParentAgent(host = "127.0.0.1"): Promise<TcpAgentClient | null> {
	const port = discoverPort();
	if (port === null) return null;

	return new Promise((resolve) => {
		const socket = new net.Socket();

		type Pending = { resolve: (v: RpcResponse) => void; reject: (e: Error) => void };
		const pending = new Map<string, Pending>();
		const eventListeners: Array<(event: unknown) => void> = [];
		let closed = false;

		socket.setNoDelay(true);

		const cleanup = () => {
			if (closed) return;
			closed = true;
			for (const [, p] of pending) {
				p.reject(new Error("TCP connection closed"));
			}
			pending.clear();
		};

		socket.once("connect", () => {
			createFrameParser(
				socket,
				(message) => {
					const msg = message as RpcResponse & { id?: string };
					if (msg.type === "response" && msg.id && pending.has(String(msg.id))) {
						const p = pending.get(String(msg.id))!;
						pending.delete(String(msg.id));
						p.resolve(msg);
						return;
					}
					for (const listener of eventListeners) {
						listener(message);
					}
				},
				() => cleanup(),
			);

			resolve({
				connected: true,

				send(command) {
					return new Promise<RpcResponse>((res, rej) => {
						if (closed || socket.destroyed) {
							rej(new Error("TCP connection closed"));
							return;
						}
						const id = command.id ?? `tcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
						pending.set(id, { resolve: res, reject: rej });
						const cmd = { ...command, id };
						writeFrame(socket, cmd);

						setTimeout(() => {
							if (pending.has(id)) {
								pending.delete(id);
								rej(new Error(`Timeout waiting for response to ${command.type}`));
							}
						}, 30_000);
					});
				},

				onEvent(listener) {
					eventListeners.push(listener);
					return () => {
						const idx = eventListeners.indexOf(listener);
						if (idx !== -1) eventListeners.splice(idx, 1);
					};
				},

				close() {
					cleanup();
					socket.destroy();
				},
			});
		});

		socket.once("error", () => {
			cleanup();
			socket.destroy();
			resolve(null);
		});

		socket.once("close", () => cleanup());

		socket.connect(port, host);
	});
}
