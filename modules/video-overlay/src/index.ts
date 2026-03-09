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
  inputPath: string;       // file:// URI of the source video
  outputPath?: string;     // optional output file:// URI
  habitName: string;       // e.g. "WORKOUT" → displayed as "HABIT:WORKOUT"
  currentDay: number;      // e.g. 8 → displayed as "DAY8"
  captureTime?: string;    // "YYYY.MM/DD HH:MM" formatted timestamp; defaults to current time if omitted
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
 * Burns One Shot filter overlays into a video file.
 * Output is cropped to 1:1 square with dark/cold tone and the standard overlay design:
 *   - Top-left:    corner bracket + red dot + "ne shot"
 *   - Top-right:   "DAY{currentDay}"
 *   - Bottom-left: timestamp (line 1) + "HABIT:{habitName}" (line 2)
 *   - Bottom-right: corner bracket
 * @returns file:// URI of the processed square video
 */
export async function processVideo(options: ProcessVideoOptions): Promise<string> {
  return getModule().processVideo(options);
}

/**
 * @deprecated Use processVideo() instead.
 * Burns text overlays into a video file.
 */
export async function burnTextOverlay(
  inputUri: string,
  overlays: OverlayItem[]
): Promise<string> {
  return getModule().burnTextOverlay(inputUri, overlays);
}
