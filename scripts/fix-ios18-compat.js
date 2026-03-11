/**
 * fix-ios18-compat.js
 *
 * Xcode 16 / iOS 18 SDK removed the TARGET_IPHONE_SIMULATOR macro from
 * TargetConditionals.h.  Any Swift or Obj-C source in node_modules that
 * references this symbol as a runtime constant will fail to compile with
 * "cannot find 'TARGET_IPHONE_SIMULATOR' in scope".
 *
 * For Swift files: replaces TARGET_IPHONE_SIMULATOR / TARGET_OS_SIMULATOR with
 * the Swift-native `targetEnvironment(simulator)` conditional compilation syntax,
 * which does NOT require any imports and is the canonical approach for Swift code.
 *
 * For Obj-C / C / C++ files: replaces TARGET_IPHONE_SIMULATOR with
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

const SWIFT_EXT = new Set(['.swift']);
const NATIVE_EXT = new Set(['.m', '.mm', '.h', '.cpp', '.c']);

const OLD_IPHONE = 'TARGET_IPHONE_SIMULATOR';
const OLD_OS = 'TARGET_OS_SIMULATOR';

let patchedFiles = 0;

/**
 * Patch a Swift file:
 *  1. Replace #if / #elseif uses of TARGET_IPHONE_SIMULATOR or TARGET_OS_SIMULATOR
 *     with `targetEnvironment(simulator)` — the Swift-native conditional syntax.
 *  2. Replace bare value usages like `let isSimulator = TARGET_OS_SIMULATOR > 0`
 *     with a compilable #if targetEnvironment(simulator) block.
 *  3. If any bare macro references remain (rare, non-#if usage), ensure
 *     `import Foundation` and `import TargetConditionals` appear before
 *     the first import statement to avoid "cannot find in scope" errors.
 */
function patchSwift(content) {
  let changed = false;

  // 1. Replace #if / #elseif directive usages with targetEnvironment(simulator).
  // Handles patterns like:
  //   #if TARGET_IPHONE_SIMULATOR
  //   #elseif TARGET_IPHONE_SIMULATOR
  //   #if TARGET_OS_SIMULATOR
  //   #if TARGET_IPHONE_SIMULATOR == 1
  //   #if TARGET_OS_SIMULATOR == 1
  const directivePattern = /(#(?:if|elseif)\s+)(TARGET_IPHONE_SIMULATOR|TARGET_OS_SIMULATOR)(\s*==\s*1)?/g;
  const replaced = content.replace(directivePattern, (_, prefix, _macro, _eq) => {
    changed = true;
    return `${prefix}targetEnvironment(simulator)`;
  });
  content = replaced;

  // 2. Replace bare value expressions like:
  //   let isSimulator = TARGET_OS_SIMULATOR > 0
  //   var isSimulator = TARGET_IPHONE_SIMULATOR > 0
  //   let isSimulator = TARGET_OS_SIMULATOR != 0
  //   let isSimulator = TARGET_OS_SIMULATOR (no comparison)
  // These cannot be used as runtime values in Swift; replace with a compilable
  // #if targetEnvironment(simulator) block that assigns a Bool literal.
  const valuePattern = /^([ \t]*)(let|var)(\s+\w+)\s*(?::\s*Bool\s*)?=\s*(?:TARGET_OS_SIMULATOR|TARGET_IPHONE_SIMULATOR)\s*(?:[><!]=?\s*\d+)?/gm;
  content = content.replace(valuePattern, (match, indent, keyword, namePart) => {
    changed = true;
    return (
      `${indent}#if targetEnvironment(simulator)\n` +
      `${indent}${keyword}${namePart} = true\n` +
      `${indent}#else\n` +
      `${indent}${keyword}${namePart} = false\n` +
      `${indent}#endif`
    );
  });

  // 3. Also replace any remaining bare TARGET_IPHONE_SIMULATOR → TARGET_OS_SIMULATOR
  // (non-#if context, e.g. used as a value — uncommon in Swift but possible).
  if (content.includes(OLD_IPHONE)) {
    content = content.split(OLD_IPHONE).join(OLD_OS);
    changed = true;
  }

  // 4. If TARGET_OS_SIMULATOR still appears after the above replacements, the file
  // needs `import TargetConditionals` (and `import Foundation` for safety).
  // Insert them before the first existing `import` statement.
  if (content.includes(OLD_OS)) {
    const hasFoundation = /\bimport\s+Foundation\b/.test(content);
    const hasTargetConditionals = /\bimport\s+TargetConditionals\b/.test(content);

    if (!hasFoundation || !hasTargetConditionals) {
      const importInsert = [
        !hasFoundation ? 'import Foundation' : null,
        !hasTargetConditionals ? 'import TargetConditionals' : null,
      ]
        .filter(Boolean)
        .join('\n');

      // Insert before the first `import` line so that the macros are available.
      const firstImportIndex = content.search(/^import\s+/m);
      if (firstImportIndex !== -1) {
        content =
          content.slice(0, firstImportIndex) +
          importInsert +
          '\n' +
          content.slice(firstImportIndex);
      } else {
        // No existing import found — prepend at the very top.
        content = importInsert + '\n' + content;
      }
      changed = true;
    }
  }

  return { content, changed };
}

/**
 * Patch Obj-C / C / C++ files:
 *   Replace TARGET_IPHONE_SIMULATOR → TARGET_OS_SIMULATOR (macro still valid here).
 */
function patchNative(content) {
  if (!content.includes(OLD_IPHONE)) return { content, changed: false };
  return { content: content.split(OLD_IPHONE).join(OLD_OS), changed: true };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else {
      const ext = path.extname(entry.name);
      const isSwift = SWIFT_EXT.has(ext);
      const isNative = NATIVE_EXT.has(ext);
      if (!isSwift && !isNative) continue;

      try {
        const original = fs.readFileSync(fullPath, 'utf8');
        const { content, changed } = isSwift
          ? patchSwift(original)
          : patchNative(original);

        if (changed) {
          fs.writeFileSync(fullPath, content, 'utf8');
          console.log(`  patched: ${path.relative(ROOT, fullPath)}`);
          patchedFiles++;
        }
      } catch (_) {
        // skip unreadable files
      }
    }
  }
}

console.log(
  `[fix-ios18-compat] Replacing deprecated simulator macros in native sources…`
);
for (const dir of SEARCH_DIRS) {
  walk(dir);
}
console.log(`[fix-ios18-compat] Done. ${patchedFiles} file(s) patched.`);
