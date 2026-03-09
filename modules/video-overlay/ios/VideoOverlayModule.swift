import ExpoModulesCore
import AVFoundation
import UIKit
import CoreGraphics
import CoreText

public class VideoOverlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoOverlay")

    // ── Legacy API (kept for backward compatibility) ──────────────────────────
    AsyncFunction("burnTextOverlay") { (inputUri: String, overlays: [[String: Any]], promise: Promise) in
      guard let url = URL(string: inputUri) else {
        promise.reject("ERR_INVALID_URI", "Invalid input URI: \(inputUri)")
        return
      }
      let asset = AVURLAsset(url: url)
      guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        promise.reject("ERR_NO_VIDEO_TRACK", "No video track found in asset")
        return
      }
      let composition = AVMutableComposition()
      guard let compVideoTrack = composition.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
      ) else {
        promise.reject("ERR_COMPOSITION", "Could not create composition video track")
        return
      }
      let duration = asset.duration
      do {
        try compVideoTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: duration),
          of: videoTrack, at: .zero
        )
      } catch {
        promise.reject("ERR_INSERT", error.localizedDescription)
        return
      }
      if let audioTrack = asset.tracks(withMediaType: .audio).first,
         let compAudioTrack = composition.addMutableTrack(
           withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        try? compAudioTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: duration),
          of: audioTrack, at: .zero
        )
      }
      let videoSize = videoTrack.naturalSize.applying(videoTrack.preferredTransform)
      let renderSize = CGSize(width: abs(videoSize.width), height: abs(videoSize.height))
      let parentLayer = CALayer()
      parentLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.isGeometryFlipped = true
      let videoLayer = CALayer()
      videoLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.addSublayer(videoLayer)
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
        postProcessingAsVideoLayer: videoLayer, in: parentLayer
      )
      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
      let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideoTrack)
      layerInstruction.setTransform(videoTrack.preferredTransform, at: .zero)
      instruction.layerInstructions = [layerInstruction]
      videoComposition.instructions = [instruction]
      let outputURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString + ".mp4")
      guard let exportSession = AVAssetExportSession(
        asset: composition, presetName: AVAssetExportPresetHighestQuality
      ) else {
        promise.reject("ERR_EXPORT_SESSION", "Could not create export session")
        return
      }
      exportSession.outputURL = outputURL
      exportSession.outputFileType = .mp4
      exportSession.videoComposition = videoComposition
      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed: promise.resolve(outputURL.absoluteString)
        case .failed: promise.reject("ERR_EXPORT_FAILED", exportSession.error?.localizedDescription ?? "Export failed")
        case .cancelled: promise.reject("ERR_EXPORT_CANCELLED", "Export was cancelled")
        default: promise.reject("ERR_EXPORT_UNKNOWN", "Unknown export status")
        }
      }
    }

    // ── One Shot filter overlay API ───────────────────────────────────────────
    AsyncFunction("processVideo") { (options: [String: Any], promise: Promise) in
      guard
        let inputPath = options["inputPath"] as? String,
        let habitName = options["habitName"] as? String,
        let currentDay = options["currentDay"] as? Int
      else {
        promise.reject("ERR_INVALID_PARAMS", "Missing required parameters: inputPath, habitName, currentDay")
        return
      }

      let outputPath = options["outputPath"] as? String

      // Timestamp: use provided captureTime string or format current time
      let timestampStr: String
      if let ct = options["captureTime"] as? String, !ct.isEmpty {
        timestampStr = ct
      } else {
        let df = DateFormatter()
        df.dateFormat = "yyyy.MM/dd HH:mm"
        timestampStr = df.string(from: Date())
      }

      guard let inputURL = URL(string: inputPath) else {
        promise.reject("ERR_INVALID_URI", "Invalid inputPath URI: \(inputPath)")
        return
      }

      let asset = AVURLAsset(url: inputURL)

      guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        promise.reject("ERR_NO_VIDEO_TRACK", "No video track found in asset")
        return
      }

      // ── Orientation & render size ─────────────────────────────────────────

      let naturalSize = videoTrack.naturalSize
      let transform   = videoTrack.preferredTransform
      let rotated     = naturalSize.applying(transform)
      let videoW      = abs(rotated.width)
      let videoH      = abs(rotated.height)

      // Square crop: take the shorter side
      let squareSize  = min(videoW, videoH)
      let renderSize  = CGSize(width: squareSize, height: squareSize)

      // Center-crop transform: apply rotation then translate to center
      let xOffset = (squareSize - videoW) / 2.0
      let yOffset = (squareSize - videoH) / 2.0
      let cropTransform = transform.concatenating(
        CGAffineTransform(translationX: xOffset, y: yOffset)
      )

      // ── Composition ───────────────────────────────────────────────────────

      let composition = AVMutableComposition()

      guard let compVideoTrack = composition.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
      ) else {
        promise.reject("ERR_COMPOSITION", "Could not create composition video track")
        return
      }

      let totalDuration = asset.duration

      // 冒頭の暗いフレームを 0.3 秒カットするオフセット
      let trimOffset  = CMTime(seconds: 0.3, preferredTimescale: 600)
      let trimmedStart = trimOffset < totalDuration ? trimOffset : .zero
      let trimmedDuration = CMTimeSubtract(totalDuration, trimmedStart)

      do {
        try compVideoTrack.insertTimeRange(
          CMTimeRange(start: trimmedStart, duration: trimmedDuration),
          of: videoTrack, at: .zero
        )
      } catch {
        promise.reject("ERR_INSERT", error.localizedDescription)
        return
      }

      if let audioTrack = asset.tracks(withMediaType: .audio).first,
         let compAudioTrack = composition.addMutableTrack(
           withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        try? compAudioTrack.insertTimeRange(
          CMTimeRange(start: trimmedStart, duration: trimmedDuration),
          of: audioTrack, at: .zero
        )
      }

      // ── Layer tree ───────────────────────────────────────────────────────

      let parentLayer = CALayer()
      parentLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.isGeometryFlipped = true   // y = 0 at top

      let videoLayer = CALayer()
      videoLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.addSublayer(videoLayer)

      // ── Dark / cold tone overlay ──────────────────────────────────────────

      let darkOverlay = CALayer()
      darkOverlay.frame = CGRect(origin: .zero, size: renderSize)
      darkOverlay.backgroundColor = UIColor(
        red: 0, green: 0.04, blue: 0.12, alpha: 0.38
      ).cgColor
      parentLayer.addSublayer(darkOverlay)

      // ── Layout constants ──────────────────────────────────────────────────

      let S        = squareSize
      let pad      = S * 0.045            // edge padding
      let fontSize = S * 0.038            // text size (bold, larger)
      let lineGap  = fontSize * 1.35      // line height for 2-line BL block

      let fontName: String = {
        // Prefer bold system font for clean look
        let bold = UIFont.boldSystemFont(ofSize: fontSize)
        return bold.fontName
      }()
      let uiFont   = UIFont.boldSystemFont(ofSize: fontSize)
      let attrs: [NSAttributedString.Key: Any] = [.font: uiFont]
      func tw(_ s: String) -> CGFloat { s.size(withAttributes: attrs).width }
      let layerH = fontSize + 6

      let white    = UIColor.white.cgColor
      let whiteDim = UIColor(white: 1.0, alpha: 0.85).cgColor

      // Shadow helper
      func addShadow(_ layer: CALayer) {
        layer.shadowColor   = UIColor.black.withAlphaComponent(0.55).cgColor
        layer.shadowOpacity = 1.0
        layer.shadowRadius  = 3.0
        layer.shadowOffset  = CGSize(width: 1, height: 1)
      }

      // ── Bracket arm length ────────────────────────────────────────────────

      let armLen   = S * 0.07
      let armWidth = max(S * 0.003, 1.5)

      // ── Helper: make a text layer ─────────────────────────────────────────

      func makeTextLayer(_ text: String, x: CGFloat, y: CGFloat, color: CGColor = UIColor.white.cgColor) -> CATextLayer {
        let layer = CATextLayer()
        layer.string    = text
        layer.fontSize  = fontSize
        layer.foregroundColor = color
        layer.alignmentMode   = .left
        layer.contentsScale   = 2.0
        layer.isWrapped = false
        layer.font = CTFontCreateWithName(fontName as CFString, fontSize, nil)
        addShadow(layer)
        layer.frame = CGRect(x: x, y: y, width: tw(text) + 8, height: layerH)
        return layer
      }

      // ── TL corner bracket ─────────────────────────────────────────────────
      // ┌  (top edge + left edge)

      let tlPath = CGMutablePath()
      tlPath.move(to:    CGPoint(x: pad + armLen, y: pad))
      tlPath.addLine(to: CGPoint(x: pad,          y: pad))
      tlPath.addLine(to: CGPoint(x: pad,          y: pad + armLen))

      let tlBracket = CAShapeLayer()
      tlBracket.path        = tlPath
      tlBracket.strokeColor = white
      tlBracket.fillColor   = UIColor.clear.cgColor
      tlBracket.lineWidth   = armWidth
      tlBracket.lineCap     = .square
      addShadow(tlBracket)
      parentLayer.addSublayer(tlBracket)

      // ── Red dot (●) – acts as the "O" in "One shot" ───────────────────────

      let dotSize   = fontSize * 0.95
      let dotX      = pad + armLen * 0.25
      let dotY      = pad + armLen * 0.25
      let dotLayer  = CALayer()
      dotLayer.frame           = CGRect(x: dotX, y: dotY, width: dotSize, height: dotSize)
      dotLayer.backgroundColor = UIColor(red: 1.0, green: 0.05, blue: 0.05, alpha: 1.0).cgColor
      dotLayer.cornerRadius    = dotSize / 2
      addShadow(dotLayer)
      parentLayer.addSublayer(dotLayer)

      // "ne shot" text immediately to the right of the dot
      let neShotX = dotX + dotSize + fontSize * 0.22
      let neShotY = dotY - (layerH - dotSize) / 2   // vertically align with dot center
      let neShotLayer = makeTextLayer("ne shot", x: neShotX, y: neShotY)
      parentLayer.addSublayer(neShotLayer)

      // ── TR: "DAY{n}" ──────────────────────────────────────────────────────

      let dayStr   = "DAY\(currentDay)"
      let dayW     = tw(dayStr)
      let dayX     = S - pad - dayW - 4
      let dayY     = pad + armLen * 0.25
      let dayLayer = makeTextLayer(dayStr, x: dayX, y: dayY)
      parentLayer.addSublayer(dayLayer)

      // ── BL: timestamp (line 1) + "HABIT:{name}" (line 2) ─────────────────

      let habitStr = "HABIT:\(habitName.uppercased())"
      let tsY      = S - pad - lineGap - layerH
      let habitY   = S - pad - layerH

      let tsLayer    = makeTextLayer(timestampStr, x: pad, y: tsY)
      let habitLayer = makeTextLayer(habitStr,     x: pad, y: habitY)
      parentLayer.addSublayer(tsLayer)
      parentLayer.addSublayer(habitLayer)

      // ── BR corner bracket ─────────────────────────────────────────────────
      // ┘  (bottom edge + right edge)

      let brPath = CGMutablePath()
      brPath.move(to:    CGPoint(x: S - pad - armLen, y: S - pad))
      brPath.addLine(to: CGPoint(x: S - pad,          y: S - pad))
      brPath.addLine(to: CGPoint(x: S - pad,          y: S - pad - armLen))

      let brBracket = CAShapeLayer()
      brBracket.path        = brPath
      brBracket.strokeColor = white
      brBracket.fillColor   = UIColor.clear.cgColor
      brBracket.lineWidth   = armWidth
      brBracket.lineCap     = .square
      addShadow(brBracket)
      parentLayer.addSublayer(brBracket)

      // ── Video composition ────────────────────────────────────────────────

      let videoComposition = AVMutableVideoComposition()
      videoComposition.renderSize    = renderSize
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
        postProcessingAsVideoLayer: videoLayer,
        in: parentLayer
      )

      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: trimmedDuration)

      let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideoTrack)
      layerInstruction.setTransform(cropTransform, at: .zero)
      instruction.layerInstructions = [layerInstruction]
      videoComposition.instructions = [instruction]

      // ── Export ───────────────────────────────────────────────────────────

      let outputURL: URL
      if let path = outputPath, let url = URL(string: path) {
        outputURL = url
      } else {
        outputURL = FileManager.default.temporaryDirectory
          .appendingPathComponent(UUID().uuidString + ".mp4")
      }

      try? FileManager.default.removeItem(at: outputURL)

      guard let exportSession = AVAssetExportSession(
        asset: composition,
        presetName: AVAssetExportPresetHighestQuality
      ) else {
        promise.reject("ERR_EXPORT_SESSION", "Could not create export session")
        return
      }

      exportSession.outputURL       = outputURL
      exportSession.outputFileType  = .mp4
      exportSession.videoComposition = videoComposition
      exportSession.shouldOptimizeForNetworkUse = false

      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          promise.resolve(outputURL.absoluteString)
        case .failed:
          promise.reject("ERR_EXPORT_FAILED",
            exportSession.error?.localizedDescription ?? "Export failed")
        case .cancelled:
          promise.reject("ERR_EXPORT_CANCELLED", "Export was cancelled")
        default:
          promise.reject("ERR_EXPORT_UNKNOWN", "Unknown export status: \(exportSession.status.rawValue)")
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
