import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';

export const LazySettingsSheet = lazyWithRecovery(
  toDefaultExport(() => import('@/components/SettingsSheet'), (module) => module.SettingsSheet),
);
