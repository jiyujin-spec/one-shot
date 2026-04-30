import { requireOptionalNativeModule } from 'expo-modules-core';

function getModule() {
  return requireOptionalNativeModule('ICloudKVStore');
}

export const ICloudKV = {
  setItem(key: string, value: string): void {
    try {
      getModule()?.setString(key, value);
    } catch {}
  },
  getItem(key: string): string | null {
    try {
      return getModule()?.getString(key) ?? null;
    } catch {
      return null;
    }
  },
  removeItem(key: string): void {
    try {
      getModule()?.removeItem(key);
    } catch {}
  },
  synchronize(): void {
    try {
      getModule()?.synchronize();
    } catch {}
  },
};
