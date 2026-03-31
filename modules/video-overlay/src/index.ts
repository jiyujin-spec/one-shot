import { requireOptionalNativeModule } from 'expo-modules-core';

export interface OverlayItem {
  text: string;
  x: number;        // 0.0 – 1.0 (relative to video width)
  y: number;        // 0.0 – 1.0 (relative to video height)
  fontSize: number;
  color: string;    // hex e.g. "#FFFFFF"
  bold: boolean;
}

export interface ProcessVideoOptions {
  inputPath: string;              // file:// URI of the source video
  outputPath?: string;            // optional output file:// URI
  habitName: string;              // e.g. "WORKOUT" → displayed as "HABIT: WORKOUT"
  currentDay: number;             // e.g. 15 → displayed as "DAY 015"
  captureTimestamp?: number;      // ms since epoch; used to format upper/lower bar timestamps
  colorFilterEnabled?: boolean;   // apply dark overlay (exposure -0.7 EV approx); default true
}

function getModule() {
  const mod = requireOptionalNativeModule('VideoOverlay');
  if (!mod) {
    throw new Error(
      'VideoOverlay native module is not available. ' +
      'Run `expo run:android` or `expo run:ios` to create a development build.'
    );
  }
  return mod;
}

/**
 * Processes a video file through the One Shot 9:16 filter pipeline.
 *
 * Output: 1080 × 1920 (TikTok / Reels standard)
 *   ┌──────────────────────────────┐
 *   │  upper black bar  (420 px)   │  ● ne shot  |  DAY 015
 *   │                              │  2026.03.31_14:00
 *   ├──────────────────────────────┤
 *   │   center video  1080×1080    │  1:1 center-crop + colour grade
 *   │  ┌                       ┘  │  corner brackets on video
 *   ├──────────────────────────────┤
 *   │  lower black bar  (420 px)   │  2026.03.31 14:00
 *   │                              │  HABIT: DISCIPLINE
 *   └──────────────────────────────┘
 *
 * @returns file:// URI of the processed 9:16 video
 */
export async function processVideo(options: ProcessVideoOptions): Promise<string> {
  return getModule().processVideo(options);
}

/**
 * @deprecated Use processVideo() instead.
 */
export async function burnTextOverlay(
  inputUri: string,
  overlays: OverlayItem[]
): Promise<string> {
  return getModule().burnTextOverlay(inputUri, overlays);
}
