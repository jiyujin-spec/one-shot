"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.burnTextOverlay = exports.processVideo = void 0;
const expo_modules_core_1 = require("expo-modules-core");
const VideoOverlay = (0, expo_modules_core_1.requireNativeModule)('VideoOverlay');
/**
 * Burns Industrial Data overlays into a video file.
 * - First 3 s: normal video with overlay
 * - Last 2 s:  frozen final frame with overlay
 * @returns file:// URI of the processed video
 */
function processVideo(options) {
    return __awaiter(this, void 0, void 0, function* () {
        return VideoOverlay.processVideo(options);
    });
}
exports.processVideo = processVideo;
/**
 * @deprecated Use processVideo() instead.
 * Burns text overlays into a video file.
 */
function burnTextOverlay(inputUri, overlays) {
    return __awaiter(this, void 0, void 0, function* () {
        return VideoOverlay.burnTextOverlay(inputUri, overlays);
    });
}
exports.burnTextOverlay = burnTextOverlay;
