// Expo config plugin for the video-overlay native module.
// Injects `pod 'VideoOverlay', :path => '../modules/video-overlay'`
// into the generated ios/Podfile when use_expo_modules! has not already
// auto-linked it (e.g. when the local file: symlink is not followed).

const { withPodfile } = require('@expo/config-plugins');

/** @param {import('@expo/config-plugins').ExpoConfig} config */
const withVideoOverlay = (config) => {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;

    // Guard: skip if the pod is already present in ANY form
    // (use_expo_modules! adds it with an absolute path; we add a relative one).
    if (
      podfile.includes("pod 'VideoOverlay'") ||
      podfile.includes('pod "VideoOverlay"')
    ) {
      return cfg;
    }

    const podLine = "  pod 'VideoOverlay', :path => '../modules/video-overlay'";

    // Inject inside the target block, right after use_expo_modules!
    const marker = 'use_expo_modules!';
    if (podfile.includes(marker)) {
      cfg.modResults.contents = podfile.replace(
        marker,
        `${marker}\n${podLine}`
      );
      return cfg;
    }

    // Fallback: inject before the last `end` in the file
    const lastEnd = podfile.lastIndexOf('\nend');
    if (lastEnd !== -1) {
      cfg.modResults.contents =
        podfile.slice(0, lastEnd) + '\n' + podLine + podfile.slice(lastEnd);
    }

    return cfg;
  });
};

module.exports = withVideoOverlay;
