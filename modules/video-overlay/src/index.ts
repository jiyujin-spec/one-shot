import { requireNativeModule } from 'expo-modules-core';

export interface OverlayItem {
  text: string;
  x: number;        // 0.0 – 1.0 (relative to video width)
  y: number;        // 0.0 – 1.0 (relative to video height)
  fontSize: number;
  color: string;    // hex e.g. "#FFFFFF"
  bold: boolean;
}

const VideoOverlay = requireNativeModule('VideoOverlay');

/**
 * Burns text overlays into a video file.
 * @param inputUri  file:// URI of the source video
 * @param overlays  array of text overlay items
 * @returns file:// URI of the new video saved to the Camera Roll temp path
 */
export async function burnTextOverlay(
  inputUri: string,
  overlays: OverlayItem[]
): Promise<string> {
  return VideoOverlay.burnTextOverlay(inputUri, overlays);
}
