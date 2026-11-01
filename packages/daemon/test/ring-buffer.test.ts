import { describe, expect, test } from 'bun:test';
import { ByteRingBuffer } from '../src/ring-buffer.ts';

describe('ByteRingBuffer', () => {
	test('retains only the newest bytes and reports absolute offsets', () => {
		const ring = new ByteRingBuffer(5);
		ring.append(Buffer.from('abc'));
		ring.append(Buffer.from('defg'));

		expect(ring.totalBytes).toBe(7);
		expect(ring.startOffset).toBe(2);
		expect(ring.read().data.toString()).toBe('cdefg');
		expect(ring.read(0)).toMatchObject({ offset: 2, nextOffset: 7, truncated: true });
	});

	test('handles wrap-around and writes larger than its capacity', () => {
		const ring = new ByteRingBuffer(4);
		ring.append(Buffer.from('ab'));
		ring.append(Buffer.from('cde'));
		expect(ring.read().data.toString()).toBe('bcde');

		ring.append(Buffer.from('123456'));
		expect(ring.read().data.toString()).toBe('3456');
		expect(ring.startOffset).toBe(7);
	});

	test('preserves the newest bytes when the buffer size changes', () => {
		const ring = new ByteRingBuffer(8);
		ring.append(Buffer.from('abcdefgh'));
		ring.resize(4);
		expect(ring.read().data.toString()).toBe('efgh');
		expect(ring.startOffset).toBe(4);
		ring.resize(10);
		expect(ring.read().data.toString()).toBe('efgh');
	});
});
