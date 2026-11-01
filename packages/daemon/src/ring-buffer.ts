export interface RingRead {
	data: Buffer;
	offset: number;
	nextOffset: number;
	truncated: boolean;
}

export class ByteRingBuffer {
	capacity: number;
	#buffer: Buffer;
	#start = 0;
	#length = 0;
	#totalBytes = 0;

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('ring buffer capacity must be a positive integer');
		this.capacity = capacity;
		this.#buffer = Buffer.alloc(capacity);
	}

	get totalBytes(): number {
		return this.#totalBytes;
	}

	get startOffset(): number {
		return this.#totalBytes - this.#length;
	}

	get length(): number {
		return this.#length;
	}

	append(chunk: Uint8Array): number {
		const offset = this.#totalBytes;
		const bytes = Buffer.from(chunk);
		this.#totalBytes += bytes.length;
		if (bytes.length === 0) return offset;

		if (bytes.length >= this.capacity) {
			bytes.copy(this.#buffer, 0, bytes.length - this.capacity);
			this.#start = 0;
			this.#length = this.capacity;
			return offset;
		}

		for (let index = 0; index < bytes.length; index++) {
			if (this.#length < this.capacity) {
				const target = (this.#start + this.#length) % this.capacity;
				this.#buffer[target] = bytes[index]!;
				this.#length++;
			} else {
				this.#buffer[this.#start] = bytes[index]!;
				this.#start = (this.#start + 1) % this.capacity;
			}
		}
		return offset;
	}

	resize(capacity: number): void {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('ring buffer capacity must be a positive integer');
		if (capacity === this.capacity) return;
		const newStartOffset = Math.max(this.startOffset, this.#totalBytes - capacity);
		const recent = this.read(newStartOffset, capacity).data;
		this.capacity = capacity;
		this.#buffer = Buffer.alloc(capacity);
		this.#start = 0;
		this.#length = Math.min(recent.length, capacity);
		recent.copy(this.#buffer, 0, recent.length - this.#length);
	}

	read(offset = this.startOffset, maxBytes = this.capacity): RingRead {
		if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
		const startOffset = this.startOffset;
		const requested = Math.max(0, Math.trunc(offset));
		const actualOffset = Math.max(startOffset, Math.min(requested, this.#totalBytes));
		const truncated = requested < startOffset;
		const available = Math.min(this.#totalBytes - actualOffset, maxBytes);
		const logicalIndex = actualOffset - startOffset;
		const physicalStart = (this.#start + logicalIndex) % this.capacity;
		const firstLength = Math.min(available, this.capacity - physicalStart);
		const data = Buffer.allocUnsafe(available);
		this.#buffer.copy(data, 0, physicalStart, physicalStart + firstLength);
		if (firstLength < available) this.#buffer.copy(data, firstLength, 0, available - firstLength);
		return { data, offset: actualOffset, nextOffset: actualOffset + available, truncated };
	}
}
