import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const LOCAL_SOCKET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/;

/** Map one local endpoint name to a Unix socket or Windows named pipe. */
export function getLocalSocketPath(name: string, directory: string): string {
	if (!LOCAL_SOCKET_NAME.test(name)) throw new TypeError(`Invalid local socket name: ${name}`);
	if (process.platform !== "win32") return join(directory, name);
	const scope = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 16);
	return `\\\\.\\pipe\\pi-${scope}-${name}`;
}

/** Derive the local Unix socket path for one logical server identity. */
export function getUnixSocketPath(serverId: string, serverDirectory: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(serverId)) {
		throw new TypeError("Unix serverId must be a canonical lowercase UUIDv4");
	}
	return getLocalSocketPath(`${serverId}.sock`, serverDirectory);
}
