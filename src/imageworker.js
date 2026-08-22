import { ImagequantImage, Imagequant } from 'imagequant';
import { encode } from '@jsquash/webp';
import apngjs from 'apng-js';
const parseAPNG = typeof apngjs === 'function' ? apngjs : apngjs.default;
import { parseGIF, decompressFrames } from 'gifuct-js';

// ==========================================
// 自作 WebP Assembler
// ==========================================
function assembleAnimatedWebP(frames, width, height) {
  let totalPayloadSize = 0;
  
  const parsedFrames = frames.map(f => {
    const u8 = new Uint8Array(f.webpBuffer);
    let offset = 12; 
    const chunks = [];
    
    while (offset < u8.length) {
      const id = String.fromCharCode(...u8.subarray(offset, offset + 4));
      const size = new DataView(u8.buffer, u8.byteOffset).getUint32(offset + 4, true);
      const data = u8.subarray(offset + 8, offset + 8 + size + (size % 2));
      
      if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') {
        chunks.push({ id, size, data });
      }
      offset += 8 + size + (size % 2);
    }
    
    let payloadSize = 0;
    for (const c of chunks) {
      payloadSize += 8 + c.size + (c.size % 2);
    }
    totalPayloadSize += 24 + payloadSize; 
    return { ...f, chunks, payloadSize };
  });

  const fileSize = 4 + 18 + 14 + totalPayloadSize; 
  const buffer = new ArrayBuffer(8 + fileSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  u8.set([82, 73, 70, 70], 0);
  view.setUint32(4, fileSize, true);
  u8.set([87, 69, 66, 80], 8);

  let offset = 12;

  u8.set([86, 80, 56, 88], offset);
  view.setUint32(offset + 4, 10, true);
  u8[offset + 8] = 0x12; 
  u8.set([0, 0, 0], offset + 9);
  view.setUint8(offset + 12, (width - 1) & 0xFF);
  view.setUint8(offset + 13, ((width - 1) >> 8) & 0xFF);
  view.setUint8(offset + 14, ((width - 1) >> 16) & 0xFF);
  view.setUint8(offset + 15, (height - 1) & 0xFF);
  view.setUint8(offset + 16, ((height - 1) >> 8) & 0xFF);
  view.setUint8(offset + 17, ((height - 1) >> 16) & 0xFF);
  offset += 18;

  u8.set([65, 78, 73, 77], offset);
  view.setUint32(offset + 4, 6, true);
  view.setUint32(offset + 8, 0, true);
  view.setUint16(offset + 12, 0, true); 
  offset += 14;

  for (const f of parsedFrames) {
    u8.set([65, 78, 77, 70], offset);
    view.setUint32(offset + 4, 16 + f.payloadSize, true);
    
    u8.fill(0, offset + 8, offset + 14); 
    
    view.setUint8(offset + 14, (width - 1) & 0xFF);
    view.setUint8(offset + 15, ((width - 1) >> 8) & 0xFF);
    view.setUint8(offset + 16, ((width - 1) >> 16) & 0xFF);
    view.setUint8(offset + 17, (height - 1) & 0xFF);
    view.setUint8(offset + 18, ((height - 1) >> 8) & 0xFF);
    view.setUint8(offset + 19, ((height - 1) >> 16) & 0xFF);
    
    view.setUint8(offset + 20, f.durationMs & 0xFF);
    view.setUint8(offset + 21, (f.durationMs >> 8) & 0xFF);
    view.setUint8(offset + 22, (f.durationMs >> 16) & 0xFF);
    
    u8[offset + 23] = 3; 
    offset += 24;

    for (const c of f.chunks) {
      u8.set([c.id.charCodeAt(0), c.id.charCodeAt(1), c.id.charCodeAt(2), c.id.charCodeAt(3)], offset);
      view.setUint32(offset + 4, c.size, true);
      u8.set(c.data, offset + 8);
      offset += 8 + c.size + (c.size % 2);
    }
  }

  return buffer;
}

// ==========================================
// デコーダー クラス群 (ストリーミング対応)
// ==========================================

// 1. ネイティブ (ImageDecoder API)
class NativeDecoder {
  async init(file, mimeType) {
    // ★ mimeTypeを明示的に指定してエラーを防ぐ
    this.decoder = new ImageDecoder({ data: file.stream(), type: mimeType });
    await this.decoder.tracks.ready;
    const track = this.decoder.tracks[0];
    this.frameCount = track.frameCount;
    
    const result = await this.decoder.decode({ frameIndex: 0 });
    this.width = result.image.displayWidth;
    this.height = result.image.displayHeight;
    result.image.close();
    
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    return { width: this.width, height: this.height, frameCount: this.frameCount };
  }
  
  async getFrame(i) {
    const result = await this.decoder.decode({ frameIndex: i });
    const durationMs = Math.round((result.image.duration || 100000) / 1000);
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(result.image, 0, 0);
    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    result.image.close();
    return { imageData, durationMs };
  }
}

