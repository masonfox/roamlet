import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import type { LibraryController, LibrarySnapshot } from './library-controller';

export type { LibraryFailure, LibraryServices, LibrarySnapshot } from './library-controller';

/**
 * The library as screens see it, from `useLibrary`. Queries go through `index`, file operations
 * through `store`. Both are null when there is nothing to use, so check them.
 */
export interface LibraryContextValue
  extends
    LibrarySnapshot,
    Pick<
      LibraryController,
      | 'refresh'
      | 'rebuild'
      | 'recheckAccess'
      | 'chooseFolder'
      | 'switchToAppOwnedFolder'
      | 'ids'
      | 'clock'
    > {}

/** Exported so a test can provide a fixed value. The app uses `LibraryProvider`. */
export const LibraryContext = createContext<LibraryContextValue | null>(null);

/** Starts the library and reconciles each time the app returns from the background. */
export function LibraryProvider({
  controller,
  children,
}: {
  controller: LibraryController;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    void controller.start();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      // Not from `inactive`, which iOS also passes through for Control Center and system alerts.
      if (previous === 'background' && next === 'active') void controller.foreground();
      previous = next;
    });
    return () => subscription.remove();
  }, [controller]);

  const value = useMemo<LibraryContextValue>(
    () => ({
      ...snapshot,
      refresh: controller.refresh,
      rebuild: controller.rebuild,
      recheckAccess: controller.recheckAccess,
      chooseFolder: controller.chooseFolder,
      switchToAppOwnedFolder: controller.switchToAppOwnedFolder,
      ids: controller.ids,
      clock: controller.clock,
    }),
    [snapshot, controller],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary needs a LibraryProvider above it');
  return value;
}
