package expo.modules.videooverlay

import android.graphics.*
import android.media.*
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class VideoOverlayModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VideoOverlay")

    AsyncFunction("burnTextOverlay") { inputUri: String, overlaysRaw: List<Map<String, Any>>, promise: Promise ->
      val context = appContext.reactContext ?: run {
        promise.reject("ERR_CONTEXT", "No React context", null)
        return@AsyncFunction
      }

      val overlays = overlaysRaw.mapNotNull { map ->
        val text   = map["text"]     as? String           ?: return@mapNotNull null
        val x      = (map["x"]      as? Number)?.toDouble() ?: return@mapNotNull null
        val y      = (map["y"]      as? Number)?.toDouble() ?: return@mapNotNull null
        val size   = (map["fontSize"] as? Number)?.toFloat()  ?: return@mapNotNull null
        val color  = map["color"]   as? String           ?: "#FFFFFF"
        val bold   = map["bold"]    as? Boolean          ?: false
        OverlaySpec(text, x.toFloat(), y.toFloat(), size, color, bold)
      }

      Thread {
        try {
          val srcPath = uriToPath(inputUri)
          val outFile = File(context.cacheDir, "${System.currentTimeMillis()}.mp4")
          transcodeVideo(srcPath, outFile.absolutePath, overlays)
          promise.resolve("file://${outFile.absolutePath}")
        } catch (e: Exception) {
          promise.reject("ERR_OVERLAY", e.message ?: "Unknown error", e)
        }
      }.start()
    }

    AsyncFunction("processVideo") { options: Map<String, Any>, promise: Promise ->
      val context = appContext.reactContext ?: run {
        promise.reject("ERR_CONTEXT", "No React context", null)
        return@AsyncFunction
      }

      val inputPath  = options["inputPath"]  as? String
      val habitName  = (options["habitName"] as? String)?.uppercase(Locale.US)
      val currentDay = (options["currentDay"] as? Number)?.toInt()

      if (inputPath == null || habitName == null || currentDay == null) {
        promise.reject(
          "ERR_INVALID_PARAMS",
          "Missing required parameters: inputPath, habitName, currentDay",
          null
        )
        return@AsyncFunction
      }

      val outputPath         = options["outputPath"] as? String
      val colorFilterEnabled = (options["colorFilterEnabled"] as? Boolean) ?: true

      // Accept captureTimestamp (ms since epoch) as primary; fall back to current time
      val captureDate: Date = run {
        val ms = (options["captureTimestamp"] as? Number)?.toLong()
        if (ms != null) Date(ms) else Date()
      }
      val upperTimestamp = SimpleDateFormat("yyyy.MM.dd_HH:mm", Locale.US).format(captureDate)
      val lowerTimestamp = SimpleDateFormat("yyyy.MM.dd HH:mm", Locale.US).format(captureDate)

      Thread {
        try {
          val srcPath = uriToPath(inputPath)
          val outFile = if (outputPath != null) {
            val ou = Uri.parse(outputPath)
            if (ou.scheme == "file" && ou.path != null) File(ou.path!!)
            else File(context.cacheDir, "${System.currentTimeMillis()}.mp4")
          } else {
            File(context.cacheDir, "${System.currentTimeMillis()}.mp4")
          }

          processOneShotVideo(
            srcPath, outFile.absolutePath,
            upperTimestamp, lowerTimestamp,
            habitName, currentDay, colorFilterEnabled
          )
          promise.resolve("file://${outFile.absolutePath}")
        } catch (e: Exception) {
          promise.reject("ERR_PROCESS", e.message ?: "Unknown error", e)
        }
      }.start()
    }
  }

  // ---------------------------------------------------------------------------

  private data class OverlaySpec(
    val text: String,
    val x: Float,
    val y: Float,
    val fontSize: Float,
    val colorHex: String,
    val bold: Boolean
  )

  private fun uriToPath(uri: String): String {
    val parsed = Uri.parse(uri)
    return if (parsed.scheme == "file") parsed.path!! else uri
  }

  // ---------------------------------------------------------------------------
  // One Shot filter overlay: 9:16 output (1080×1920) with black bars
  //
  //  ┌─────────────────────┐
  //  │   upper black bar   │  420 px  — logo left, DAY right
  //  ├─────────────────────┤
  //  │   video  1080×1080  │  1080 px — center-cropped, colour-graded
  //  ├─────────────────────┤
  //  │   lower black bar   │  420 px  — timestamp + HABIT label
  //  └─────────────────────┘
  // ---------------------------------------------------------------------------
  private fun processOneShotVideo(
    srcPath: String, dstPath: String,
    upperTimestamp: String, lowerTimestamp: String,
    habitName: String, currentDay: Int,
    colorFilterEnabled: Boolean = true
  ) {
    val FPS      = 30
    val FRAME_US = 1_000_000L / FPS
    val TIMEOUT  = 10_000L

    // ── Output canvas dimensions ───────────────────────────────────────────
    val OUT_W = 1080
    val OUT_H = 1920
    val BAR_H = (OUT_H - OUT_W) / 2   // 420

    // ── Source metadata ────────────────────────────────────────────────────
    val retriever = MediaMetadataRetriever()
    retriever.setDataSource(srcPath)
    val srcW     = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt()    ?: 720
    val srcH     = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt()   ?: 1280
    val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    retriever.release()

    val (dispW, dispH) = if (rotation == 90 || rotation == 270) srcH to srcW else srcW to srcH
    val dispWE = if (dispW % 2 == 0) dispW else dispW - 1
    val dispHE = if (dispH % 2 == 0) dispH else dispH - 1

    val sqRaw      = minOf(dispWE, dispHE)
    val squareSize = if (sqRaw % 2 == 0) sqRaw else sqRaw - 1
    val cropX      = (dispWE - squareSize) / 2
    val cropY      = (dispHE - squareSize) / 2

    // ── Load typefaces ─────────────────────────────────────────────────────
    val bebasTypeface: Typeface = try {
      Typeface.createFromAsset(context.assets, "fonts/BebasNeue-Regular.ttf")
    } catch (e: Exception) {
      Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    // ── Overlay paint factories ────────────────────────────────────────────
    fun textPaint(tf: Typeface, size: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize  = size
      color     = Color.WHITE
      typeface  = tf
      setShadowLayer(4f, 1f, 1f, Color.argb(160, 0, 0, 0))
    }
    val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color       = Color.argb(179, 255, 255, 255)  // 70% white (lens-finder feel)
      strokeWidth = 2f
      style       = Paint.Style.STROKE
      strokeCap   = Paint.Cap.SQUARE
    }
    val darkPaint = Paint().apply {
      color = Color.argb(97, 0, 0, 0)   // ~38% black for exposure -0.7 EV
      style = Paint.Style.FILL
    }

    // ── Font sizes (for 1080×1920, 420 px bars) ───────────────────────────
    val logoFS    = 72f
    val dayFS     = (BAR_H * 0.55f)    // ≈ 231
    val habitFS   = 76f
    val lowerTsFS = 52f
    val hPad      = 44f

    val dayStr   = String.format("DAY %03d", currentDay)
    val habitStr = "HABIT: $habitName"

    // ── Draw all overlays onto a 1080×1920 bitmap ──────────────────────────
    fun drawFrame(videoBmp: Bitmap): Bitmap {
      // Scale the 1:1 cropped bitmap to 1080×1080
      val scaledVideo = Bitmap.createScaledBitmap(videoBmp, OUT_W, OUT_W, true)

      // Create the full 1080×1920 output canvas (black background)
      val canvas9x16 = Bitmap.createBitmap(OUT_W, OUT_H, Bitmap.Config.ARGB_8888)
      val canvas     = Canvas(canvas9x16)
      canvas.drawColor(Color.BLACK)

      // Draw video into the centre band
      canvas.drawBitmap(scaledVideo, 0f, BAR_H.toFloat(), null)
      scaledVideo.recycle()

      // Color overlay on video (exposure approximation)
      if (colorFilterEnabled) {
        canvas.drawRect(0f, BAR_H.toFloat(), OUT_W.toFloat(), (BAR_H + OUT_W).toFloat(), darkPaint)
      }

      // ── Corner brackets on video ───────────────────────────────────────
      val bInset = 8f
      val bArm   = 28f
      val vTop   = BAR_H.toFloat()
      val vBot   = (BAR_H + OUT_W).toFloat()

      // TL ┌
      val tlPath = Path().apply {
        moveTo(bInset + bArm, vTop + bInset)
        lineTo(bInset,        vTop + bInset)
        lineTo(bInset,        vTop + bInset + bArm)
      }
      canvas.drawPath(tlPath, bracketPaint)

      // BR ┘
      val brPath = Path().apply {
        moveTo(OUT_W - bInset - bArm, vBot - bInset)
        lineTo(OUT_W - bInset,        vBot - bInset)
        lineTo(OUT_W - bInset,        vBot - bInset - bArm)
      }
      canvas.drawPath(brPath, bracketPaint)

      // ── UPPER BAR ─────────────────────────────────────────────────────
      // "ONE SHOT" in BebasNeue — wide kerning, Y-center aligned with DAY

      // DAY — right-aligned, vertically centred in upper bar
      val dayPaint    = textPaint(bebasTypeface, dayFS)
      val dayW        = dayPaint.measureText(dayStr)
      val dayX        = OUT_W - hPad - dayW
      val dayBaseline = BAR_H / 2f + dayFS * 0.35f
      canvas.drawText(dayStr, dayX, dayBaseline, dayPaint)

      // "ONE SHOT" — Bebas Neue, wide letter spacing (≈0.15em), same Y center as DAY
      val logoPaint = textPaint(bebasTypeface, logoFS).apply { letterSpacing = 0.15f }
      val logoBaseline = BAR_H / 2f + logoFS * 0.35f
      canvas.drawText("ONE SHOT", hPad, logoBaseline, logoPaint)

      // ── LOWER BAR ─────────────────────────────────────────────────────
      // Both lines LEFT-aligned, stacked vertically, centred together in bar.
      // Right side is free for the growth curve graph.
      val barTop    = (BAR_H + OUT_W).toFloat()  // 1500
      val barCenterY = barTop + BAR_H / 2f        // 1710

      // Approx text block height: each Paint baseline is ~0.85× fontSize above top
      val twoLineH  = lowerTsFS + 14f + habitFS   // gap of 14 between lines
      val lowerTsBaseline = barCenterY - twoLineH / 2f + lowerTsFS * 0.85f
      val habitBaseline   = lowerTsBaseline + 14f + habitFS * 0.85f + lowerTsFS * 0.15f

      val lowerTsPaint = textPaint(bebasTypeface, lowerTsFS)
      val habitPaint   = textPaint(bebasTypeface, habitFS)
      canvas.drawText(lowerTimestamp, hPad, lowerTsBaseline, lowerTsPaint)
      canvas.drawText(habitStr,       hPad, habitBaseline,   habitPaint)

      // ── GROWTH CURVE (lower-right) ──────────────────────────────────────
      val gcW   = BAR_H * 0.55f
      val gcH   = BAR_H * 0.48f
      val gcX   = OUT_W - hPad - gcW
      val gcTop2 = barTop + (BAR_H - gcH) / 2f

      val gcML = gcW * 0.12f; val gcMB = gcH * 0.12f
      val gcMR = gcW * 0.06f; val gcMT = gcH * 0.08f
      val gcPlotW = gcW - gcML - gcMR
      val gcPlotH = gcH - gcMT - gcMB

      val gcVals  = (1..currentDay).map { d -> 3.0 * Math.pow(1.01, d.toDouble()) }
      val gcMinV  = gcVals.first()
      val gcMaxV  = gcVals.last()
      val gcRange = maxOf(gcMaxV - gcMinV, 0.001)

      // Axis paint
      val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color       = Color.argb(90, 255, 255, 255)
        strokeWidth = 0.5f
        style       = Paint.Style.STROKE
      }

      // L-shaped axis
      val axisPath = Path().apply {
        moveTo(gcX + gcML, gcTop2 + gcMT)
        lineTo(gcX + gcML, gcTop2 + gcMT + gcPlotH)
        lineTo(gcX + gcML + gcPlotW, gcTop2 + gcMT + gcPlotH)
      }
      canvas.drawPath(axisPath, axisPaint)

      // Curve line
      val curvePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color       = Color.argb(179, 255, 255, 255)  // 70% white
        strokeWidth = 1.0f
        style       = Paint.Style.STROKE
        strokeCap   = Paint.Cap.ROUND
        strokeJoin  = Paint.Join.ROUND
      }
      if (currentDay > 1) {
        val curvePath = Path()
        gcVals.forEachIndexed { i, v ->
          val px = gcX + gcML + (i.toFloat() / (gcVals.size - 1)) * gcPlotW
          val py = gcTop2 + gcMT + gcPlotH - ((v - gcMinV) / gcRange).toFloat() * gcPlotH
          if (i == 0) curvePath.moveTo(px, py) else curvePath.lineTo(px, py)
        }
        canvas.drawPath(curvePath, curvePaint)
      }

      // Latest point — red dot
      val lastDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 51, 51)
        style = Paint.Style.FILL
      }
      val dotX2 = gcX + gcML + (if (currentDay > 1) gcPlotW else gcPlotW / 2f)
      val dotY2 = gcTop2 + gcMT + gcPlotH - ((gcMaxV - gcMinV) / gcRange).toFloat() * gcPlotH
      canvas.drawCircle(dotX2, dotY2, gcW * 0.03f, lastDotPaint)

      return canvas9x16
    }

    // ── Encoder (1080×1920 output) ─────────────────────────────────────────
    val MIME   = "video/avc"
    val encFmt = MediaFormat.createVideoFormat(MIME, OUT_W, OUT_H).apply {
      setInteger(MediaFormat.KEY_BIT_RATE, 8_000_000)
      setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val encoder = MediaCodec.createEncoderByType(MIME)
    encoder.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()

    // ── Decoder (decode at display size, then crop) ───────────────────────
    val extractor = MediaExtractor()
    extractor.setDataSource(srcPath)
    var videoTrack = -1; var audioTrack = -1
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      when {
        mime.startsWith("video/") && videoTrack < 0 -> videoTrack = i
        mime.startsWith("audio/") && audioTrack < 0 -> audioTrack = i
      }
    }
    if (videoTrack < 0) throw IllegalStateException("No video track found")
    extractor.selectTrack(videoTrack)

    val videoFmt    = extractor.getTrackFormat(videoTrack)
    val decoderMime = videoFmt.getString(MediaFormat.KEY_MIME)!!
    val imageReader = android.media.ImageReader.newInstance(
      dispWE, dispHE, android.graphics.ImageFormat.YUV_420_888, 4
    )
    val decoder = MediaCodec.createDecoderByType(decoderMime)
    decoder.configure(videoFmt, imageReader.surface, null, 0)
    decoder.start()

    // ── Muxer ─────────────────────────────────────────────────────────────
    val muxer    = MediaMuxer(dstPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxAudio = -1
    val audioExt: MediaExtractor?
    if (audioTrack >= 0) {
      audioExt = MediaExtractor()
      audioExt.setDataSource(srcPath)
      audioExt.selectTrack(audioTrack)
      muxAudio = muxer.addTrack(audioExt.getTrackFormat(0))
    } else {
      audioExt = null
    }

    // ── Main encode loop ───────────────────────────────────────────────────
    val bufInfo       = MediaCodec.BufferInfo()
    var decInputDone  = false
    var decOutputDone = false
    var encDone       = false
    var muxVideo      = -1
    var muxStarted    = false
    var outputPts     = 0L
    var eosToEncoder  = false
    val audioBuf      = ByteBuffer.allocate(512 * 1024)
    val audioInfo     = MediaCodec.BufferInfo()

    while (!encDone) {

      // 1. Feed decoder
      if (!decInputDone) {
        val inIdx = decoder.dequeueInputBuffer(0)
        if (inIdx >= 0) {
          val buf = decoder.getInputBuffer(inIdx)!!
          val sz  = extractor.readSampleData(buf, 0)
          if (sz < 0) {
            decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            decInputDone = true
          } else {
            decoder.queueInputBuffer(inIdx, 0, sz, extractor.sampleTime, 0)
            extractor.advance()
          }
        }
      }

      // 2. Drain decoder → crop → scale → draw overlays → feed encoder
      if (!decOutputDone) {
        val outIdx = decoder.dequeueOutputBuffer(bufInfo, 0)
        if (outIdx >= 0) {
          val render = bufInfo.size > 0
          decoder.releaseOutputBuffer(outIdx, render)
          if (render) {
            val img = imageReader.acquireLatestImage()
            if (img != null) {
              val fullBmp = yuvToBitmap(img, dispWE, dispHE, rotation)
              img.close()

              // Center-crop to square
              val croppedBmp = Bitmap.createBitmap(fullBmp, cropX, cropY, squareSize, squareSize)
              fullBmp.recycle()

              // Compose 9:16 frame with black bars + overlays
              val frameBmp = drawFrame(croppedBmp)
              croppedBmp.recycle()

              // Feed to encoder
              val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
              if (encInIdx >= 0) {
                val encBuf = encoder.getInputBuffer(encInIdx)!!
                bitmapToYuv420(frameBmp, encBuf, OUT_W, OUT_H)
                encoder.queueInputBuffer(encInIdx, 0, OUT_W * OUT_H * 3 / 2, outputPts, 0)
                outputPts += FRAME_US
              }
              frameBmp.recycle()
            }
          }
          if (bufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            decOutputDone = true
          }
        }
      }

      // 3. Signal EOS to encoder
      if (decOutputDone && !eosToEncoder) {
        val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
        if (encInIdx >= 0) {
          encoder.queueInputBuffer(encInIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
          eosToEncoder = true
        }
      }

      // 4. Drain encoder → muxer
      val encOutIdx = encoder.dequeueOutputBuffer(bufInfo, TIMEOUT)
      when {
        encOutIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          muxVideo = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          muxStarted = true
          if (audioExt != null && muxAudio >= 0) {
            while (true) {
              val sz = audioExt.readSampleData(audioBuf, 0)
              if (sz < 0) break
              audioInfo.set(0, sz, audioExt.sampleTime, audioExt.sampleFlags)
              muxer.writeSampleData(muxAudio, audioBuf, audioInfo)
              audioExt.advance()
            }
          }
        }
        encOutIdx >= 0 -> {
          val encBuf = encoder.getOutputBuffer(encOutIdx)!!
          if (bufInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && muxStarted && muxVideo >= 0) {
            muxer.writeSampleData(muxVideo, encBuf, bufInfo)
          }
          encoder.releaseOutputBuffer(encOutIdx, false)
          if (bufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) encDone = true
        }
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    decoder.stop();  decoder.release()
    encoder.stop();  encoder.release()
    imageReader.close()
    extractor.release()
    audioExt?.release()
    if (muxStarted) muxer.stop()
    muxer.release()
  }

  // ---------------------------------------------------------------------------
  // Legacy burnTextOverlay pipeline (unchanged)
  // ---------------------------------------------------------------------------
  private fun transcodeVideo(srcPath: String, dstPath: String, overlays: List<OverlaySpec>) {
    val retriever = MediaMetadataRetriever().also { it.setDataSource(srcPath) }
    val srcW    = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt()  ?: 720
    val srcH    = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt() ?: 1280
    val rotation= retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    retriever.release()

    val (encW, encH) = if (rotation == 90 || rotation == 270) srcH to srcW else srcW to srcH
    val finalW = if (encW % 2 == 0) encW else encW - 1
    val finalH = if (encH % 2 == 0) encH else encH - 1

    val paints = overlays.map { spec ->
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize  = spec.fontSize
        color     = parseHex(spec.colorHex)
        typeface  = if (spec.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        setShadowLayer(3f, 1f, 1f, Color.BLACK)
      }
    }

    val MIME    = "video/avc"
    val FPS     = 30
    val encFmt  = MediaFormat.createVideoFormat(MIME, finalW, finalH).apply {
      setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
      setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val encoder = MediaCodec.createEncoderByType(MIME)
    encoder.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()

    val extractor = MediaExtractor().also { it.setDataSource(srcPath) }
    var videoTrack = -1; var audioTrack = -1
    for (i in 0 until extractor.trackCount) {
      val m = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (m.startsWith("video/") && videoTrack < 0) videoTrack = i
      else if (m.startsWith("audio/") && audioTrack < 0) audioTrack = i
    }
    if (videoTrack < 0) throw IllegalStateException("No video track")
    extractor.selectTrack(videoTrack)

    val videoFmt    = extractor.getTrackFormat(videoTrack)
    val decoderMime = videoFmt.getString(MediaFormat.KEY_MIME)!!
    val imageReader = android.media.ImageReader.newInstance(finalW, finalH, android.graphics.ImageFormat.YUV_420_888, 4)
    val decoder = MediaCodec.createDecoderByType(decoderMime)
    decoder.configure(videoFmt, imageReader.surface, null, 0)
    decoder.start()

    val muxer = MediaMuxer(dstPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxAudio = -1
    val audioExt: MediaExtractor?
    if (audioTrack >= 0) {
      audioExt = MediaExtractor().also {
        it.setDataSource(srcPath)
        it.selectTrack(audioTrack)
      }
      muxAudio = muxer.addTrack(audioExt.getTrackFormat(0))
    } else {
      audioExt = null
    }

    val TIMEOUT = 10_000L
    val info     = MediaCodec.BufferInfo()
    var decDone  = false
    var encDone  = false
    var muxVideo = -1
    var muxed    = false
    val audioBuf = ByteBuffer.allocate(512 * 1024)
    val audioInfo= MediaCodec.BufferInfo()

    while (!encDone) {
      if (!decDone) {
        val idx = decoder.dequeueInputBuffer(TIMEOUT)
        if (idx >= 0) {
          val buf = decoder.getInputBuffer(idx)!!
          val sz  = extractor.readSampleData(buf, 0)
          if (sz < 0) {
            decoder.queueInputBuffer(idx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            decDone = true
          } else {
            decoder.queueInputBuffer(idx, 0, sz, extractor.sampleTime, 0)
            extractor.advance()
          }
        }
      }

      val decOut = decoder.dequeueOutputBuffer(info, TIMEOUT)
      if (decOut >= 0) {
        val hasFrame = info.size > 0
        decoder.releaseOutputBuffer(decOut, hasFrame)
        if (hasFrame) {
          val image = imageReader.acquireLatestImage()
          if (image != null) {
            val bmp = yuvToBitmap(image, finalW, finalH, rotation)
            image.close()
            val canvas = Canvas(bmp)
            for ((i, spec) in overlays.withIndex()) {
              canvas.drawText(spec.text, spec.x * finalW, spec.y * finalH, paints[i])
            }
            val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
            if (encInIdx >= 0) {
              val encBuf = encoder.getInputBuffer(encInIdx)!!
              bitmapToYuv420(bmp, encBuf, finalW, finalH)
              encoder.queueInputBuffer(encInIdx, 0, finalW * finalH * 3 / 2, info.presentationTimeUs, 0)
            }
            bmp.recycle()
          }
        }
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
          val eoIdx = encoder.dequeueInputBuffer(TIMEOUT)
          if (eoIdx >= 0) {
            encoder.queueInputBuffer(eoIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
          }
        }
      }

      val encOut = encoder.dequeueOutputBuffer(info, TIMEOUT)
      when {
        encOut == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          muxVideo = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          muxed = true
          if (audioExt != null && muxAudio >= 0) {
            while (true) {
              val sz = audioExt.readSampleData(audioBuf, 0)
              if (sz < 0) break
              audioInfo.set(0, sz, audioExt.sampleTime, audioExt.sampleFlags)
              muxer.writeSampleData(muxAudio, audioBuf, audioInfo)
              audioExt.advance()
            }
          }
        }
        encOut >= 0 -> {
          val buf = encoder.getOutputBuffer(encOut)!!
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && muxed && muxVideo >= 0) {
            muxer.writeSampleData(muxVideo, buf, info)
          }
          encoder.releaseOutputBuffer(encOut, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) encDone = true
        }
      }
    }

    decoder.stop();  decoder.release()
    encoder.stop();  encoder.release()
    imageReader.close()
    extractor.release()
    audioExt?.release()
    if (muxed) muxer.stop()
    muxer.release()
  }

  // ---------------------------------------------------------------------------
  // YUV_420_888 Image → ARGB Bitmap (handles rotation)
  // ---------------------------------------------------------------------------
  private fun yuvToBitmap(image: android.media.Image, w: Int, h: Int, rotation: Int): Bitmap {
    val yPlane  = image.planes[0]
    val uPlane  = image.planes[1]
    val vPlane  = image.planes[2]
    val yBuf    = yPlane.buffer
    val uBuf    = uPlane.buffer
    val vBuf    = vPlane.buffer
    val yStride = yPlane.rowStride
    val uvStride= uPlane.rowStride
    val uvPixel = uPlane.pixelStride

    val argb = IntArray(w * h)
    for (row in 0 until h) {
      for (col in 0 until w) {
        val yIdx = row * yStride + col
        val uvRow = row / 2; val uvCol = col / 2
        val uvIdx = uvRow * uvStride + uvCol * uvPixel
        val Y = (yBuf.get(yIdx).toInt() and 0xFF)
        val U = (uBuf.get(uvIdx).toInt() and 0xFF) - 128
        val V = (vBuf.get(uvIdx).toInt() and 0xFF) - 128
        val r = clamp(Y + (1.370705f * V).toInt())
        val g = clamp(Y - (0.337633f * U).toInt() - (0.698001f * V).toInt())
        val b = clamp(Y + (1.732446f * U).toInt())
        argb[row * w + col] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
      }
    }
    val bmp = Bitmap.createBitmap(argb, w, h, Bitmap.Config.ARGB_8888)
    if (rotation == 0) return bmp
    val matrix = Matrix().also { it.postRotate(rotation.toFloat()) }
    val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
    bmp.recycle()
    return rotated
  }

  // ---------------------------------------------------------------------------
  // ARGB Bitmap → YUV 420 planar ByteBuffer for encoder
  // ---------------------------------------------------------------------------
  private fun bitmapToYuv420(bmp: Bitmap, buf: ByteBuffer, w: Int, h: Int) {
    buf.clear()
    val argb = IntArray(w * h)
    bmp.getPixels(argb, 0, w, 0, 0, w, h)
    for (row in 0 until h) for (col in 0 until w) {
      val px = argb[row * w + col]
      val r  = (px shr 16) and 0xFF; val g = (px shr 8) and 0xFF; val b = px and 0xFF
      buf.put(clamp(((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte())
    }
    for (row in 0 until h / 2) for (col in 0 until w / 2) {
      val px = argb[(row * 2) * w + (col * 2)]
      val r  = (px shr 16) and 0xFF; val g = (px shr 8) and 0xFF; val b = px and 0xFF
      buf.put(clamp(((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).toByte())
    }
    for (row in 0 until h / 2) for (col in 0 until w / 2) {
      val px = argb[(row * 2) * w + (col * 2)]
      val r  = (px shr 16) and 0xFF; val g = (px shr 8) and 0xFF; val b = px and 0xFF
      buf.put(clamp(((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).toByte())
    }
  }

  private fun clamp(v: Int): Int = v.coerceIn(0, 255)
  private fun clamp(v: Float): Int = v.toInt().coerceIn(0, 255)

  private fun parseHex(hex: String): Int {
    val s = hex.trimStart('#')
    return try {
      when (s.length) {
        6 -> Color.parseColor("#FF$s")
        8 -> Color.parseColor("#$s")
        else -> Color.WHITE
      }
    } catch (_: Exception) { Color.WHITE }
  }
}
