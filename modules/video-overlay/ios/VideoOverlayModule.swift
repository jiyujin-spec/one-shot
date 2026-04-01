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

      asset.loadValuesAsynchronously(forKeys: ["tracks", "duration"]) {
        var error: NSError? = nil
        guard asset.statusOfValue(forKey: "tracks", error: &error) == .loaded else {
          promise.reject("ERR_ASSET_LOAD", error?.localizedDescription ?? "Asset failed to load tracks")
          return
        }
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
        DispatchQueue.main.async {
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
          textLayer.contentsScale = 2.0
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
        }  // DispatchQueue.main.async
      }
    }

    // ── One Shot filter overlay API ────────────────────────────────────────────
    //
    // Output: 1080 × 1920 (9:16 TikTok standard)
    //   ┌──────────────────┐
    //   │  upper black bar │  420 px  — logo left, DAY right
    //   ├──────────────────┤
    //   │   video  1:1     │  1080 px — center-cropped, color-graded
    //   ├──────────────────┤
    //   │  lower black bar │  420 px  — timestamp + HABIT label
    //   └──────────────────┘
    //
    AsyncFunction("processVideo") { (options: [String: Any], promise: Promise) in
      guard
        let inputPath = options["inputPath"] as? String,
        let habitName = options["habitName"] as? String,
        let currentDay = options["currentDay"] as? Int
      else {
        promise.reject("ERR_INVALID_PARAMS", "Missing required parameters: inputPath, habitName, currentDay")
        return
      }

      let outputPath         = options["outputPath"] as? String
      let colorFilterEnabled = (options["colorFilterEnabled"] as? Bool) ?? true

      // ── Timestamp: accept ms-since-epoch (captureTimestamp) or legacy string ─
      let captureDate: Date
      if let ms = options["captureTimestamp"] as? Double {
        captureDate = Date(timeIntervalSince1970: ms / 1000.0)
      } else {
        captureDate = Date()
      }

      let lowerDf = DateFormatter()
      lowerDf.locale = Locale(identifier: "en_US_POSIX")
      lowerDf.dateFormat = "yyyy.MM.dd HH:mm"
      let lowerTimestamp = lowerDf.string(from: captureDate)

      guard let inputURL = URL(string: inputPath) else {
        promise.reject("ERR_INVALID_URI", "Invalid inputPath URI: \(inputPath)")
        return
      }

      let asset = AVURLAsset(url: inputURL)

      asset.loadValuesAsynchronously(forKeys: ["tracks", "duration"]) {
        var error: NSError? = nil
        guard asset.statusOfValue(forKey: "tracks", error: &error) == .loaded else {
          promise.reject("ERR_ASSET_LOAD", error?.localizedDescription ?? "Asset failed to load tracks")
          return
        }

        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
          promise.reject("ERR_NO_VIDEO_TRACK", "No video track found in asset")
          return
        }

        // ── Orientation & 1:1 center-crop (no scale) ─────────────────────────
        let naturalSize = videoTrack.naturalSize
        let transform   = videoTrack.preferredTransform

        let dispSizeRaw = naturalSize.applying(transform)
        let dispW = abs(dispSizeRaw.width)
        let dispH = abs(dispSizeRaw.height)

        // ── Output canvas dimensions ──────────────────────────────────────────
        let OUT_W: CGFloat = 1080.0
        let OUT_H: CGFloat = 1920.0
        let BAR_H: CGFloat = (OUT_H - OUT_W) / 2.0  // 420.0

        // Center-crop offset: extract OUT_W × OUT_W from center of display frame (no scale)
        let cropOffsetX = (OUT_W - dispW) / 2.0
        let cropOffsetY = (OUT_W - dispH) / 2.0

        // Full render canvas
        let renderSize = CGSize(width: OUT_W, height: OUT_H)

        // Layer instruction transform: rotate → center-crop to 1080×1080 → shift down by BAR_H
        let cropTransform = transform
          .concatenating(CGAffineTransform(translationX: cropOffsetX, y: cropOffsetY))
          .concatenating(CGAffineTransform(translationX: 0, y: BAR_H))

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

        // iOS 18: UIFont, NSAttributedString, UIColor.cgColor must be on main thread.
        DispatchQueue.main.async {

        // ── Layer tree ────────────────────────────────────────────────────────
        // isGeometryFlipped = true → y=0 is TOP (UIKit coordinate space)
        let parentLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: renderSize)
        parentLayer.isGeometryFlipped = true
        parentLayer.backgroundColor = UIColor.black.cgColor

        // Video layer must match renderSize so AVFoundation composites without scaling.
        // A mask clips the visible area to the center 1:1 band (translation-only crop, no stretch).
        let videoLayer = CALayer()
        videoLayer.frame = CGRect(origin: .zero, size: renderSize)
        let videoClipMask = CALayer()
        videoClipMask.frame = CGRect(x: 0, y: BAR_H, width: OUT_W, height: OUT_W)
        videoClipMask.backgroundColor = UIColor.white.cgColor
        videoLayer.mask = videoClipMask
        parentLayer.addSublayer(videoLayer)

        // ── Color overlay on video (approximates exposure -0.7 EV) ───────────
        // -0.7 EV ≈ output = original × 2^(-0.7) ≈ 0.615
        // Overlay black at ~0.38 alpha achieves ~62% of original brightness.
        if colorFilterEnabled {
          let colorOverlay = CALayer()
          colorOverlay.frame           = CGRect(x: 0, y: BAR_H, width: OUT_W, height: OUT_W)
          colorOverlay.backgroundColor = UIColor(white: 0, alpha: 0.38).cgColor
          parentLayer.addSublayer(colorOverlay)
        }

        // ── Corner brackets: 4 corners, heavy arms, sharp edges ──────────────
        let bInset:  CGFloat = 24.0   // 3× original inset (8 → 24)
        let bArm:    CGFloat = 144.0  // 4× original arm length (36 → 144)
        let bStroke: CGFloat = 9.0    // 3× original stroke (3 → 9)
        let vX0 = CGFloat(0)
        let vY0 = BAR_H
        let vX1 = OUT_W
        let vY1 = BAR_H + OUT_W

        func makeBracket(_ path: CGMutablePath) -> CAShapeLayer {
          let s = CAShapeLayer()
          s.path        = path
          s.strokeColor = UIColor.white.cgColor
          s.fillColor   = UIColor.clear.cgColor
          s.lineWidth   = bStroke
          s.lineCap     = .butt
          s.lineJoin    = .miter
          return s
        }

        // TL ┌
        let tlPath = CGMutablePath()
        tlPath.move(to:    CGPoint(x: vX0 + bInset + bArm, y: vY0 + bInset))
        tlPath.addLine(to: CGPoint(x: vX0 + bInset,         y: vY0 + bInset))
        tlPath.addLine(to: CGPoint(x: vX0 + bInset,         y: vY0 + bInset + bArm))
        parentLayer.addSublayer(makeBracket(tlPath))

        // TR ┐
        let trPath = CGMutablePath()
        trPath.move(to:    CGPoint(x: vX1 - bInset - bArm, y: vY0 + bInset))
        trPath.addLine(to: CGPoint(x: vX1 - bInset,         y: vY0 + bInset))
        trPath.addLine(to: CGPoint(x: vX1 - bInset,         y: vY0 + bInset + bArm))
        parentLayer.addSublayer(makeBracket(trPath))

        // BL └
        let blPath = CGMutablePath()
        blPath.move(to:    CGPoint(x: vX0 + bInset + bArm, y: vY1 - bInset))
        blPath.addLine(to: CGPoint(x: vX0 + bInset,         y: vY1 - bInset))
        blPath.addLine(to: CGPoint(x: vX0 + bInset,         y: vY1 - bInset - bArm))
        parentLayer.addSublayer(makeBracket(blPath))

        // BR ┘
        let brPath = CGMutablePath()
        brPath.move(to:    CGPoint(x: vX1 - bInset - bArm, y: vY1 - bInset))
        brPath.addLine(to: CGPoint(x: vX1 - bInset,         y: vY1 - bInset))
        brPath.addLine(to: CGPoint(x: vX1 - bInset,         y: vY1 - bInset - bArm))
        parentLayer.addSublayer(makeBracket(brPath))

        // ── Fonts ──────────────────────────────────────────────────────────────
        let bebas = "BebasNeue-Regular"

        // Font sizes (tuned for 1080×1920 canvas, 420px bars)
        let logoFS:    CGFloat = 72    // "ONE SHOT" label
        let dayFS:     CGFloat = floor(BAR_H * 0.55)  // ≈ 231 — the largest element
        let habitFS:   CGFloat = 88    // "HABIT:" label
        let lowerTsFS: CGFloat = 60    // lower bar timestamp

        let white = UIColor.white.cgColor
        let hPad:  CGFloat = 44   // horizontal padding from canvas edge

        // Helper: UIFont (for width measurement only)
        func uiFont(_ name: String, _ size: CGFloat) -> UIFont {
          UIFont(name: name, size: size) ?? UIFont.boldSystemFont(ofSize: size)
        }
        func textWidth(_ s: String, _ font: UIFont) -> CGFloat {
          s.size(withAttributes: [.font: font]).width
        }

        // Helper: build a CATextLayer
        func makeLayer(_ text: String, fontName: String, fontSize: CGFloat,
                       x: CGFloat, y: CGFloat, width: CGFloat, align: CATextLayerAlignmentMode = .left) -> CATextLayer {
          let l = CATextLayer()
          l.string          = text
          l.fontSize        = fontSize
          l.foregroundColor = white
          l.alignmentMode   = align
          l.contentsScale   = 2.0
          l.isWrapped       = false
          l.font            = CTFontCreateWithName(fontName as CFString, fontSize, nil)
          l.frame           = CGRect(x: x, y: y, width: width, height: fontSize + 10)
          return l
        }

        // ── UPPER BAR ─────────────────────────────────────────────────────────
        // Left: "ONE SHOT" logo (Bebas Neue, wide kerning)
        // Right: "DAY 015" in Bebas Neue — Y-center identical to logo

        // DAY — vertically centred in upper bar
        let dayStr    = String(format: "DAY %03d", currentDay)
        let dayLayerH = dayFS + 10
        let dayY      = (BAR_H - dayLayerH) / 2   // center = BAR_H/2
        parentLayer.addSublayer(makeLayer(dayStr, fontName: bebas, fontSize: dayFS,
                                          x: hPad, y: dayY, width: OUT_W - 2 * hPad, align: .right))

        // "ONE SHOT" logo — Y-center aligned with DAY (both at BAR_H/2)
        let logoLayerH: CGFloat = logoFS + 10
        let logoTopY: CGFloat   = BAR_H / 2 - logoLayerH / 2

        let logoKern: CGFloat = 10.0
        let oneShotFont = uiFont(bebas, logoFS)
        let oneShotBaseW = textWidth("ONE SHOT", oneShotFont)
        let oneShotW = oneShotBaseW + CGFloat("ONE SHOT".count - 1) * logoKern + 16

        let oneShotAttr = NSAttributedString(string: "ONE SHOT", attributes: [
          .font: CTFontCreateWithName(bebas as CFString, logoFS, nil) as Any,
          .foregroundColor: UIColor.white,
          .kern: logoKern
        ])
        let oneShotLayer = CATextLayer()
        oneShotLayer.string        = oneShotAttr
        oneShotLayer.contentsScale = 2.0
        oneShotLayer.isWrapped     = false
        oneShotLayer.frame         = CGRect(x: hPad, y: logoTopY, width: oneShotW, height: logoLayerH)
        parentLayer.addSublayer(oneShotLayer)

        // ── LOWER BAR ─────────────────────────────────────────────────────────
        // Left: timestamp, Right: HABIT label — both Y-centred in lower bar

        let barTop: CGFloat    = BAR_H + OUT_W          // 1500
        let barCenterY: CGFloat = barTop + BAR_H / 2    // 1710

        let lowerTsFont = uiFont(bebas, lowerTsFS)
        let lowerTsW    = textWidth(lowerTimestamp, lowerTsFont) + 12
        let lowerTsY    = barCenterY - (lowerTsFS + 10) / 2

        let habitStr  = "HABIT: \(habitName.uppercased())"
        let habitFont = uiFont(bebas, habitFS)
        let habitW    = textWidth(habitStr, habitFont) + 16
        let habitY    = barCenterY - (habitFS + 10) / 2

        parentLayer.addSublayer(makeLayer(lowerTimestamp, fontName: bebas, fontSize: lowerTsFS,
                                          x: hPad, y: lowerTsY, width: lowerTsW))
        parentLayer.addSublayer(makeLayer(habitStr, fontName: bebas, fontSize: habitFS,
                                          x: hPad, y: habitY, width: OUT_W - 2 * hPad, align: .right))

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

        exportSession.outputURL                   = outputURL
        exportSession.outputFileType              = .mp4
        exportSession.videoComposition            = videoComposition
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
        }  // DispatchQueue.main.async
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
