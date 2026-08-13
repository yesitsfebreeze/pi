/**
 * TCP server for the coding agent.
 *
 * Listens on a local TCP port and accepts connections from subagents
 * and remote clients. Each connection gets the full RPC command set
 * plus real-time event streaming.
 *
 * Port discovery: the server writes its port to a well-known file
 * (.pi/tcp-port) so subagents can find it.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { RpcCommand, RpcResponse } from "../../modes/rpc/rpc-types.ts";
import { createFrameParser, encodeFrame, writeFrame } from "./tcp-protocol.ts";

export interface TcpServerOptions {
	port?: number;
	host?: string;
}

export interface TcpServer {
	readonly port: number;
	broadcast(event: unknown): void;
	close(): Promise<void>;
}

export async function startTcpServer(
	onCommand: (command: RpcCommand) => Promise<RpcResponse | undefined>,
	options: TcpServerOptions = {},
): Promise<TcpServer> {
	const port = options.port ?? 0;
	const host = options.host ?? "127.0.0.1";

	const sockets = new Set<net.Socket>();
	const parsers = new Map<net.Socket, ReturnType<typeof createFrameParser>>();

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.setNoDelay(true);
		socket.setKeepAlive(true, 30_000);

		const parser = createFrameParser(
			socket,
			(message) => {
				const cmd = message as RpcCommand;
				void (async () => {
					try {
						const response = await onCommand(cmd);
						if (response) writeFrame(socket, response);
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : String(err);
						writeFrame(socket, {
							id: cmd.id,
							type: "response",
							command: cmd.type,
							success: false,
							error: errorMsg,
						} as RpcResponse);
					}
				})();
			},
			(err) => {
				socket.destroy(err);
			},
		);

		parsers.set(socket, parser);

		socket.once("close", () => {
			sockets.delete(socket);
			parsers.delete(socket);
		});

		socket.on("error", () => {
			sockets.delete(socket);
			parsers.delete(socket);
		});
	});

	server.maxConnections = 64;

	return new Promise((resolve, reject) => {
		server.on("error", reject);

		server.listen(port, host, () => {
			const addr = server.address() as net.AddressInfo;
			const actualPort = addr.port;

			const portFile = path.join(process.cwd(), CONFIG_DIR_NAME, "tcp-port");
			fs.writeFileSync(portFile, String(actualPort));

			resolve({
				port: actualPort,

				broadcast(event) {
					const frame = encodeFrame(event);
					for (const sock of sockets) {
						if (!sock.destroyed && sock.writable) {
							sock.write(frame);
						}
					}
				},

				async close() {
					try {
						fs.unlinkSync(path.join(process.cwd(), CONFIG_DIR_NAME, "tcp-port"));
					} catch {
						/* ok */
					}
					for (const sock of sockets) {
						sock.destroy();
					}
					sockets.clear();
					parsers.clear();
					return new Promise<void>((res) => server.close(() => res()));
				},
			});
		});
	});
}
