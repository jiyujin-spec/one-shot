import ExpoModulesCore
import AVFoundation
import UIKit
import CoreGraphics

public class VideoOverlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoOverlay")

    AsyncFunction("burnTextOverlay") { (inputUri: String, overlays: [[String: Any]], promise: Promise) in
      guard let url = URL(string: inputUri) else {
        promise.reject("ERR_INVALID_URI", "Invalid input URI: \(inputUri)")
        return
      }

      let asset = AVURLAsset(url: url)

      guard
        let videoTrack = asset.tracks(withMediaType: .video).first
      else {
        promise.reject("ERR_NO_VIDEO_TRACK", "No video track found in asset")
        return
      }

      let composition = AVMutableComposition()
      guard
        let compVideoTrack = composition.addMutableTrack(
          withMediaType: .video,
          preferredTrackID: kCMPersistentTrackID_Invalid
        )
      else {
        promise.reject("ERR_COMPOSITION", "Could not create composition video track")
        return
      }

      let duration = asset.duration
      do {
        try compVideoTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: duration),
          of: videoTrack,
          at: .zero
        )
      } catch {
        promise.reject("ERR_INSERT", error.localizedDescription)
        return
      }

      // Audio
      if let audioTrack = asset.tracks(withMediaType: .audio).first,
         let compAudioTrack = composition.addMutableTrack(
           withMediaType: .audio,
           preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        try? compAudioTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: duration),
          of: audioTrack,
          at: .zero
        )
      }

      // --- Video composition with CALayer text overlay ---
      let videoSize = videoTrack.naturalSize.applying(videoTrack.preferredTransform)
      let renderSize = CGSize(width: abs(videoSize.width), height: abs(videoSize.height))

      let parentLayer = CALayer()
      parentLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.isGeometryFlipped = true

      let videoLayer = CALayer()
      videoLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.addSublayer(videoLayer)

      // Build text layers from overlay items
      for item in overlays {
        guard
          let text = item["text"] as? String,
          let xRel = item["x"] as? Double,
          let yRel = item["y"] as? Double,
          let fontSize = item["fontSize"] as? Double,
          let colorHex = item["color"] as? String,
          let bold = item["bold"] as? Bool
        else { continue }

        let textLayer = CATextLayer()
        textLayer.string = text
        textLayer.fontSize = CGFloat(fontSize)
        textLayer.foregroundColor = UIColor(hex: colorHex)?.cgColor ?? UIColor.white.cgColor
        textLayer.alignmentMode = .left
        textLayer.contentsScale = UIScreen.main.scale
        textLayer.isWrapped = false

        let font: UIFont = bold
          ? UIFont.boldSystemFont(ofSize: CGFloat(fontSize))
          : UIFont.systemFont(ofSize: CGFloat(fontSize))
        textLayer.font = CTFontCreateWithName(font.fontName as CFString, CGFloat(fontSize), nil)

        // Estimate text size
        let estimatedSize = text.size(withAttributes: [.font: font])
        let layerW = min(estimatedSize.width + 20, renderSize.width)
        let layerH = estimatedSize.height + 8
        let x = CGFloat(xRel) * renderSize.width
        let y = CGFloat(yRel) * renderSize.height

        textLayer.frame = CGRect(x: x, y: y, width: layerW, height: layerH)
        parentLayer.addSublayer(textLayer)
      }

      let videoComposition = AVMutableVideoComposition()
      videoComposition.renderSize = renderSize
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
        postProcessingAsVideoLayer: videoLayer,
        in: parentLayer
      )

      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: duration)

      let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideoTrack)
      // Apply the preferred transform to correct orientation
      layerInstruction.setTransform(videoTrack.preferredTransform, at: .zero)
      instruction.layerInstructions = [layerInstruction]
      videoComposition.instructions = [instruction]

      // Output
      let outputDir = FileManager.default.temporaryDirectory
      let outputURL = outputDir.appendingPathComponent(UUID().uuidString + ".mp4")

      guard let exportSession = AVAssetExportSession(
        asset: composition,
        presetName: AVAssetExportPresetHighestQuality
      ) else {
        promise.reject("ERR_EXPORT_SESSION", "Could not create export session")
        return
      }

      exportSession.outputURL = outputURL
      exportSession.outputFileType = .mp4
      exportSession.videoComposition = videoComposition

      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          promise.resolve(outputURL.absoluteString)
        case .failed:
          promise.reject("ERR_EXPORT_FAILED", exportSession.error?.localizedDescription ?? "Export failed")
        case .cancelled:
          promise.reject("ERR_EXPORT_CANCELLED", "Export was cancelled")
        default:
          promise.reject("ERR_EXPORT_UNKNOWN", "Unknown export status")
        }
      }
    }
  }
}

// MARK: - UIColor hex helper
private extension UIColor {
  convenience init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s = String(s.dropFirst()) }
    guard s.count == 6 || s.count == 8 else { return nil }
    var val: UInt64 = 0
    guard Scanner(string: s).scanHexInt64(&val) else { return nil }
    if s.count == 6 {
      self.init(
        red:   CGFloat((val >> 16) & 0xFF) / 255,
        green: CGFloat((val >>  8) & 0xFF) / 255,
        blue:  CGFloat( val        & 0xFF) / 255,
        alpha: 1.0
      )
    } else {
      self.init(
        red:   CGFloat((val >> 24) & 0xFF) / 255,
        green: CGFloat((val >> 16) & 0xFF) / 255,
        blue:  CGFloat((val >>  8) & 0xFF) / 255,
        alpha: CGFloat( val        & 0xFF) / 255
      )
    }
  }
}