// 2. GIF JSフォールバック (gifuct-js)
class GifFallbackDecoder {
  async init(buffer) {
    const gif = parseGIF(buffer);
    this.frames = decompressFrames(gif, true);
    this.width = gif.lsd.width;
    this.height = gif.lsd.height;
    this.frameCount = this.frames.length;
    
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.backupCanvas = new OffscreenCanvas(this.width, this.height);
    this.backupCtx = this.backupCanvas.getContext('2d', { willReadFrequently: true });
    this.lastDisposeOp = 0;
    this.lastRect = null;
    return { width: this.width, height: this.height, frameCount: this.frameCount };
  }

  async getFrame(i) {
    const frame = this.frames[i];
    
    if (this.lastDisposeOp === 2 && this.lastRect) {
      this.ctx.clearRect(this.lastRect.x, this.lastRect.y, this.lastRect.w, this.lastRect.h);
    } else if (this.lastDisposeOp === 3) {
      this.ctx.putImageData(this.backupImageData, this.lastRect.x, this.lastRect.y);
    }

    if (frame.disposalType === 3) {
      this.backupImageData = this.ctx.getImageData(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    }

    const patchData = new ImageData(new Uint8ClampedArray(frame.patch), frame.dims.width, frame.dims.height);
    const tempCanvas = new OffscreenCanvas(frame.dims.width, frame.dims.height);
    tempCanvas.getContext('2d').putImageData(patchData, 0, 0);
    this.ctx.drawImage(tempCanvas, frame.dims.left, frame.dims.top);

    this.lastDisposeOp = frame.disposalType;
    this.lastRect = { x: frame.dims.left, y: frame.dims.top, w: frame.dims.width, h: frame.dims.height };

    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    return { imageData, durationMs: frame.delay || 100 };
  }
}

// 3. APNG JSフォールバック (apng-js)
class ApngFallbackDecoder {
  async init(buffer) {
    const apng = parseAPNG(buffer);
    if (apng instanceof Error) throw new Error(apng.message);
    this.frames = apng.frames;
    this.width = apng.width;
    this.height = apng.height;
    this.frameCount = this.frames.length;
    
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.backupCanvas = new OffscreenCanvas(this.width, this.height);
    this.backupCtx = this.backupCanvas.getContext('2d');
    this.lastDisposeOp = 0;
    this.lastRect = null;
    return { width: this.width, height: this.height, frameCount: this.frameCount };
  }

  async getFrame(i) {
    const frame = this.frames[i];
    
    if (this.lastDisposeOp === 1 && this.lastRect) {
      this.ctx.clearRect(this.lastRect.x, this.lastRect.y, this.lastRect.w, this.lastRect.h);
    } else if (this.lastDisposeOp === 2 && this.lastRect) {
      this.ctx.clearRect(this.lastRect.x, this.lastRect.y, this.lastRect.w, this.lastRect.h);
      this.ctx.drawImage(this.backupCanvas, 0, 0);
    }

    if (frame.disposeOp === 2) {
      this.backupCtx.clearRect(0, 0, this.width, this.height);
      this.backupCtx.drawImage(this.canvas, 0, 0);
    }

    const blob = new Blob([frame.imageData], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);

    if (frame.blendOp === 0) {
      this.ctx.clearRect(frame.left, frame.top, frame.width, frame.height);
    }
    this.ctx.drawImage(bmp, frame.left, frame.top);
    bmp.close();

    this.lastDisposeOp = frame.disposeOp;
    this.lastRect = { x: frame.left, y: frame.top, w: frame.width, h: frame.height };

    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    return { imageData, durationMs: frame.delay || 100 };
  }
}

// 4. 静止画・その他のフォールバック
class StaticFallbackDecoder {
  async init(file) {
    const bmp = await createImageBitmap(file);
    this.width = bmp.width;
    this.height = bmp.height;
    this.frameCount = 1;
    this.bmp = bmp;
    return { width: this.width, height: this.height, frameCount: 1 };
  }
  async getFrame() {
    const canvas = new OffscreenCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, this.width, this.height);
    this.bmp.close();
    return { imageData, durationMs: 0 };
  }
}

// ファイル形式の簡易判定
function getFormatInfo(bytes, mimeType) {
  if (mimeType === 'image/gif' || (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) {
    return 'gif';
  }
  if (mimeType === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)) {
    for (let i = 0; i < Math.min(bytes.length - 4, 1024); i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4c) return 'apng';
    }
    return 'png';
  }
  if (mimeType === 'image/webp' || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) {
    for (let i = 12; i < Math.min(bytes.length - 4, 256); i++) {
      if (bytes[i] === 0x41 && bytes[i+1] === 0x4E && bytes[i+2] === 0x49 && bytes[i+3] === 0x4D) return 'animated-webp';
    }
    return 'webp';
  }
  return 'static';
}


// ==========================================
// メイン処理キュー
// ==========================================
let currentJobPromise = Promise.resolve();
let latestJobId = 0;

self.addEventListener('message', (event) => {
  const { jobId, file, settings, isFinal } = event.data;
  latestJobId = jobId;

  currentJobPromise = currentJobPromise.then(async () => {
    if (latestJobId !== jobId) return;
    await processImage(jobId, file, settings, isFinal);
  }).catch(err => {
    console.error("Workerキューエラー:", err);
    self.postMessage({ jobId, status: 'error', message: err.message });
  });
});

