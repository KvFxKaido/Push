import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.push.app',
  appName: 'Push',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    url: 'https://push.ishawnd.workers.dev',
  },
};

export default config;
