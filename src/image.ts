export interface CursorImage {
	readonly data: string;
	readonly mimeType: string;
}

interface ImageDimension {
	readonly width: number;
	readonly height: number;
}

function assertDimension(width: number, height: number): ImageDimension {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new Error('Cursor image has invalid dimensions');
	}
	return { width, height };
}

function decodeBase64(data: string): Uint8Array {
	if (
		data === '' ||
		data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
	) {
		throw new Error('Cursor image data is not valid base64');
	}
	const bytes = Buffer.from(data, 'base64');
	if (bytes.toString('base64') !== data) {
		throw new Error('Cursor image data is not canonical base64');
	}
	return bytes;
}

function pngDimension(bytes: Uint8Array): ImageDimension {
	if (
		bytes.byteLength < 24 ||
		!bytes
			.subarray(0, 8)
			.every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
	) {
		throw new Error('Cursor image MIME type does not match PNG bytes');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return assertDimension(view.getUint32(16), view.getUint32(20));
}

function gifDimension(bytes: Uint8Array): ImageDimension {
	const signature = new TextDecoder().decode(bytes.subarray(0, 6));
	if (bytes.byteLength < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
		throw new Error('Cursor image MIME type does not match GIF bytes');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return assertDimension(view.getUint16(6, true), view.getUint16(8, true));
}

function bmpDimension(bytes: Uint8Array): ImageDimension {
	if (bytes.byteLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
		throw new Error('Cursor image MIME type does not match BMP bytes');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return assertDimension(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
}

function jpegDimension(bytes: Uint8Array): ImageDimension {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		throw new Error('Cursor image MIME type does not match JPEG bytes');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 2;
	while (offset + 3 < bytes.byteLength) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		offset += 1;
		if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.byteLength) break;
		const length = view.getUint16(offset);
		if (length < 2 || offset + length > bytes.byteLength) break;
		const isStartOfFrame =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);
		if (isStartOfFrame) {
			if (length < 7) break;
			return assertDimension(view.getUint16(offset + 5), view.getUint16(offset + 3));
		}
		offset += length;
	}
	throw new Error('Cursor JPEG image has no decodable dimensions');
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return new TextDecoder().decode(bytes.subarray(start, start + length));
}

function octet(bytes: Uint8Array, index: number): number {
	const value = bytes[index];
	if (value === undefined) throw new Error('Cursor image data is truncated');
	return value;
}

function webpDimension(bytes: Uint8Array): ImageDimension {
	if (bytes.byteLength < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
		throw new Error('Cursor image MIME type does not match WebP bytes');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunk = ascii(bytes, 12, 4);
	if (chunk === 'VP8X') {
		const width = 1 + octet(bytes, 24) + (octet(bytes, 25) << 8) + (octet(bytes, 26) << 16);
		const height = 1 + octet(bytes, 27) + (octet(bytes, 28) << 8) + (octet(bytes, 29) << 16);
		return assertDimension(width, height);
	}
	if (chunk === 'VP8 ') {
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
			throw new Error('Cursor WebP VP8 frame header is malformed');
		}
		return assertDimension(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
	}
	if (chunk === 'VP8L') {
		if (bytes[20] !== 0x2f) throw new Error('Cursor WebP lossless header is malformed');
		const bits = view.getUint32(21, true);
		return assertDimension((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
	}
	throw new Error(`Cursor WebP chunk '${chunk}' is unsupported`);
}

function imageDimension(mimeType: string, bytes: Uint8Array): ImageDimension {
	switch (mimeType) {
		case 'image/png':
			return pngDimension(bytes);
		case 'image/jpeg':
			return jpegDimension(bytes);
		case 'image/gif':
			return gifDimension(bytes);
		case 'image/webp':
			return webpDimension(bytes);
		case 'image/bmp':
			return bmpDimension(bytes);
		default:
			throw new Error(`Cursor image MIME type '${mimeType}' is unsupported`);
	}
}

export function validateCursorImage(image: CursorImage): CursorImage {
	if (image.mimeType !== image.mimeType.trim() || image.mimeType !== image.mimeType.toLowerCase()) {
		throw new Error(`Cursor image MIME type '${image.mimeType}' is malformed`);
	}
	const data = decodeBase64(image.data);
	imageDimension(image.mimeType, data);
	return image;
}
