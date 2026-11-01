// The entry `npm run build` compiles: a binary carries no source to hot-reload, so it imports the
// component statically and mounts it with `render`.
import { render } from 'gpuix-svelte';
import App from './App.svelte';
import { connectGui } from './src/connection.ts';

const connection = await connectGui();

render(App, {
	title: 'cmdmark',
	width: 1180,
	height: 780,
	props: { client: connection.client, error: connection.error }
});
