import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Field } from '@/components/Field';

describe('Field', () => {
  it('hides a secure value until the user asks to see it', async () => {
    await render(
      <Field
        testID="passphrase"
        label="Recovery passphrase"
        value="hunter2"
        onChangeText={jest.fn()}
        secure
      />,
    );

    expect(screen.getByTestId('passphrase').props.secureTextEntry).toBe(true);
    const toggle = screen.getByTestId('passphrase_reveal');
    expect(toggle).toHaveTextContent('Show');
    expect(toggle.props.accessibilityLabel).toBe('Show recovery passphrase');

    await fireEvent.press(toggle);

    expect(screen.getByTestId('passphrase').props.secureTextEntry).toBe(false);
    expect(screen.getByTestId('passphrase_reveal')).toHaveTextContent('Hide');
    expect(screen.getByTestId('passphrase_reveal').props.accessibilityLabel).toBe(
      'Hide recovery passphrase',
    );

    await fireEvent.press(screen.getByTestId('passphrase_reveal'));

    expect(screen.getByTestId('passphrase').props.secureTextEntry).toBe(true);
  });

  it('offers nothing to reveal on a field that was never hidden', async () => {
    await render(<Field testID="email" label="Email" value="a@b.co" onChangeText={jest.fn()} />);

    expect(screen.getByTestId('email').props.secureTextEntry).toBe(false);
    expect(screen.queryByTestId('email_reveal')).toBeNull();
  });

  it('reveals one field at a time, so a confirmation stays covered', async () => {
    await render(
      <>
        <Field testID="one" label="Recovery passphrase" value="a" onChangeText={jest.fn()} secure />
        <Field
          testID="two"
          label="Confirm recovery passphrase"
          value="a"
          onChangeText={jest.fn()}
          secure
        />
      </>,
    );

    await fireEvent.press(screen.getByTestId('one_reveal'));

    expect(screen.getByTestId('one').props.secureTextEntry).toBe(false);
    expect(screen.getByTestId('two').props.secureTextEntry).toBe(true);
  });

  it('comes back hidden when the screen mounts it again', async () => {
    const view = await render(
      <Field testID="p" label="Recovery passphrase" value="x" onChangeText={jest.fn()} secure />,
    );
    await fireEvent.press(screen.getByTestId('p_reveal'));
    expect(screen.getByTestId('p').props.secureTextEntry).toBe(false);

    view.unmount();
    await render(
      <Field testID="p" label="Recovery passphrase" value="x" onChangeText={jest.fn()} secure />,
    );

    expect(screen.getByTestId('p').props.secureTextEntry).toBe(true);
  });
});
