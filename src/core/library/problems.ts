import type { FileStoreFailure, FileStoreFailureKind } from '../ports';

export type LibraryProblemKind =
  | FileStoreFailureKind
  /** Every file name tried was already in use. */
  | 'name_taken';

/** A failed library operation, ready to show. */
export interface LibraryProblem {
  kind: LibraryProblemKind;
  /** Plain language, for the user. */
  message: string;
  /** Diagnostic detail for logs. Not for display. */
  detail: string;
  /** The folder itself may be gone, so `LibraryManager.recheck` should run. */
  accessMayBeLost: boolean;
}

/** What the user was doing, which the message names. */
export type LibraryAction = 'open' | 'save' | 'create' | 'conflict_copy' | 'export';

const SUBJECT: Record<LibraryAction, string> = {
  open: 'This note couldn’t be opened.',
  save: 'Your changes weren’t saved.',
  create: 'This note wasn’t saved.',
  conflict_copy: 'The conflict copy wasn’t saved.',
  export: 'The library couldn’t be exported.',
};

const REASON: Record<FileStoreFailureKind, string> = {
  not_found: 'The file or its folder is no longer there.',
  access_denied: 'Roamlet doesn’t have permission to use this location.',
  not_downloaded: 'The file isn’t on this device yet.',
  provider_error: 'The storage provider reported an error, or the device may be full. Try again.',
  name_changed: 'The storage provider changed the file’s name, so it wasn’t kept as saved.',
};

/** Maps a store failure to what the user sees (Provider rejects a save). */
export function describeFailure(failure: FileStoreFailure, action: LibraryAction): LibraryProblem {
  return {
    kind: failure.kind,
    message: `${SUBJECT[action]} ${REASON[failure.kind]}`,
    detail: failure.message,
    accessMayBeLost: failure.kind === 'access_denied' || failure.kind === 'not_found',
  };
}

export function nameTakenProblem(action: LibraryAction, attempts: number): LibraryProblem {
  return {
    kind: 'name_taken',
    message: `${SUBJECT[action]} Every file name Roamlet tried is already in use.`,
    detail: `Tried ${attempts} file names`,
    accessMayBeLost: false,
  };
}
