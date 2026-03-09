import ExpoModulesCore
import AVFoundation
import UIKit
import CoreGraphics
import CoreText

public class VideoOverlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoOverlay")

    // ── Legacy API ─────────────────────────────────────────────────────────────
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

    // ── One Shot filter overlay API ────────────────────────────────────────────
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

      // ── Orientation & exact 1:1 center-crop ──────────────────────────────────
      //
      // naturalSize  : pixel dimensions as stored (e.g. 1920×1080 for landscape)
      // preferredTransform: rotation + translation that maps natural → display
      //
      // To get the display width/height we apply the transform to the size
      // (CGSize.applying uses only the 2×2 rotation part, ignoring translation).
      // abs() is needed because rotations can produce negative extents.

      let naturalSize = videoTrack.naturalSize        // stored w × h
      let transform   = videoTrack.preferredTransform  // rotation applied by player

      let dispSizeRaw = naturalSize.applying(transform)
      let dispW = abs(dispSizeRaw.width)   // display width  (post-rotation)
      let dispH = abs(dispSizeRaw.height)  // display height (post-rotation)

      // Ensure even pixel dimensions for H.264 encoder
      let dispWE = dispW - (dispW.truncatingRemainder(dividingBy: 2))
      let dispHE = dispH - (dispH.truncatingRemainder(dividingBy: 2))

      // Strict 1:1 square: shorter display side, even-aligned
      let squareSizeRaw = min(dispWE, dispHE)
      let squareSize    = squareSizeRaw - squareSizeRaw.truncatingRemainder(dividingBy: 2)
      let renderSize    = CGSize(width: squareSize, height: squareSize)

      // Center-crop offset in display space (can be negative = shift toward origin)
      // We want to cut (dispW - squareSize)/2 from each horizontal side, etc.
      let cropOffsetX = (squareSize - dispWE) / 2.0  // negative when dispWE > squareSize
      let cropOffsetY = (squareSize - dispHE) / 2.0  // negative when dispHE > squareSize

      // The layer instruction transform maps natural-coordinate frames into the
      // render canvas.  We first apply the preferred rotation (transform), then
      // shift so the crop window lands at the render origin.
      let cropTransform = transform.concatenating(
        CGAffineTransform(translationX: cropOffsetX, y: cropOffsetY)
      )

      // ── Composition ────────────────────────────────────────────────────────
      let composition = AVMutableComposition()

      guard let compVideoTrack = composition.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
      ) else {
        promise.reject("ERR_COMPOSITION", "Could not create composition video track")
        return
      }

      let totalDuration = asset.duration

      // Trim first 0.3 s (dark frames immediately after shutter press)
      let trimOffset   = CMTime(seconds: 0.3, preferredTimescale: 600)
      let trimStart    = trimOffset < totalDuration ? trimOffset : .zero
      let trimDuration = CMTimeSubtract(totalDuration, trimStart)

      do {
        try compVideoTrack.insertTimeRange(
          CMTimeRange(start: trimStart, duration: trimDuration),
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
          CMTimeRange(start: trimStart, duration: trimDuration),
          of: audioTrack, at: .zero
        )
      }

      // ── Layer tree ──────────────────────────────────────────────────────────
      //
      // isGeometryFlipped = true so that y=0 is at the TOP of the render canvas,
      // matching UIKit coordinates for our layout math below.

      let parentLayer = CALayer()
      parentLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.isGeometryFlipped = true

      let videoLayer = CALayer()
      videoLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.addSublayer(videoLayer)

      // ── Dark / cold-tone filter ─────────────────────────────────────────────
      let darkOverlay = CALayer()
      darkOverlay.frame = CGRect(origin: .zero, size: renderSize)
      darkOverlay.backgroundColor = UIColor(
        red: 0, green: 0.04, blue: 0.12, alpha: 0.38
      ).cgColor
      parentLayer.addSublayer(darkOverlay)

      // ── Layout constants ────────────────────────────────────────────────────
      let S        = squareSize
      let pad      = S * 0.045
      let fontSize = S * 0.038
      let lineGap  = fontSize * 1.35
      let layerH   = fontSize + 6

      let fontName: String = UIFont.boldSystemFont(ofSize: fontSize).fontName
      let uiFont   = UIFont.boldSystemFont(ofSize: fontSize)
      let attrs: [NSAttributedString.Key: Any] = [.font: uiFont]
      func tw(_ s: String) -> CGFloat { s.size(withAttributes: attrs).width }

      let white = UIColor.white.cgColor

      func addShadow(_ layer: CALayer) {
        layer.shadowColor   = UIColor.black.withAlphaComponent(0.55).cgColor
        layer.shadowOpacity = 1.0
        layer.shadowRadius  = 3.0
        layer.shadowOffset  = CGSize(width: 1, height: 1)
      }

      let armLen   = S * 0.07
      let armWidth = max(S * 0.003, 1.5)

      func makeTextLayer(_ text: String, x: CGFloat, y: CGFloat) -> CATextLayer {
        let l = CATextLayer()
        l.string          = text
        l.fontSize        = fontSize
        l.foregroundColor = white
        l.alignmentMode   = .left
        l.contentsScale   = 2.0
        l.isWrapped       = false
        l.font            = CTFontCreateWithName(fontName as CFString, fontSize, nil)
        addShadow(l)
        l.frame = CGRect(x: x, y: y, width: tw(text) + 8, height: layerH)
        return l
      }

      // ── TL corner bracket ┌ ────────────────────────────────────────────────
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

      // ── Red dot (●) — the "O" in "One shot" ───────────────────────────────
      let dotSize  = fontSize * 0.95
      let dotX     = pad + armLen * 0.25
      let dotY     = pad + armLen * 0.25
      let dotLayer = CALayer()
      dotLayer.frame           = CGRect(x: dotX, y: dotY, width: dotSize, height: dotSize)
      dotLayer.backgroundColor = UIColor(red: 1.0, green: 0.05, blue: 0.05, alpha: 1.0).cgColor
      dotLayer.cornerRadius    = dotSize / 2
      addShadow(dotLayer)
      parentLayer.addSublayer(dotLayer)

      // "ne shot" — vertically centred on the dot
      let neShotX = dotX + dotSize + fontSize * 0.22
      let neShotY = dotY - (layerH - dotSize) / 2
      parentLayer.addSublayer(makeTextLayer("ne shot", x: neShotX, y: neShotY))

      // ── TR: "DAY{n}" ───────────────────────────────────────────────────────
      let dayStr = "DAY\(currentDay)"
      let dayX   = S - pad - tw(dayStr) - 4
      let dayY   = pad + armLen * 0.25
      parentLayer.addSublayer(makeTextLayer(dayStr, x: dayX, y: dayY))

      // ── BL: timestamp + "HABIT:{name}" ────────────────────────────────────
      let habitStr = "HABIT:\(habitName.uppercased())"
      parentLayer.addSublayer(makeTextLayer(timestampStr, x: pad, y: S - pad - lineGap - layerH))
      parentLayer.addSublayer(makeTextLayer(habitStr,     x: pad, y: S - pad - layerH))

      // ── BR corner bracket ┘ ────────────────────────────────────────────────
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

      // ── Video composition ──────────────────────────────────────────────────
      let videoComposition = AVMutableVideoComposition()
      videoComposition.renderSize    = renderSize
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
        postProcessingAsVideoLayer: videoLayer,
        in: parentLayer
      )

      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: trimDuration)

      let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideoTrack)
      layerInstruction.setTransform(cropTransform, at: .zero)
      instruction.layerInstructions = [layerInstruction]
      videoComposition.instructions = [instruction]

      // ── Export ─────────────────────────────────────────────────────────────
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

      exportSession.outputURL                  = outputURL
      exportSession.outputFileType             = .mp4
      exportSession.videoComposition           = videoComposition
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
          promise.reject("ERR_EXPORT_UNKNOWN",
            "Unknown export status: \(exportSession.status.rawValue)")
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
