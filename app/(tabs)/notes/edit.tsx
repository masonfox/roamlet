import { useLocalSearchParams } from 'expo-router';

import { EditorScreen } from '../../../src/ui/editor/editor-screen';

export default function EditRoute() {
  const { path } = useLocalSearchParams<{ path: string }>();
  return <EditorScreen key={path} path={path} />;
}
