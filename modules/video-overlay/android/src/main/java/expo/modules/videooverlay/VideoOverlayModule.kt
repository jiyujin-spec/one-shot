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
      val userId     = options["userId"]     as? String
      val habitName  = (options["habitName"] as? String)?.uppercase(Locale.US)
      val currentDay = (options["currentDay"] as? Number)?.toInt()

      if (inputPath == null || userId == null || habitName == null || currentDay == null) {
        promise.reject(
          "ERR_INVALID_PARAMS",
          "Missing required parameters: inputPath, userId, habitName, currentDay",
          null
        )
        return@AsyncFunction
      }

      val totalDays  = (options["totalDays"]  as? Number)?.toInt()
      val outputPath = options["outputPath"] as? String

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

          val sdf = SimpleDateFormat("yyyy.MM.dd_HH:mm", Locale.US)
          val timestampStr = sdf.format(Date())
          val habitStr = when {
            totalDays != null && currentDay >= totalDays -> "$habitName COMPLETED"
            totalDays != null -> "$habitName DAY $currentDay/$totalDays"
            else -> "$habitName DAY $currentDay"
          }

          processIndustrialVideo(
            srcPath, outFile.absolutePath,
            timestampStr, userId, habitStr, "ONE SHOT"
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
    val x: Float,   // 0..1 relative
    val y: Float,   // 0..1 relative
    val fontSize: Float,
    val colorHex: String,
    val bold: Boolean
  )

  private fun uriToPath(uri: String): String {
    val parsed = Uri.parse(uri)
    return if (parsed.scheme == "file") parsed.path!! else uri
  }

  // ---------------------------------------------------------------------------
  // Industrial-data overlay: 3 s live + 2 s frozen last frame
  // ---------------------------------------------------------------------------
  private fun processIndustrialVideo(
    srcPath: String, dstPath: String,
    timestampStr: String, userId: String, habitStr: String, logoStr: String
  ) {
    val FREEZE_US = 3_000_000L   // 3 seconds in microseconds
    val STILL_US  = 2_000_000L   // 2 seconds for frozen frame
    val FPS       = 30
    val FRAME_US  = 1_000_000L / FPS
    val TIMEOUT   = 10_000L      // 10 ms dequeue timeout

    // ── Metadata ──────────────────────────────────────────────────────────────
    val retriever = MediaMetadataRetriever()
    retriever.setDataSource(srcPath)
    val srcW       = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt()    ?: 720
    val srcH       = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt()   ?: 1280
    val rotation   = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong()      ?: 3000L
    retriever.release()

    val durationUs = durationMs * 1000L
    val liveEndUs  = minOf(FREEZE_US, durationUs)
    val addStill   = durationUs > FREEZE_US

    val (encW, encH) = if (rotation == 90 || rotation == 270) srcH to srcW else srcW to srcH
    val finalW = if (encW % 2 == 0) encW else encW - 1
    val finalH = if (encH % 2 == 0) encH else encH - 1

    // ── Overlay paint & positions ─────────────────────────────────────────────
    val fontSize = finalH * 0.0125f
    val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize  = fontSize
      color     = Color.argb(255, 200, 200, 200)
      typeface  = Typeface.MONOSPACE
      setShadowLayer(4f, 1f, 1f, Color.argb(102, 0, 0, 0))
    }

    val xLeft    = finalW * 0.05f
    val xRight   = finalW * 0.85f
    val yTop     = finalH * 0.12f + fontSize   // baseline for top labels
    val yBottom  = finalH * 0.75f              // baseline for bottom labels

    val xUserId  = xRight - textPaint.measureText(userId)
    val xLogo    = xRight - textPaint.measureText(logoStr)

    fun drawOverlays(bmp: Bitmap) {
      val canvas = Canvas(bmp)
      canvas.drawText(timestampStr, xLeft,   yTop,    textPaint)
      canvas.drawText(userId,       xUserId, yTop,    textPaint)
      canvas.drawText(habitStr,     xLeft,   yBottom, textPaint)
      canvas.drawText(logoStr,      xLogo,   yBottom, textPaint)
    }

    // ── Encoder ───────────────────────────────────────────────────────────────
    val MIME   = "video/avc"
    val encFmt = MediaFormat.createVideoFormat(MIME, finalW, finalH).apply {
      setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
      setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val encoder = MediaCodec.createEncoderByType(MIME)
    encoder.configure(encFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()

    // ── Decoder ───────────────────────────────────────────────────────────────
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
      finalW, finalH, android.graphics.ImageFormat.YUV_420_888, 4
    )
    val decoder = MediaCodec.createDecoderByType(decoderMime)
    decoder.configure(videoFmt, imageReader.surface, null, 0)
    decoder.start()

    // ── Muxer ─────────────────────────────────────────────────────────────────
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

    // ── Main loop ─────────────────────────────────────────────────────────────
    val bufInfo        = MediaCodec.BufferInfo()
    var decInputDone   = false
    var decOutputDone  = false
    var encDone        = false
    var muxVideo       = -1
    var muxStarted     = false
    var outputPts      = 0L
    var lastBitmap: Bitmap? = null
    var stillFramesLeft = if (addStill) (STILL_US / FRAME_US).toInt() else 0
    var eosToEncoder   = false
    val audioBuf       = ByteBuffer.allocate(512 * 1024)
    val audioInfo      = MediaCodec.BufferInfo()

    while (!encDone) {

      // 1. Feed decoder (live portion only)
      if (!decInputDone) {
        val inIdx = decoder.dequeueInputBuffer(0)
        if (inIdx >= 0) {
          val sampleTime = extractor.sampleTime
          if (sampleTime < 0 || sampleTime >= liveEndUs) {
            decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            decInputDone = true
          } else {
            val buf = decoder.getInputBuffer(inIdx)!!
            val sz  = extractor.readSampleData(buf, 0)
            if (sz < 0) {
              decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              decInputDone = true
            } else {
              decoder.queueInputBuffer(inIdx, 0, sz, sampleTime, 0)
              extractor.advance()
            }
          }
        }
      }

      // 2. Drain decoder → draw overlays → feed encoder (live frames)
      if (!decOutputDone) {
        val outIdx = decoder.dequeueOutputBuffer(bufInfo, 0)
        if (outIdx >= 0) {
          val render = bufInfo.size > 0
          decoder.releaseOutputBuffer(outIdx, render)
          if (render) {
            val img = imageReader.acquireLatestImage()
            if (img != null) {
              val bmp = yuvToBitmap(img, finalW, finalH, rotation)
              img.close()
              drawOverlays(bmp)

              // Keep a copy for the still phase
              lastBitmap?.recycle()
              lastBitmap = bmp.copy(Bitmap.Config.ARGB_8888, false)

              // Encode live frame
              val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
              if (encInIdx >= 0) {
                val encBuf = encoder.getInputBuffer(encInIdx)!!
                bitmapToYuv420(bmp, encBuf, finalW, finalH)
                encoder.queueInputBuffer(encInIdx, 0, finalW * finalH * 3 / 2, outputPts, 0)
                outputPts += FRAME_US
              }
              bmp.recycle()
            }
          }
          if (bufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            decOutputDone = true
          }
        }
      }

      // 3. Still phase: feed frozen last frame after live portion ends
      if (decOutputDone && !eosToEncoder) {
        if (stillFramesLeft > 0 && lastBitmap != null) {
          val encInIdx = encoder.dequeueInputBuffer(0)
          if (encInIdx >= 0) {
            val encBuf = encoder.getInputBuffer(encInIdx)!!
            bitmapToYuv420(lastBitmap!!, encBuf, finalW, finalH)
            stillFramesLeft--
            val flags = if (stillFramesLeft == 0) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
            encoder.queueInputBuffer(encInIdx, 0, finalW * finalH * 3 / 2, outputPts, flags)
            outputPts += FRAME_US
            if (stillFramesLeft == 0) eosToEncoder = true
          }
        } else if (stillFramesLeft == 0) {
          // No still frames (video ≤ 3 s or already done) – signal EOS
          val encInIdx = encoder.dequeueInputBuffer(TIMEOUT)
          if (encInIdx >= 0) {
            encoder.queueInputBuffer(encInIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            eosToEncoder = true
          }
        }
      }

      // 4. Drain encoder → muxer
      val encOutIdx = encoder.dequeueOutputBuffer(bufInfo, TIMEOUT)
      when {
        encOutIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          muxVideo = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          muxStarted = true
          // Passthrough audio for live portion only
          if (audioExt != null && muxAudio >= 0) {
            while (true) {
              val sz = audioExt.readSampleData(audioBuf, 0)
              if (sz < 0) break
              if (audioExt.sampleTime > liveEndUs) break
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

    // ── Cleanup ───────────────────────────────────────────────────────────────
    lastBitmap?.recycle()
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
    // 1. Extract video metadata
    val retriever = MediaMetadataRetriever().also { it.setDataSource(srcPath) }
    val srcW    = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt()  ?: 720
    val srcH    = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt() ?: 1280
    val rotation= retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toInt() ?: 0
    val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() ?: 3000L
    retriever.release()

    // Swap dimensions if rotated 90/270
    val (encW, encH) = if (rotation == 90 || rotation == 270) srcH to srcW else srcW to srcH

    // Make dimensions even (H.264 requirement)
    val finalW = if (encW % 2 == 0) encW else encW - 1
    val finalH = if (encH % 2 == 0) encH else encH - 1

    // 2. Build paints
    val paints = overlays.map { spec ->
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize  = spec.fontSize
        color     = parseHex(spec.colorHex)
        typeface  = if (spec.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        setShadowLayer(3f, 1f, 1f, Color.BLACK)
      }
    }

    // 3. Setup encoder (H.264, COLOR_FormatYUV420Flexible)
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

    // 4. Setup decoder
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

    // 5. Setup muxer
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

    // 6. Decode + encode loop
    val TIMEOUT = 10_000L
    val info     = MediaCodec.BufferInfo()
    var decDone  = false
    var encDone  = false
    var muxVideo = -1
    var muxed    = false
    val audioBuf = ByteBuffer.allocate(512 * 1024)
    val audioInfo= MediaCodec.BufferInfo()

    while (!encDone) {
      // --- Feed decoder ---
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

      // --- Drain decoder → ImageReader ---
      val decOut = decoder.dequeueOutputBuffer(info, TIMEOUT)
      if (decOut >= 0) {
        val hasFrame = info.size > 0
        decoder.releaseOutputBuffer(decOut, hasFrame /* render to surface */)

        if (hasFrame) {
          val image = imageReader.acquireLatestImage()
          if (image != null) {
            val bmp = yuvToBitmap(image, finalW, finalH, rotation)
            image.close()

            // Draw text overlays onto the bitmap
            val canvas = Canvas(bmp)
            for ((i, spec) in overlays.withIndex()) {
              canvas.drawText(
                spec.text,
                spec.x * finalW,
                spec.y * finalH,
                paints[i]
              )
            }

            // Feed bitmap into encoder as YUV
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

      // --- Drain encoder → muxer ---
      val encOut = encoder.dequeueOutputBuffer(info, TIMEOUT)
      when {
        encOut == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          muxVideo = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          muxed = true
          // Write audio passthrough
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
    // Y plane
    for (row in 0 until h) for (col in 0 until w) {
      val px = argb[row * w + col]
      val r  = (px shr 16) and 0xFF; val g = (px shr 8) and 0xFF; val b = px and 0xFF
      buf.put(clamp(((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte())
    }
    // U/V planes (4:2:0)
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
