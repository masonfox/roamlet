import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

describe('ui test project', () => {
  it('renders a React Native component under jest-expo', async () => {
    await render(<Text>Roamlet</Text>);
    expect(screen.getByText('Roamlet')).toBeTruthy();
  });
});
