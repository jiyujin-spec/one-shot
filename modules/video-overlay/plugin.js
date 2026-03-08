// Expo config plugin for the video-overlay native module.
// This file is intentionally plain JavaScript so Node.js can load it
// without TypeScript transpilation during `expo start` / EAS build.
// The native module is registered via expo-module.config.json auto-linking.

/** @param {import('@expo/config-plugins').ConfigPlugin} config */
const withVideoOverlay = (config) => config;

module.exports = withVideoOverlay;
