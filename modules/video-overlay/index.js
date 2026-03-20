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
// IMPORTANT: Do NOT call requireNativeModule at the top level.
// Top-level calls throw synchronously during JS evaluation when the native
// module is absent, which crashes the app before React can render the
// ErrorBoundary. Use requireOptionalNativeModule lazily inside each function.
function getModule() {
    const mod = (0, expo_modules_core_1.requireOptionalNativeModule)('VideoOverlay');
    if (!mod) {
        throw new Error('VideoOverlay native module is not available. Run `expo run:ios` or `expo run:android` to create a development build.');
    }
    return mod;
}
/**
 * Burns One Shot filter overlays into a video file.
 * @returns file:// URI of the processed video
 */
function processVideo(options) {
    return __awaiter(this, void 0, void 0, function* () {
        return getModule().processVideo(options);
    });
}
exports.processVideo = processVideo;
/**
 * @deprecated Use processVideo() instead.
 * Burns text overlays into a video file.
 */
function burnTextOverlay(inputUri, overlays) {
    return __awaiter(this, void 0, void 0, function* () {
        return getModule().burnTextOverlay(inputUri, overlays);
    });
}
exports.burnTextOverlay = burnTextOverlay;
