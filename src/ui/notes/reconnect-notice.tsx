import { useState } from 'react';
import { Text } from 'react-native';

import { useLibrary } from '../library-context';
import { useTheme } from '../theme';
import { Notice, TextButton } from './controls';

/** Explains a lost library, and offers the way back. */
export function ReconnectNotice({ message }: { message: string }) {
  const { chooseFolder } = useLibrary();
  const [refusal, setRefusal] = useState<string | null>(null);
  const theme = useTheme();
  return (
    <Notice message={message}>
      {refusal ? (
        <Text style={[theme.type.body, { color: theme.colors.danger }]}>{refusal}</Text>
      ) : null}
      <TextButton
        label="Reconnect folder"
        onPress={() => {
          setRefusal(null);
          void chooseFolder().then((result) => {
            if (result.status === 'refused') setRefusal(result.message);
          });
        }}
      />
    </Notice>
  );
}
