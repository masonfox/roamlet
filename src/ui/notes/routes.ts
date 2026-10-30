import type { Href } from 'expo-router';

/** Opens a file in the reader, positioned at the node if it is a heading in that file. */
export function readerHref(path: string, nodeId?: string | null): Href {
  return {
    pathname: '/notes/read',
    params: nodeId ? { path, node: nodeId } : { path },
  };
}

export function editorHref(path: string): Href {
  return { pathname: '/notes/edit', params: { path } };
}
