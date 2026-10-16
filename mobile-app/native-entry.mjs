import { Capacitor } from '@capacitor/core';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';
import { createNativeCredentials, purgeNativeQueueToken } from './native-credentials.mjs';
window.VdsNativeCredentials = createNativeCredentials({
  secure: SecureStorage,
  available: () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SecureStorage'),
  storage: window.localStorage, tabStorage: window.sessionStorage,
  server: () => window.localStorage.getItem('vds_api_base') || '',
  purgeQueue: () => purgeNativeQueueToken(indexedDB, 'vds_mobile' + (window.VDS_BASE_PATH || '')),
  deviceOnlyAccess: KeychainAccess.whenUnlockedThisDeviceOnly,
});
