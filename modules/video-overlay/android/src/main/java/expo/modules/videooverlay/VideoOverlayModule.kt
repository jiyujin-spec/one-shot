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

      val outputPath   = options["outputPath"] as? String
      val captureTime  = options["captureTime"] as? String

      // Use provided captureTime or format current time
      val timestampStr = if (!captureTime.isNullOrEmpty()) {
        captureTime
      } else {
        SimpleDateFormat("yyyy.MM/dd HH:mm", Locale.US).format(Date())
      }

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

          processOneShotVideo(srcPath, outFile.absolutePath, timestampStr, habitName, currentDay)
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
  // One Shot filter overlay: square crop + cold/dark tone + new design
  // ---------------------------------------------------------------------------
  private fun processOneShotVideo(
    srcPath: String, dstPath: String,
    timestampStr: String, habitName: String, currentDay: Int
  ) {
    val FPS      = 30
    val FRAME_US = 1_000_000L / FPS
    val TIMEOUT  = 10_000L

    // ── Source metadata ────────────────────────────────────────────────────
    val retriever = MediaMetadataRetriever()
    retriever.setDataSource(srcPath)
    val srcW     = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt()    ?: 720
    val srcH     = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt()   ?: 1280
    val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    retriever.release()

    // Display dimensions (after rotation)
    val (dispW, dispH) = if (rotation == 90 || rotation == 270) srcH to srcW else srcW to srcH
    val dispWE = if (dispW % 2 == 0) dispW else dispW - 1
    val dispHE = if (dispH % 2 == 0) dispH else dispH - 1

    // Square size (center-crop)
    val sqRaw    = minOf(dispWE, dispHE)
    val squareSize = if (sqRaw % 2 == 0) sqRaw else sqRaw - 1

    val cropX    = (dispWE - squareSize) / 2
    val cropY    = (dispHE - squareSize) / 2

    val S = squareSize.toFloat()

    // ── Overlay parameters ─────────────────────────────────────────────────
    val pad      = S * 0.045f
    val fontSize = S * 0.038f
    val lineGap  = fontSize * 1.35f

    val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = fontSize
      color    = Color.WHITE
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      setShadowLayer(3f, 1f, 1f, Color.argb(140, 0, 0, 0))
    }

    val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color       = Color.WHITE
      strokeWidth = maxOf(S * 0.003f, 1.5f)
      style       = Paint.Style.STROKE
      strokeCap   = Paint.Cap.SQUARE
      setShadowLayer(3f, 1f, 1f, Color.argb(140, 0, 0, 0))
    }

    val darkPaint = Paint().apply {
      color = Color.argb(97, 0, 10, 31)  // ~38% opacity dark blue
      style = Paint.Style.FILL
    }

    val dotSize  = fontSize * 0.95f
    val armLen   = S * 0.07f

    val dayStr   = "DAY$currentDay"
    val habitStr = "HABIT:$habitName"

    fun drawOverlays(bmp: Bitmap) {
      val canvas = Canvas(bmp)

      // 1. Dark/cold overlay
      canvas.drawRect(0f, 0f, S, S, darkPaint)

      // 2. TL corner bracket ┌
      val tlPath = Path().apply {
        moveTo(pad + armLen, pad)
        lineTo(pad, pad)
        lineTo(pad, pad + armLen)
      }
      canvas.drawPath(tlPath, bracketPaint)

      // 3. Red dot (acts as the "O" in "One shot")
      val dotX = pad + armLen * 0.25f
      val dotY = pad + armLen * 0.25f
      val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 13, 13)
        style = Paint.Style.FILL
        setShadowLayer(3f, 1f, 1f, Color.argb(140, 0, 0, 0))
      }
      canvas.drawCircle(dotX + dotSize / 2f, dotY + dotSize / 2f, dotSize / 2f, dotPaint)

      // 4. "ne shot" text (to the right of the dot)
      val neShotX = dotX + dotSize + fontSize * 0.22f
      val neShotBaseline = dotY + dotSize * 0.5f + fontSize * 0.35f
      canvas.drawText("ne shot", neShotX, neShotBaseline, textPaint)

      // 5. TR: "DAYn"
      val dayW = textPaint.measureText(dayStr)
      val dayX = S - pad - dayW
      val dayY = pad + armLen * 0.25f + dotSize * 0.5f + fontSize * 0.35f
      canvas.drawText(dayStr, dayX, dayY, textPaint)

      // 6. BL: timestamp (line 1) + "HABIT:xxx" (line 2)
      val line2Baseline = S - pad
      val line1Baseline = line2Baseline - lineGap
      canvas.drawText(timestampStr, pad, line1Baseline, textPaint)
      canvas.drawText(habitStr,     pad, line2Baseline, textPaint)

      // 7. BR corner bracket ┘
      val brPath = Path().apply {
        moveTo(S - pad - armLen, S - pad)
        lineTo(S - pad,          S - pad)
        lineTo(S - pad,          S - pad - armLen)
      }
      canvas.drawPath(brPath, bracketPaint)
    }

    // ── Encoder (square output) ────────────────────────────────────────────
    val MIME   = "video/avc"
    val encFmt = MediaFormat.createVideoFormat(MIME, squareSize, squareSize).apply {
      setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000)
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

      // 2. Drain decoder → crop → draw overlays → feed encoder
      if (!decOutputDone) {
        val outIdx = decoder.dequeueOutputBuffer(bufInfo, 0)
        if (outIdx >= 0) {
          val render = bufInfo.size > 0
          decoder.releaseOutputBuffer(outIdx, render)
          if (render) {
            val img = imageReader.acquireLatestImage()
            if (img != null) {
              // Decode full frame (handles rotation)
              val fullBmp = yuvToBitmap(img, dispWE, dispHE, rotation)
              img.close()

              // Center-crop to square
              val croppedBmp = Bitmap.createBitmap(fullBmp, cropX, cropY, squareSize, squareSize)
              fullBmp.recycle()

              // Draw overlays (dark tone + text + brackets)
              drawOverlays(croppedBmp)

              // Feed to encoder
              val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
              if (encInIdx >= 0) {
                val encBuf = encoder.getInputBuffer(encInIdx)!!
                bitmapToYuv420(croppedBmp, encBuf, squareSize, squareSize)
                encoder.queueInputBuffer(encInIdx, 0, squareSize * squareSize * 3 / 2, outputPts, 0)
                outputPts += FRAME_US
              }
              croppedBmp.recycle()
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
          // Passthrough full audio
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
