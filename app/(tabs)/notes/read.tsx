import { useLocalSearchParams } from 'expo-router';

import { ReaderScreen } from '../../../src/ui/reader/reader-screen';

export default function ReadRoute() {
  const { path, node } = useLocalSearchParams<{ path: string; node?: string }>();
  return <ReaderScreen path={path} nodeId={node ?? null} />;
}
