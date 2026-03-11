/**
 * fix-ios18-compat.js
 *
 * Xcode 16 / iOS 18 SDK removed the TARGET_IPHONE_SIMULATOR macro from
 * TargetConditionals.h.  Any Swift or Obj-C source in node_modules that
 * references this symbol as a runtime constant will fail to compile with
 * "cannot find 'TARGET_IPHONE_SIMULATOR' in scope".
 *
 * This script replaces every occurrence with the canonical replacement
 * TARGET_OS_SIMULATOR, which has been the preferred API since iOS 9.
 *
 * Run automatically via the "postinstall" npm script.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Packages most likely to contain TARGET_IPHONE_SIMULATOR in native source.
// react-native-purchases bundles the RevenueCat iOS SDK (Swift) which is the
// most common source of this error on Expo SDK 51 / RN 0.74 + Xcode 16.
// expo-dev-menu and other expo-* packages may also reference this deprecated macro.
const SEARCH_DIRS = [
  path.join(ROOT, 'node_modules', 'react-native-purchases'),
  path.join(ROOT, 'node_modules', 'react-native', 'React'),
  path.join(ROOT, 'node_modules', 'react-native', 'Libraries'),
  path.join(ROOT, 'node_modules', 'react-native', 'ReactCommon'),
  path.join(ROOT, 'node_modules', 'expo-dev-menu'),
  path.join(ROOT, 'node_modules', 'expo-dev-launcher'),
  path.join(ROOT, 'node_modules', 'expo-dev-client'),
  path.join(ROOT, 'node_modules', 'expo-modules-core'),
  path.join(ROOT, 'node_modules', 'expo-camera'),
  path.join(ROOT, 'node_modules', 'expo-av'),
  path.join(ROOT, 'node_modules', 'expo-media-library'),
  path.join(ROOT, 'node_modules', 'expo-notifications'),
  path.join(ROOT, 'node_modules', 'expo-image-manipulator'),
  path.join(ROOT, 'node_modules', 'expo-linear-gradient'),
];

const EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.cpp', '.c']);

const OLD = 'TARGET_IPHONE_SIMULATOR';
const NEW = 'TARGET_OS_SIMULATOR';

let patchedFiles = 0;

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      try {
        let original = fs.readFileSync(fullPath, 'utf8');
        let changed = false;
        if (original.includes(OLD)) {
          original = original.split(OLD).join(NEW);
          changed = true;
        }
        // Swift files using TARGET_OS_SIMULATOR need `import TargetConditionals`
        if (
          path.extname(entry.name) === '.swift' &&
          original.includes(NEW) &&
          !original.includes('import TargetConditionals')
        ) {
          original = 'import TargetConditionals\n' + original;
          changed = true;
        }
        if (changed) {
          fs.writeFileSync(fullPath, original, 'utf8');
          console.log(`  patched: ${path.relative(ROOT, fullPath)}`);
          patchedFiles++;
        }
      } catch (_) {
        // skip unreadable files
      }
    }
  }
}

console.log(`[fix-ios18-compat] Replacing ${OLD} → ${NEW} in native sources…`);
for (const dir of SEARCH_DIRS) {
  walk(dir);
}
console.log(`[fix-ios18-compat] Done. ${patchedFiles} file(s) patched.`);
