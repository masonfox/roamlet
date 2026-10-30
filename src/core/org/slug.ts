const PLACEHOLDER_SLUG = 'untitled';
// Most filesystems allow 255 bytes in a name, which 80 CJK characters plus the timestamp exceed.
const MAX_SLUG_BYTES = 200;

/**
 * Org-roam's documented slug: combining marks stripped, runs of anything else that is not a letter
 * or digit mapped to one `_`, no `_` at either end, lowercase (Decision 7).
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .normalize('NFC');
  return limitBytes(slug).replace(/_$/, '') || PLACEHOLDER_SLUG;
}

function limitBytes(slug: string): string {
  let bytes = 0;
  let result = '';
  for (const point of slug) {
    bytes += utf8Length(point.codePointAt(0)!);
    if (bytes > MAX_SLUG_BYTES) break;
    result += point;
  }
  return result;
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}
