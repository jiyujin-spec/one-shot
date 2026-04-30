"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ICloudKV = void 0;
const expo_modules_core_1 = require("expo-modules-core");

function getModule() {
  return (0, expo_modules_core_1.requireOptionalNativeModule)('ICloudKVStore');
}

exports.ICloudKV = {
  setItem(key, value) {
    try { getModule()?.setString(key, value); } catch {}
  },
  getItem(key) {
    try { return getModule()?.getString(key) ?? null; } catch { return null; }
  },
  removeItem(key) {
    try { getModule()?.removeItem(key); } catch {}
  },
  synchronize() {
    try { getModule()?.synchronize(); } catch {}
  },
};
