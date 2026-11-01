import { describe, expect, test } from 'bun:test';
import { isRpcNotification, isRpcRequest, isRpcResponse, parseRpcMessage } from '../src/index.ts';

describe('JSON-RPC protocol', () => {
	test('parses a known request and validates its envelope', () => {
		const request = parseRpcMessage(JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'commands.search',
			params: { query: 'bun' }
		}));
		expect(isRpcRequest(request)).toBe(true);
	});

	test('accepts typed notifications and responses', () => {
		expect(isRpcNotification({ jsonrpc: '2.0', method: 'run.output', params: { runId: 'r1', offset: 0, dataBase64: 'b2s=' } })).toBe(true);
		expect(isRpcNotification({ jsonrpc: '2.0', method: 'runs.deleted', params: { runIds: ['r1'] } })).toBe(true);
		expect(isRpcResponse({ jsonrpc: '2.0', id: 'x', result: { version: '0.1.0', pid: 42 } })).toBe(true);
	});

	test('rejects unknown methods and malformed JSON-RPC envelopes', () => {
		expect(() => parseRpcMessage('{')).toThrow();
		expect(() => parseRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'commands.wipe', params: {} }))).toThrow('Invalid JSON-RPC 2.0 message');
	});
});
