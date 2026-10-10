import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.creatornet.webapp', appName: 'CreatorNet', webDir: 'dist',
  loggingBehavior: 'none', backgroundColor: '#000000',
  ios: { preferredContentMode: 'mobile', contentInset: 'never', allowsLinkPreview: false },
};
export default config;
