// Expo config plugin for the video-overlay native module.
// Injects `pod 'VideoOverlay', :path => '../modules/video-overlay'`
// into the generated ios/Podfile so EAS Build can link the native module.

const { withPodfile } = require('@expo/config-plugins');

/** @param {import('@expo/config-plugins').ExpoConfig} config */
const withVideoOverlay = (config) => {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;
    const podLine = "  pod 'VideoOverlay', :path => '../modules/video-overlay'";

    // Guard: skip if already injected
    if (podfile.includes(podLine)) {
      return cfg;
    }

    // Inject after the first `use_expo_modules!` or before the closing `end` of the target block
    const marker = 'use_expo_modules!';
    if (podfile.includes(marker)) {
      cfg.modResults.contents = podfile.replace(
        marker,
        `${marker}\n${podLine}`
      );
    } else {
      // Fallback: inject before the last `end`
      const lastEnd = podfile.lastIndexOf('\nend');
      if (lastEnd !== -1) {
        cfg.modResults.contents =
          podfile.slice(0, lastEnd) + '\n' + podLine + podfile.slice(lastEnd);
      }
    }

    return cfg;
  });
};

module.exports = withVideoOverlay;
