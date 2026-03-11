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
  userId: string;          // e.g. "OS-2026-001"
  habitName: string;       // e.g. "WORKOUT"
  currentDay: number;      // e.g. 47
  totalDays?: number;      // e.g. 90 (omit when no challenge is set)
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
 * Burns Industrial Data overlays into a video file.
 * - First 3 s: normal video with overlay
 * - Last 2 s:  frozen final frame with overlay
 * @returns file:// URI of the processed video
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