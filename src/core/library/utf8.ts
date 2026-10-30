// Core's own UTF-8 codec. `TextDecoder` with `fatal` is unproven on Hermes (assumption A6), and by
// default it drops a byte order mark, which saves must keep.

const REPLACEMENT = 0xfffd;
const CHUNK_LENGTH = 8192;

/** Length of the valid sequence at `offset`, or 0 if the bytes there are not valid UTF-8. */
function sequenceLength(bytes: Uint8Array, offset: number): number {
  const lead = bytes[offset];
  if (lead < 0x80) return 1;
  let length: number;
  let min = 0x80;
  let max = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
    // Rejects overlong forms and UTF-16 surrogates.
    if (lead === 0xe0) min = 0xa0;
    if (lead === 0xed) max = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
    // Rejects overlong forms and anything above U+10FFFF.
    if (lead === 0xf0) min = 0x90;
    if (lead === 0xf4) max = 0x8f;
  } else {
    return 0;
  }
  if (offset + length > bytes.length) return 0;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte < (i === 1 ? min : 0x80) || byte > (i === 1 ? max : 0xbf)) return 0;
  }
  return length;
}

/** The offset of the first byte that is not valid UTF-8, or null if all of them are. */
export function firstInvalidUtf8Offset(bytes: Uint8Array): number | null {
  let offset = 0;
  while (offset < bytes.length) {
    const length = sequenceLength(bytes, offset);
    if (length === 0) return offset;
    offset += length;
  }
  return null;
}

/**
 * Decodes bytes after validating them, keeping any byte order mark as U+FEFF. Null means the bytes
 * are not valid UTF-8. For valid bytes, `encodeUtf8` gives back exactly the same bytes.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  if (firstInvalidUtf8Offset(bytes) !== null) return null;
  const parts: string[] = [];
  let units: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const lead = bytes[offset];
    const length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    let point = length === 1 ? lead : lead & (0xff >> (length + 1));
    for (let i = 1; i < length; i++) point = (point << 6) | (bytes[offset + i] & 0x3f);
    if (point >= 0x10000) {
      point -= 0x10000;
      units.push(0xd800 | (point >> 10), 0xdc00 | (point & 0x3ff));
    } else {
      units.push(point);
    }
    offset += length;
    if (units.length >= CHUNK_LENGTH) {
      parts.push(String.fromCharCode(...units));
      units = [];
    }
  }
  parts.push(String.fromCharCode(...units));
  return parts.join('');
}

/** Encodes text as UTF-8. A lone surrogate, which only an editor can produce, becomes U+FFFD. */
export function encodeUtf8(text: string): Uint8Array {
  // Three bytes per UTF-16 unit is the most any text can need.
  const bytes = new Uint8Array(text.length * 3);
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    let point = text.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdfff) {
      const low = text.charCodeAt(i + 1);
      if (point <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        point = REPLACEMENT;
      }
    }
    if (point < 0x80) {
      bytes[length++] = point;
    } else if (point < 0x800) {
      bytes[length++] = 0xc0 | (point >> 6);
      bytes[length++] = 0x80 | (point & 0x3f);
    } else if (point < 0x10000) {
      bytes[length++] = 0xe0 | (point >> 12);
      bytes[length++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[length++] = 0x80 | (point & 0x3f);
    } else {
      bytes[length++] = 0xf0 | (point >> 18);
      bytes[length++] = 0x80 | ((point >> 12) & 0x3f);
      bytes[length++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[length++] = 0x80 | (point & 0x3f);
    }
  }
  return bytes.slice(0, length);
}
