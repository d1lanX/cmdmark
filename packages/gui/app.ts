import { render_hot } from 'gpuix-svelte';
import { connectGui } from './src/connection.ts';

const connection = await connectGui();

render_hot(new URL('./App.svelte', import.meta.url), {
	title: 'cmdmark',
	width: 1180,
	height: 780,
	props: { client: connection.client, error: connection.error }
});
