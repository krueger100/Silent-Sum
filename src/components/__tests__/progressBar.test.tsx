/**
 * The progress line that replaced the spinner on the cloud screens.
 *
 * The point of it is that it carries information a circle cannot, so these specs are about the
 * information: what assistive tech is told, what the label says, and that the fill is actually
 * proportional. The animation is not tested -- it is decoration, and the indeterminate case is
 * defined by the ABSENCE of a percentage rather than by movement.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { ProgressBar } from '@/components/ProgressBar';

/** Gives the track a width, the way a real layout pass would. */
async function layout(testID: string, width: number): Promise<void> {
  await fireEvent(screen.getByTestId(`${testID}-track`), 'layout', {
    nativeEvent: { layout: { width, height: 6, x: 0, y: 0 } },
  });
}

function widthOf(testID: string): unknown {
  const style = screen.getByTestId(testID).props.style;
  const flat: Record<string, unknown> = Object.assign(
    {},
    ...(Array.isArray(style) ? style : [style]),
  );
  return flat.width;
}

describe('a countable ProgressBar', () => {
  it('tells assistive tech the percentage, not merely that it is busy', async () => {
    await render(<ProgressBar testID="bar" value={0.25} />);

    const bar = screen.getByTestId('bar');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 25 });
  });

  it('shows the caller’s label', async () => {
    await render(<ProgressBar testID="bar" value={0.5} label="Uploading 12 of 24" />);

    expect(screen.getByTestId('bar-label')).toHaveTextContent('Uploading 12 of 24');
    expect(screen.getByTestId('bar').props.accessibilityLabel).toBe('Uploading 12 of 24');
  });

  it('fills in proportion to the measured track', async () => {
    await render(<ProgressBar testID="bar" value={0.5} />);
    await layout('bar', 200);

    expect(widthOf('bar-fill')).toBe(100);
  });

  /** A bar is the last thing that should throw. One item out should show full, not crash. */
  it('clamps a value past the end instead of overflowing', async () => {
    await render(<ProgressBar testID="bar" value={1.4} />);
    await layout('bar', 200);

    expect(widthOf('bar-fill')).toBe(200);
    expect(screen.getByTestId('bar').props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
    });
  });

  it('clamps a negative value to empty', async () => {
    await render(<ProgressBar testID="bar" value={-0.3} />);
    await layout('bar', 200);

    expect(widthOf('bar-fill')).toBe(0);
  });
});

describe('an indeterminate ProgressBar', () => {
  /**
   * The honest state for "started, but nothing countable yet" -- unwrapping a key, fetching an
   * index. Announcing 0% there would be a figure the app does not have.
   */
  it('reports no percentage at all', async () => {
    await render(<ProgressBar testID="bar" />);

    const bar = screen.getByTestId('bar');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toBeUndefined();
  });

  it('draws no proportional fill', async () => {
    await render(<ProgressBar testID="bar" />);
    await layout('bar', 200);

    expect(screen.queryByTestId('bar-fill')).toBeNull();
  });

  it('omits the label line when there is nothing to say', async () => {
    await render(<ProgressBar testID="bar" />);

    expect(screen.queryByTestId('bar-label')).toBeNull();
  });
});