async function processImage(jobId, file, settings, isFinal) {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    // ★ Windows環境等でWebPのMIME Typeが空になる現象への対策
    let mimeType = file.type;
    if (!mimeType) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'webp') mimeType = 'image/webp';
      else if (ext === 'png') mimeType = 'image/png';
      else if (ext === 'gif') mimeType = 'image/gif';
      else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
    }

    const format = getFormatInfo(bytes, mimeType);
    
    // ★ 【機能検知】ImageDecoder判定を正常状態に戻す
    let useNative = false;
    if (typeof ImageDecoder !== 'undefined') {
      try {
        useNative = await ImageDecoder.isTypeSupported(mimeType);
      } catch (e) { useNative = false; }
    }

    // 適切なデコーダを選択
    let decoder;
    if (useNative) {
      try {
        decoder = new NativeDecoder();
        await decoder.init(file, mimeType);
      } catch (e) {
        console.warn("ネイティブデコーダ失敗、JSへフォールバック:", e);
        useNative = false;
      }
    }

    if (!useNative) {
      if (format === 'gif') {
        decoder = new GifFallbackDecoder();
        await decoder.init(buffer);
      } else if (format === 'apng') {
        decoder = new ApngFallbackDecoder();
        await decoder.init(buffer);
      } else {
        decoder = new StaticFallbackDecoder();
        await decoder.init(file);
      }
    }

    const { width, height, frameCount } = decoder;
    const isAnimated = frameCount > 1;

    const MAX_TOTAL_PIXELS = 50_000_000;
    if (width * height * frameCount > MAX_TOTAL_PIXELS) {
      throw new Error(`総ピクセル数が上限(5000万px)を超えています。処理を中断しました。`);
    }
    if (frameCount > 150) {
      throw new Error(`アニメーションのコマ数が多すぎます（上限: 150コマ / 現在: ${frameCount}コマ）`);
    }
    if (width > 2048 || height > 2048) {
      throw new Error(`解像度が大きすぎます（上限: 2048x2048 px / 現在: ${width}x${height} px）`);
    }

    const processedFrames = [];
    const originalFramesPreviews = []; 
    const encodeMethod = isFinal ? 6 : 1;
    const iqInstance = settings.mode === 'lossless' && settings.colors < 256 ? new Imagequant() : null;
    
    if (iqInstance) iqInstance.set_max_colors(settings.colors);

    for (let i = 0; i < frameCount; i++) {
      let { imageData, durationMs } = await decoder.getFrame(i);

      // ★ 背景透過を維持するため JPEG ではなく WebP でプレビュー画像を保持
      const prevCanvas = new OffscreenCanvas(width, height);
      const prevCtx = prevCanvas.getContext('2d', { willReadFrequently: true });
      prevCtx.putImageData(imageData, 0, 0);
      const prevBlob = await prevCanvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
      originalFramesPreviews.push(prevBlob);

      if (iqInstance) {
        const uint8Array = new Uint8Array(imageData.data.buffer);
        const iqImage = new ImagequantImage(uint8Array, width, height, 0);
        const output = iqInstance.process(iqImage);
        
        const pngBlob = new Blob([output.buffer], { type: "image/png" });
        const bmp = await createImageBitmap(pngBlob);
        
        const qCanvas = new OffscreenCanvas(width, height);
        const qCtx = qCanvas.getContext('2d', { willReadFrequently: true });
        qCtx.clearRect(0, 0, width, height);
        qCtx.drawImage(bmp, 0, 0);
        imageData = qCtx.getImageData(0, 0, width, height);
        bmp.close();
      }

      const webpBuffer = await encode(imageData, {
        lossless: settings.mode === 'lossless' ? 1 : 0,
        quality: settings.mode === 'lossy' ? settings.lossyQuality : 100,
        method: encodeMethod,
        exact: 1
      });

      processedFrames.push({ durationMs, webpBuffer });
    }

    let outputBlob;
    let frameBlobs = [];
    if (isAnimated) {
      const animatedWebPBuffer = assembleAnimatedWebP(processedFrames, width, height);
      outputBlob = new Blob([animatedWebPBuffer], { type: 'image/webp' });
      frameBlobs = processedFrames.map(f => new Blob([f.webpBuffer], { type: 'image/webp' }));
    } else {
      outputBlob = new Blob([processedFrames[0].webpBuffer], { type: 'image/webp' });
      frameBlobs = [outputBlob];
    }

    self.postMessage({
      jobId: jobId,
      status: 'success',
      blob: outputBlob,
      originalFrames: originalFramesPreviews, 
      processedFrames: frameBlobs, 
      originalSize: file.size,
      processedSize: outputBlob.size,
      width: width,
      height: height,
      isAnimated: isAnimated,
      isFinal: isFinal
    });

  } catch (error) {
    console.error("Worker内エラー:", error);
    self.postMessage({ jobId, status: 'error', message: error.message });
  }
}