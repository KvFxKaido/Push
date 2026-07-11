import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const sonnerSpy = vi.hoisted(() =>
  vi.fn((props: unknown) => {
    void props;
    return null;
  }),
);

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

vi.mock('sonner', () => ({
  Toaster: (props: unknown) => sonnerSpy(props),
}));

import { TOAST_TOP_OFFSET, Toaster } from './sonner';

describe('Toaster', () => {
  it('uses the single top-center lane below chat header chrome', () => {
    renderToStaticMarkup(<Toaster />);

    expect(sonnerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        position: 'top-center',
        offset: TOAST_TOP_OFFSET,
      }),
    );
  });
});
