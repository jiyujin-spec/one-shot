// Expo config plugin: injects ICloudKVStore pod into the generated Podfile.
const { withPodfile } = require('@expo/config-plugins');

const withICloudKVStore = (config) => {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;

    if (
      podfile.includes("pod 'ICloudKVStore'") ||
      podfile.includes('pod "ICloudKVStore"')
    ) {
      return cfg;
    }

    const podLine = "  pod 'ICloudKVStore', :path => '../modules/icloud-kv-store'";
    const marker = 'use_expo_modules!';

    if (podfile.includes(marker)) {
      cfg.modResults.contents = podfile.replace(marker, `${marker}\n${podLine}`);
      return cfg;
    }

    const lastEnd = podfile.lastIndexOf('\nend');
    if (lastEnd !== -1) {
      cfg.modResults.contents =
        podfile.slice(0, lastEnd) + '\n' + podLine + podfile.slice(lastEnd);
    }

    return cfg;
  });
};

module.exports = withICloudKVStore;
