const DEFAULT_MAX_LINES = 5000;

export class AnsiLogDecoder {
	readonly maxLines: number;
	#decoder = new TextDecoder('utf-8');
	#stripper = new AnsiStripper();
	#lines: string[] = [];
	#currentLine = '';
	#pendingCarriageReturn = false;

	constructor(maxLines = DEFAULT_MAX_LINES) {
		if (!Number.isInteger(maxLines) || maxLines < 1) throw new RangeError('maxLines must be a positive integer');
		this.maxLines = maxLines;
	}

	get lines(): string[] {
		return this.#currentLine ? [...this.#lines, this.#currentLine] : [...this.#lines];
	}

	push(bytes: Uint8Array): string[] {
		const text = this.#stripper.push(this.#decoder.decode(bytes, { stream: true }));
		this.#consume(text);
		return this.lines;
	}

	finish(): string[] {
		this.#consume(this.#stripper.push(this.#decoder.decode()));
		if (this.#currentLine) this.#appendLine(this.#currentLine);
		this.#currentLine = '';
		this.#pendingCarriageReturn = false;
		return this.lines;
	}

	#consume(text: string): void {
		for (const character of text) {
			if (this.#pendingCarriageReturn) {
				this.#pendingCarriageReturn = false;
				if (character === '\n') {
					this.#appendLine(this.#currentLine);
					this.#currentLine = '';
					continue;
				}
				this.#currentLine = '';
			}
			if (character === '\r') {
				this.#pendingCarriageReturn = true;
			} else if (character === '\n') {
				this.#appendLine(this.#currentLine);
				this.#currentLine = '';
			} else if (character === '\b') {
				this.#currentLine = [...this.#currentLine].slice(0, -1).join('');
			} else {
				this.#currentLine += character;
			}
		}
	}

	#appendLine(line: string): void {
		this.#lines.push(line);
		if (this.#lines.length > this.maxLines) this.#lines.splice(0, this.#lines.length - this.maxLines);
	}
}

export class RunLogStream {
	readonly decoder: AnsiLogDecoder;
	#nextOffset = 0;

	constructor(maxLines = DEFAULT_MAX_LINES) {
		this.decoder = new AnsiLogDecoder(maxLines);
	}

	get nextOffset(): number {
		return this.#nextOffset;
	}

	get lines(): string[] {
		return this.decoder.lines;
	}

	loadSnapshot(dataBase64: string, nextOffset: number): string[] {
		const bytes = Buffer.from(dataBase64, 'base64');
		this.#nextOffset = Math.max(0, nextOffset - bytes.length);
		this.#consumeAtOffset(this.#nextOffset, bytes);
		return this.decoder.lines;
	}

	push(offset: number, dataBase64: string): string[] {
		this.#consumeAtOffset(offset, Buffer.from(dataBase64, 'base64'));
		return this.decoder.lines;
	}

	finish(): string[] {
		return this.decoder.finish();
	}

	#consumeAtOffset(offset: number, bytes: Uint8Array): void {
		const end = offset + bytes.length;
		if (end <= this.#nextOffset) return;
		const skip = Math.max(0, this.#nextOffset - offset);
		this.decoder.push(bytes.subarray(skip));
		this.#nextOffset = end;
	}
}

class AnsiStripper {
	#pending = '';

	push(text: string): string {
		const input = this.#pending + text;
		this.#pending = '';
		let output = '';
		for (let index = 0; index < input.length; index++) {
			if (input.charCodeAt(index) !== 0x1b) {
				output += input[index];
				continue;
			}
			const next = input[index + 1];
			if (next === undefined) {
				this.#pending = input.slice(index);
				break;
			}
			if (next === '[') {
				let end = index + 2;
				while (end < input.length && !(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)) end++;
				if (end >= input.length) {
					this.#pending = input.slice(index);
					break;
				}
				index = end;
				continue;
			}
			if (next === ']') {
				let end = index + 2;
				while (end < input.length && input.charCodeAt(end) !== 0x07 && !(input.charCodeAt(end) === 0x1b && input[end + 1] === '\\')) end++;
				if (end >= input.length || (input.charCodeAt(end) === 0x1b && input[end + 1] === undefined)) {
					this.#pending = input.slice(index);
					break;
				}
				index = input.charCodeAt(end) === 0x1b ? end + 1 : end;
				continue;
			}
			index++;
		}
		return output;
	}
}
