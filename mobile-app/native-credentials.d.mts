export interface NativeSession {
  version: 1;
  server: string;
  token: string;
}
export interface NativeSecureStore {
  setSynchronize(value: boolean): Promise<void>;
  setDefaultKeychainAccess(value: number): Promise<void>;
  get(key: string, convertDate?: boolean, sync?: boolean): Promise<unknown>;
  set(key: string, value: NativeSession, convertDate?: boolean, sync?: boolean, access?: number): Promise<void>;
  remove(key: string, sync?: boolean): Promise<unknown>;
}
export function createNativeCredentials(options: {
  secure: NativeSecureStore;
  available: () => boolean;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  tabStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  server: () => string;
  purgeQueue: () => Promise<void>;
  deviceOnlyAccess: number;
}): {
  ready: Promise<void>;
  getToken(): string | null;
  isShared(): boolean;
  set(token: string, options?: { shared?: boolean }): Promise<void>;
  clear(): Promise<void>;
};
export function purgeNativeQueueToken(indexedDB: IDBFactory, name?: string): Promise<void>;
