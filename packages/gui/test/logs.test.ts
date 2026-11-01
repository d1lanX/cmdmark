import { describe, expect, test } from 'bun:test';
import { AnsiLogDecoder, RunLogStream } from '../src/logs.ts';

describe('log decoding', () => {
	test('strips ANSI SGR and cursor movement sequences, including split sequences', () => {
		const decoder = new AnsiLogDecoder();
		decoder.push(Buffer.from('\u001b[31mred\u001b[0m\nnext\u001b['));
		decoder.push(Buffer.from('2Avisible\n'));
		expect(decoder.lines).toEqual(['red', 'nextvisible']);
	});

	test('treats carriage return as line overwrite and CRLF as a line break', () => {
		const decoder = new AnsiLogDecoder();
		decoder.push(Buffer.from('progress 10%\rprogress 20%\r\nready\r\n'));
		expect(decoder.lines).toEqual(['progress 20%', 'ready']);
	});

	test('decodes a UTF-8 character split across PTY chunks', () => {
		const decoder = new AnsiLogDecoder();
		const bytes = Buffer.from('café\n');
		decoder.push(bytes.subarray(0, 4));
		decoder.push(bytes.subarray(4));
		expect(decoder.lines).toEqual(['café']);
	});

	test('trims old lines and de-duplicates overlapping log snapshots/output events', () => {
		const decoder = new AnsiLogDecoder(2);
		decoder.push(Buffer.from('one\ntwo\nthree\n'));
		expect(decoder.lines).toEqual(['two', 'three']);

		const stream = new RunLogStream();
		stream.loadSnapshot(Buffer.from('hello\n').toString('base64'), 6);
		stream.push(0, Buffer.from('hello\nworld\n').toString('base64'));
		expect(stream.lines).toEqual(['hello', 'world']);
		expect(stream.nextOffset).toBe(12);
	});
});
