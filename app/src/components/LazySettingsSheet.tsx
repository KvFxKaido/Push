import { lazy } from 'react';

export const LazySettingsSheet = lazy(() =>
  import('@/components/SettingsSheet').then(m => ({ default: m.SettingsSheet }))
);
