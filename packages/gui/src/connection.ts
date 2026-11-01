import { fileURLToPath } from 'node:url';
import { RpcClient } from '@cmdmark/protocol/client';
import { connectOrStartDaemon, defaultDaemonLaunchSpec, spawnDaemonProcess } from '@cmdmark/protocol/autostart';

export interface GuiConnection {
	client: RpcClient | null;
	error: string | null;
}

export async function connectGui(): Promise<GuiConnection> {
	const client = new RpcClient();
	const cliEntry = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
	try {
		await connectOrStartDaemon(client, () => spawnDaemonProcess(defaultDaemonLaunchSpec(cliEntry)));
		return { client, error: null };
	} catch (error) {
		client.close();
		return { client: null, error: error instanceof Error ? error.message : String(error) };
	}
}
