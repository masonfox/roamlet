import type { FileStatus } from '../../core/index';

/** The status words a file's row shows, so they read the same in the tree and in search. */
export function statusMarks(status: FileStatus): string[] {
  switch (status) {
    case 'not_downloaded':
      return ['Not downloaded'];
    case 'invalid_utf8':
      return ['Not valid UTF-8'];
    case 'unreadable':
      return ['Couldn’t be read'];
    default:
      return [];
  }
}

export function rowLabel(parts: string[]): string {
  return parts.join(', ');
}
