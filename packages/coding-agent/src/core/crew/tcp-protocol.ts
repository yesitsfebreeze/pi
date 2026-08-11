/**
 * TCP framing protocol: length-prefixed JSON messages over TCP.
 *
 * Wire format: [u32 LE byte length][UTF-8 JSON payload]
 */

import type * as net from "node:net";

export function encodeFrame(message: unknown): Buffer {
	const json = JSON.stringify(message);
	const len = Buffer.alloc(4);
	len.writeUInt32LE(Buffer.byteLength(json, "utf8"), 0);
	return Buffer.concat([len, Buffer.from(json, "utf8")]);
}

export function writeFrame(socket: net.Socket, message: unknown): void {
	socket.write(encodeFrame(message));
}

export function createFrameParser(
	socket: net.Socket,
	onMessage: (message: unknown) => void,
	onError: (err: Error) => void,
): void {
	let buffer = Buffer.alloc(0);

	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const len = buffer.readUInt32LE(0);
			// Not enough data for a complete frame
			if (buffer.length < 4 + len) return;
			const json = buffer.subarray(4, 4 + len).toString("utf8");
			buffer = buffer.subarray(4 + len);
			try {
				onMessage(JSON.parse(json));
			} catch (err) {
				onError(err instanceof Error ? err : new Error(String(err)));
			}
		}
	});
}
