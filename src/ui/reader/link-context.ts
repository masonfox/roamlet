import { createContext } from 'react';

import type { IndexedNode } from '../../core/index';

export interface LinkActions {
  /** What each ID link in the note resolves to, null if nothing. An ID not here isn't known yet. */
  targets: ReadonlyMap<string, IndexedNode | null>;
  openId: (id: string) => void;
  openWeb: (url: string) => void;
}

/** Context rather than props, so that a change of target doesn't rebuild the list's rows. */
export const LinkContext = createContext<LinkActions>({
  targets: new Map(),
  openId: () => undefined,
  openWeb: () => undefined,
});
