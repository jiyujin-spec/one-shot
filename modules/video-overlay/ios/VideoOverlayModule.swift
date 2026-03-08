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

    // ── New Industrial Data overlay API ───────────────────────────────────────
    AsyncFunction("processVideo") { (options: [String: Any], promise: Promise) in
      guard
        let inputPath = options["inputPath"] as? String,
        let userId    = options["userId"]    as? String,
        let habitName = options["habitName"] as? String,
        let currentDay = options["currentDay"] as? Int
      else {
        promise.reject("ERR_INVALID_PARAMS", "Missing required parameters: inputPath, userId, habitName, currentDay")
        return
      }

      let totalDays  = options["totalDays"]  as? Int
      let outputPath = options["outputPath"] as? String

      guard let inputURL = URL(string: inputPath) else {
        promise.reject("ERR_INVALID_URI", "Invalid inputPath URI: \(inputPath)")
        return
      }

      let asset = AVURLAsset(url: inputURL)

      guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        promise.reject("ERR_NO_VIDEO_TRACK", "No video track found in asset")
        return
      }

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
      let freezeSeconds: Double = 3.0
      let stillSeconds:  Double = 2.0

      let freezeTime = CMTime(seconds: freezeSeconds, preferredTimescale: 600)

      // Insert 0 – 3 s (or whole video if shorter than 3 s)
      let liveEnd = CMTimeMinimum(freezeTime, totalDuration)
      do {
        try compVideoTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: liveEnd),
          of: videoTrack, at: .zero
        )
      } catch {
        promise.reject("ERR_INSERT", error.localizedDescription)
        return
      }

      // Freeze last frame for 2 s (only when original > 3 s)
      if totalDuration > freezeTime {
        let fps = videoTrack.nominalFrameRate > 0 ? videoTrack.nominalFrameRate : 30.0
        let frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
        let lastFrameStart = CMTimeMaximum(freezeTime - frameDuration, .zero)

        do {
          try compVideoTrack.insertTimeRange(
            CMTimeRange(start: lastFrameStart, duration: frameDuration),
            of: videoTrack, at: liveEnd
          )
        } catch {
          promise.reject("ERR_INSERT_STILL", error.localizedDescription)
          return
        }

        // Stretch that one frame to stillSeconds
        let stillDuration = CMTime(seconds: stillSeconds, preferredTimescale: 600)
        compVideoTrack.scaleTimeRange(
          CMTimeRange(start: liveEnd, duration: frameDuration),
          toDuration: stillDuration
        )
      }

      // Audio: insert only the live portion (0 – 3 s), silence during still
      if let audioTrack = asset.tracks(withMediaType: .audio).first,
         let compAudioTrack = composition.addMutableTrack(
           withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        try? compAudioTrack.insertTimeRange(
          CMTimeRange(start: .zero, duration: liveEnd),
          of: audioTrack, at: .zero
        )
      }

      let compositionDuration = composition.duration

      // ── Render size & orientation ─────────────────────────────────────────

      let naturalSize  = videoTrack.naturalSize
      let transform    = videoTrack.preferredTransform
      let rotated      = naturalSize.applying(transform)
      let renderSize   = CGSize(width: abs(rotated.width), height: abs(rotated.height))

      // ── Layer tree ───────────────────────────────────────────────────────

      let parentLayer = CALayer()
      parentLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.isGeometryFlipped = true   // y = 0 at top

      let videoLayer = CALayer()
      videoLayer.frame = CGRect(origin: .zero, size: renderSize)
      parentLayer.addSublayer(videoLayer)

      // Font
      let fontSize  = renderSize.height * 0.0125
      let fontName  = UIFont(name: "SpaceMono-Regular", size: fontSize) != nil
                      ? "SpaceMono-Regular" : "Menlo-Regular"
      let uiFont    = UIFont(name: fontName, size: fontSize) ?? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
      let textColor = UIColor(red: 200/255, green: 200/255, blue: 200/255, alpha: 1.0).cgColor

      // Safe-zone positions (y with flipped coords: 0 = top)
      let yTop    = renderSize.height * 0.12
      let yBottom = renderSize.height * (1.0 - 0.25) - fontSize
      let xLeft   = renderSize.width  * 0.05
      let xRightEdge = renderSize.width * (1.0 - 0.15)   // right anchor before subtracting textWidth

      // Overlay text strings
      let now = Date()
      let dateFormatter = DateFormatter()
      dateFormatter.dateFormat = "yyyy.MM.dd_HH:mm"
      let timestampStr = dateFormatter.string(from: now)

      let userIdStr = userId

      let habitStr: String = {
        if let total = totalDays {
          if currentDay >= total {
            return "\(habitName) COMPLETED"
          } else {
            return "\(habitName) DAY \(currentDay)/\(total)"
          }
        } else {
          return "\(habitName) DAY \(currentDay)"
        }
      }()

      let logoStr = "ONE SHOT"

      // Measure text widths
      let attrs: [NSAttributedString.Key: Any] = [.font: uiFont]
      func textWidth(_ s: String) -> CGFloat { s.size(withAttributes: attrs).width }

      let tsWidth     = textWidth(timestampStr)
      let uidWidth    = textWidth(userIdStr)
      let habitWidth  = textWidth(habitStr)
      let logoWidth   = textWidth(logoStr)
      let layerH      = fontSize + 8

      // Compute right-aligned x positions
      let xTimestamp = xLeft
      let xUserId    = xRightEdge - uidWidth
      let xHabit     = xLeft
      let xLogo      = xRightEdge - logoWidth

      // ── Build 4 corner text + bracket layers ──────────────────────────────

      struct CornerItem {
        let text: String
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
      }

      let corners: [CornerItem] = [
        CornerItem(text: timestampStr, x: xTimestamp, y: yTop,    width: tsWidth),
        CornerItem(text: userIdStr,    x: xUserId,    y: yTop,    width: uidWidth),
        CornerItem(text: habitStr,     x: xHabit,     y: yBottom, width: habitWidth),
        CornerItem(text: logoStr,      x: xLogo,      y: yBottom, width: logoWidth),
      ]

      // Corner roles: TL, TR, BL, BR
      enum CornerRole { case topLeft, topRight, bottomLeft, bottomRight }
      let roles: [CornerRole] = [.topLeft, .topRight, .bottomLeft, .bottomRight]

      let bracketArm   = renderSize.height * 0.010
      let bracketWidth = max(renderSize.height * 0.0008, 1.0)
      let bracketColor = UIColor(red: 200/255, green: 200/255, blue: 200/255, alpha: 0.6).cgColor
      let bracketPad: CGFloat = fontSize * 0.3   // small gap between text and bracket

      for (idx, item) in corners.enumerated() {
        // ── Text layer ────────────────────────────────────────────────────
        let textLayer = CATextLayer()
        textLayer.string = item.text
        textLayer.fontSize = fontSize
        textLayer.foregroundColor = textColor
        textLayer.alignmentMode = .left
        textLayer.contentsScale = 2.0   // @2x for sharp rendering
        textLayer.isWrapped = false
        textLayer.font = CTFontCreateWithName(fontName as CFString, fontSize, nil)

        // Shadow
        textLayer.shadowColor   = UIColor.black.withAlphaComponent(0.4).cgColor
        textLayer.shadowOpacity = 1.0
        textLayer.shadowRadius  = 4.0
        textLayer.shadowOffset  = CGSize(width: 1, height: 1)

        textLayer.frame = CGRect(x: item.x, y: item.y, width: item.width + 4, height: layerH)
        parentLayer.addSublayer(textLayer)

        // ── Bracket layer ─────────────────────────────────────────────────
        let role = roles[idx]

        // Text block bounding box (with padding)
        let bx = item.x - bracketPad
        let by = item.y - bracketPad
        let bw = item.width + 4 + bracketPad * 2
        let bh = layerH + bracketPad * 2

        let path = CGMutablePath()

        switch role {
        case .topLeft:
          // ┌  top-left corner: horizontal goes right, vertical goes down
          path.move(to:    CGPoint(x: bx + bracketArm, y: by))
          path.addLine(to: CGPoint(x: bx,              y: by))
          path.addLine(to: CGPoint(x: bx,              y: by + bracketArm))

        case .topRight:
          // ┐  top-right corner: horizontal goes left, vertical goes down
          let rx = bx + bw
          path.move(to:    CGPoint(x: rx - bracketArm, y: by))
          path.addLine(to: CGPoint(x: rx,              y: by))
          path.addLine(to: CGPoint(x: rx,              y: by + bracketArm))

        case .bottomLeft:
          // └  bottom-left corner: horizontal goes right, vertical goes up
          let ry = by + bh
          path.move(to:    CGPoint(x: bx + bracketArm, y: ry))
          path.addLine(to: CGPoint(x: bx,              y: ry))
          path.addLine(to: CGPoint(x: bx,              y: ry - bracketArm))

        case .bottomRight:
          // ┘  bottom-right corner: horizontal goes left, vertical goes up
          let rx = bx + bw
          let ry = by + bh
          path.move(to:    CGPoint(x: rx - bracketArm, y: ry))
          path.addLine(to: CGPoint(x: rx,              y: ry))
          path.addLine(to: CGPoint(x: rx,              y: ry - bracketArm))
        }

        let shapeLayer = CAShapeLayer()
        shapeLayer.path        = path
        shapeLayer.strokeColor = bracketColor
        shapeLayer.fillColor   = UIColor.clear.cgColor
        shapeLayer.lineWidth   = bracketWidth
        shapeLayer.lineCap     = .square
        parentLayer.addSublayer(shapeLayer)
      }

      // ── Video composition ────────────────────────────────────────────────

      let videoComposition = AVMutableVideoComposition()
      videoComposition.renderSize   = renderSize
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
        postProcessingAsVideoLayer: videoLayer,
        in: parentLayer
      )

      // Preserve source color profile
      if let formatDesc = videoTrack.formatDescriptions.first {
        let fd = formatDesc as! CMFormatDescription
        if let cp = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries) as? String {
          videoComposition.colorPrimaries = cp
        }
        if let matrix = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_YCbCrMatrix) as? String {
          videoComposition.colorYCbCrMatrix = matrix
        }
        if let tf = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String {
          videoComposition.colorTransferFunction = tf
        }
      }

      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: .zero, duration: compositionDuration)

      let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideoTrack)
      layerInstruction.setTransform(transform, at: .zero)
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

      // Remove existing file at output path if present
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
