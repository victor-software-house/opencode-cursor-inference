import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
	CONNECT_FLAG_COMPRESSED,
	CONNECT_FLAG_END_STREAM,
	CONNECT_MAX_FRAME_BYTES,
	ConnectFrameDecoder,
	encodeConnectFrame,
	splitConnectFrames,
} from '@cursor/connect';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decoded = (value: Uint8Array): string => new TextDecoder().decode(value);

describe('Cursor Connect framing', () => {
	test('the complete helper and incremental decoder share one framing contract', () => {
		const input = Buffer.concat([
			encodeConnectFrame(text('one')),
			encodeConnectFrame(text('two'), CONNECT_FLAG_END_STREAM),
		]);
		const complete = splitConnectFrames(input);
		const decoder = new ConnectFrameDecoder();
		const incremental = [...decoder.push(input.subarray(0, 3)), ...decoder.push(input.subarray(3))];
		decoder.end();

		expect(incremental).toEqual(complete);
		expect(complete.map(({ body }) => decoded(body))).toEqual(['one', 'two']);
		expect(complete.map(({ endOfStream }) => endOfStream)).toEqual([false, true]);
	});

	test('one-byte network chunks reproduce the complete decode', () => {
		const input = Buffer.concat([
			encodeConnectFrame(text('alpha')),
			encodeConnectFrame(text('beta')),
		]);
		const decoder = new ConnectFrameDecoder();
		const frames = [...input].flatMap((byte) => decoder.push(Uint8Array.of(byte)));
		decoder.end();
		expect(frames.map(({ body }) => decoded(body))).toEqual(['alpha', 'beta']);
	});

	test('compressed payloads are normalized before callers see them', () => {
		const frame = encodeConnectFrame(gzipSync(text('compressed')), CONNECT_FLAG_COMPRESSED);
		expect(splitConnectFrames(frame)).toEqual([
			{ body: text('compressed'), compressed: true, endOfStream: false },
		]);
	});

	test('a truncated tail cannot finish as a clean stream', () => {
		const frame = encodeConnectFrame(text('cut')).subarray(0, 6);
		const decoder = new ConnectFrameDecoder();
		expect(decoder.push(frame)).toEqual([]);
		expect(() => decoder.end()).toThrow('Connect stream ended mid-frame');
	});

	test('a hostile length prefix is rejected before allocation', () => {
		const prefix = new Uint8Array(5);
		new DataView(prefix.buffer).setUint32(1, CONNECT_MAX_FRAME_BYTES + 1, false);
		expect(() => new ConnectFrameDecoder().push(prefix)).toThrow('exceeds');
	});
});
