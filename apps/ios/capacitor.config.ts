import type { CapacitorConfig } from '@capacitor/cli';
// Draft identifier: verify the existing Apple identifier/team before signing on Mac.
const config: CapacitorConfig = {
  appId: 'net.creatornet.ios', appName: 'CreatorNet', webDir: 'dist',
  loggingBehavior: 'none', backgroundColor: '#000000',
  ios: { preferredContentMode: 'mobile', contentInset: 'never', allowsLinkPreview: false },
};
export default config;
