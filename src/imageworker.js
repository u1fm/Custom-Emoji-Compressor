import { ImagequantImage, Imagequant } from 'imagequant';
import { encode, decode } from '@jsquash/webp';
import apngjs from 'apng-js';
const parseAPNG = typeof apngjs === 'function' ? apngjs : apngjs.default;
import { parseGIF, decompressFrames } from 'gifuct-js';
import pica from 'pica';

let globalCache = {
  signature: "",
  baseFrames: [], 
  originalFramesPreviews: [],
  originalDurations: [],
  outputWidth: 0,
  outputHeight: 0,
  originalWidth: 0,
  originalHeight: 0,
  isAnimated: false,
  formatStr: ""
};

function assembleAnimatedWebP(frames, width, height, loopCount = 0) {
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
  view.setUint16(offset + 12, loopCount, true); 
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

class NativeDecoder {
  async init(file, mimeType) {
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

function createStaticWebP(frameWidth, frameHeight, frameData) {
  let hasAlpha = false;
  let checkOffset = 0;
  while (checkOffset < frameData.length) {
    if (checkOffset + 8 > frameData.length) break;
    const id = String.fromCharCode(...frameData.subarray(checkOffset, checkOffset + 4));
    if (id === 'ALPH' || id === 'VP8L') {
      hasAlpha = true;
      break;
    }
    if (id === 'VP8 ') break;
    const size = new DataView(frameData.buffer, frameData.byteOffset).getUint32(checkOffset + 4, true);
    checkOffset += 8 + size + (size % 2);
  }

  const fileSize = 4 + 18 + frameData.length;
  const buffer = new ArrayBuffer(8 + fileSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  u8.set([82, 73, 70, 70], 0);
  view.setUint32(4, fileSize, true);
  u8.set([87, 69, 66, 80], 8);
  u8.set([86, 80, 56, 88], 12);
  view.setUint32(16, 10, true);
  u8[20] = hasAlpha ? 0x10 : 0x00;
  u8[24] = (frameWidth - 1) & 0xFF;
  u8[25] = ((frameWidth - 1) >> 8) & 0xFF;
  u8[26] = ((frameWidth - 1) >> 16) & 0xFF;
  u8[27] = (frameHeight - 1) & 0xFF;
  u8[28] = ((frameHeight - 1) >> 8) & 0xFF;
  u8[29] = ((frameHeight - 1) >> 16) & 0xFF;

  u8.set(frameData, 30);
  return buffer;
}

class WebpFallbackDecoder {
  async init(buffer) {
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 12;

    this.width = 0;
    this.height = 0;
    this.frames = [];

    while (offset < u8.length) {
      if (offset + 8 > u8.length) break;
      const chunkId = String.fromCharCode(...u8.subarray(offset, offset + 4));
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataStart = offset + 8;
      const chunkDataEnd = chunkDataStart + chunkSize + (chunkSize % 2);

      if (chunkId === 'VP8X') {
        this.width = (u8[chunkDataStart + 4] | (u8[chunkDataStart + 5] << 8) | (u8[chunkDataStart + 6] << 16)) + 1;
        this.height = (u8[chunkDataStart + 7] | (u8[chunkDataStart + 8] << 8) | (u8[chunkDataStart + 9] << 16)) + 1;
      } else if (chunkId === 'ANMF') {
        const get24 = (off) => u8[off] | (u8[off+1] << 8) | (u8[off+2] << 16);
        const frameX = get24(chunkDataStart) * 2;
        const frameY = get24(chunkDataStart + 3) * 2;
        const frameWidth = get24(chunkDataStart + 6) + 1;
        const frameHeight = get24(chunkDataStart + 9) + 1;
        const duration = get24(chunkDataStart + 12);
        const flags = u8[chunkDataStart + 15];
        const blendOp = (flags & 2) >> 1; 
        const disposeOp = flags & 1; 
        const frameData = u8.subarray(chunkDataStart + 16, chunkDataEnd);
        
        this.frames.push({ x: frameX, y: frameY, w: frameWidth, h: frameHeight, duration, blendOp, disposeOp, data: frameData });
      }
      offset = chunkDataEnd;
      if (chunkSize === 0) break; 
    }
    
    this.frameCount = this.frames.length;

    if (this.frameCount === 0) {
      const blob = new Blob([buffer], { type: 'image/webp' });
      const bmp = await createImageBitmap(blob);
      this.width = bmp.width;
      this.height = bmp.height;
      this.frameCount = 1;
      this.staticBmp = bmp;
      return { width: this.width, height: this.height, frameCount: 1 };
    }

    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastDisposeOp = 0;
    this.lastRect = null;
    return { width: this.width, height: this.height, frameCount: this.frameCount };
  }

  async getFrame(i) {
    if (this.staticBmp) {
      const canvas = new OffscreenCanvas(this.width, this.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.staticBmp, 0, 0);
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      if (i === 0) this.staticBmp.close();
      return { imageData, durationMs: 0 };
    }

    const frame = this.frames[i];
    
    if (this.lastDisposeOp === 1 && this.lastRect) {
      this.ctx.clearRect(this.lastRect.x, this.lastRect.y, this.lastRect.w, this.lastRect.h);
    }

    const staticWebPBuffer = createStaticWebP(frame.w, frame.h, frame.data);
    const imageDataPatch = await decode(staticWebPBuffer);
    
    const tempCanvas = new OffscreenCanvas(frame.w, frame.h);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageDataPatch, 0, 0);

    if (frame.blendOp === 1) { 
      this.ctx.clearRect(frame.x, frame.y, frame.w, frame.h);
    }
    this.ctx.drawImage(tempCanvas, frame.x, frame.y);

    this.lastDisposeOp = frame.disposeOp;
    this.lastRect = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };

    const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    return { imageData, durationMs: frame.duration || 100 };
  }
}

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

function getFormatInfo(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { format: 'gif', mimeType: 'image/gif' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    for (let i = 0; i < Math.min(bytes.length - 4, 1024); i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4c) {
        return { format: 'apng', mimeType: 'image/png' };
      }
    }
    return { format: 'png', mimeType: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    for (let i = 12; i < Math.min(bytes.length - 4, 256); i++) {
      if (bytes[i] === 0x41 && bytes[i+1] === 0x4E && bytes[i+2] === 0x49 && bytes[i+3] === 0x4D) {
        return { format: 'animated-webp', mimeType: 'image/webp' };
      }
    }
    return { format: 'webp', mimeType: 'image/webp' };
  }
  return { format: 'static', mimeType: null };
}

let currentJobPromise = Promise.resolve();
let latestJobId = 0;

self.addEventListener('message', (event) => {
  const { jobId, file, settings, isFinal, isTimelineEdit } = event.data;
  latestJobId = jobId;

  currentJobPromise = currentJobPromise.then(async () => {
    if (latestJobId !== jobId) return;
    await processImage(jobId, file, settings, isFinal, isTimelineEdit);
  }).catch(err => {
    console.error("Workerキューエラー:", err);
    self.postMessage({ jobId, status: 'error', message: err.message });
  });
});

async function processImage(jobId, file, settings, isFinal, isTimelineEdit) {
  try {
    const sig = `${file.name}-${file.size}-${file.lastModified}-${settings.mode}-${settings.colors}-${settings.lossyQuality}-${settings.isResizeEnabled}-${settings.resizeHeight}-${isFinal}`;

    if (sig !== globalCache.signature) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let { format, mimeType } = getFormatInfo(bytes);
      
      if (!mimeType) {
        mimeType = file.type;
        if (!mimeType) {
          const ext = file.name.split('.').pop().toLowerCase();
          if (ext === 'webp') mimeType = 'image/webp';
          else if (ext === 'png') mimeType = 'image/png';
          else if (ext === 'gif') mimeType = 'image/gif';
          else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        }
      }

      let decoder;
      if (format === 'animated-webp') {
        decoder = new WebpFallbackDecoder();
        await decoder.init(buffer);
      } else if (format === 'gif') {
        decoder = new GifFallbackDecoder();
        await decoder.init(buffer);
      } else if (format === 'apng') {
        decoder = new ApngFallbackDecoder();
        await decoder.init(buffer);
      } else {
        decoder = new StaticFallbackDecoder();
        await decoder.init(file);
      }

      const { width, height, frameCount } = decoder;
      const isAnimated = frameCount > 1;

      const MAX_TOTAL_PIXELS = 50_000_000;
      if (width * height * frameCount > MAX_TOTAL_PIXELS) throw new Error(`総ピクセル数が上限(5000万px)を超えています。処理を中断しました。`);
      if (frameCount > 150) throw new Error(`アニメーションのコマ数が多すぎます（上限: 150コマ / 現在: ${frameCount}コマ）`);
      if (width > 2048 || height > 2048) throw new Error(`解像度が大きすぎます（上限: 2048x2048 px / 現在: ${width}x${height} px）`);

      let outputWidth = width;
      let outputHeight = height;
      if (settings.isResizeEnabled && height > settings.resizeHeight) {
        outputHeight = settings.resizeHeight;
        outputWidth = Math.max(1, Math.round(width * (settings.resizeHeight / height)));
      }

      const picaRunner = pica();
      const encodeMethod = isFinal ? 6 : 1; 
      const iqInstance = settings.mode === 'lossless' && settings.colors < 256 ? new Imagequant() : null;
      if (iqInstance) iqInstance.set_max_colors(settings.colors);

      globalCache.baseFrames = [];
      globalCache.originalFramesPreviews = [];
      globalCache.originalDurations = [];

      for (let i = 0; i < frameCount; i++) {
        let { imageData, durationMs } = await decoder.getFrame(i);
        globalCache.originalDurations.push(durationMs); 

        // ★ 最適化1: タイムライン用の画像を長辺160px程度の極小サムネイルとして生成しメモリを劇的に節約
        const sourceCanvas = new OffscreenCanvas(width, height);
        sourceCanvas.getContext('2d', { willReadFrequently: true }).putImageData(imageData, 0, 0);

        const maxThumbEdge = 160;
        const scale = Math.min(1, maxThumbEdge / Math.max(width, height));
        const thumbWidth = Math.max(1, Math.round(width * scale));
        const thumbHeight = Math.max(1, Math.round(height * scale));
        
        const thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight);
        thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, thumbWidth, thumbHeight);
        
        const prevBlob = await thumbCanvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
        globalCache.originalFramesPreviews.push(prevBlob);

        if (outputWidth !== width || outputHeight !== height) {
          const resizedCanvas = new OffscreenCanvas(outputWidth, outputHeight);
          await picaRunner.resize(sourceCanvas, resizedCanvas, { unsharpAmount: 60, unsharpRadius: 0.6, unsharpThreshold: 2 });
          imageData = resizedCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, outputWidth, outputHeight);
        }

        if (iqInstance) {
          const uint8Array = new Uint8Array(imageData.data.buffer);
          const iqImage = new ImagequantImage(uint8Array, outputWidth, outputHeight, 0);
          const output = iqInstance.process(iqImage);
          const pngBlob = new Blob([output.buffer], { type: "image/png" });
          const bmp = await createImageBitmap(pngBlob);
          const qCanvas = new OffscreenCanvas(outputWidth, outputHeight);
          const qCtx = qCanvas.getContext('2d', { willReadFrequently: true });
          qCtx.clearRect(0, 0, outputWidth, outputHeight);
          qCtx.drawImage(bmp, 0, 0);
          imageData = qCtx.getImageData(0, 0, outputWidth, outputHeight);
          bmp.close();
        }

        const webpBuffer = await encode(imageData, {
          lossless: settings.mode === 'lossless' ? 1 : 0,
          quality: settings.mode === 'lossy' ? settings.lossyQuality : 100,
          method: encodeMethod,
          exact: 1
        });

        globalCache.baseFrames.push({ webpBuffer, originalDurationMs: durationMs });
      }

      globalCache.outputWidth = outputWidth;
      globalCache.outputHeight = outputHeight;
      globalCache.originalWidth = width;
      globalCache.originalHeight = height;
      globalCache.isAnimated = isAnimated;
      globalCache.formatStr = format;
      globalCache.signature = sig; 
    }

    let forwardAccumulator = 0; 
    const processedFrames = [];

    for (let i = 0; i < globalCache.baseFrames.length; i++) {
      const baseFrame = globalCache.baseFrames[i];
      let control = settings.frameControls && settings.frameControls[i] 
        ? settings.frameControls[i] : { state: 'keep', customDuration: null };

      let currentDuration = control.customDuration !== null ? control.customDuration : baseFrame.originalDurationMs;

      if (control.state === 'discard') continue;
      if (control.state === 'absorb') {
        if (processedFrames.length > 0) {
          processedFrames[processedFrames.length - 1].durationMs += currentDuration;
        } else {
          forwardAccumulator += currentDuration;
        }
        continue;
      }
      
      processedFrames.push({
        webpBuffer: baseFrame.webpBuffer, 
        durationMs: currentDuration + forwardAccumulator
      });
      forwardAccumulator = 0; 
    }

    if (forwardAccumulator > 0 && processedFrames.length > 0) {
      processedFrames[processedFrames.length - 1].durationMs += forwardAccumulator;
    }

    if (processedFrames.length === 0 && globalCache.baseFrames.length > 0) {
      processedFrames.push({
        webpBuffer: globalCache.baseFrames[0].webpBuffer,
        durationMs: globalCache.baseFrames[0].originalDurationMs
      });
    }

    let outputBlob;
    let previewBlob;
    let frameBlobs = [];

    if (globalCache.isAnimated) {
      const animatedWebPBuffer = assembleAnimatedWebP(processedFrames, globalCache.outputWidth, globalCache.outputHeight, 0);
      outputBlob = new Blob([animatedWebPBuffer], { type: 'image/webp' });

      const previewLoopCount = settings.syncPreviewLoop ? 1 : 0;
      const previewBuffer = assembleAnimatedWebP(processedFrames, globalCache.outputWidth, globalCache.outputHeight, previewLoopCount);
      previewBlob = new Blob([previewBuffer], { type: 'image/webp' });

      if (!isTimelineEdit) {
        frameBlobs = processedFrames.map(f => new Blob([f.webpBuffer], { type: 'image/webp' }));
      }
    } else {
      outputBlob = new Blob([processedFrames[0].webpBuffer], { type: 'image/webp' });
      previewBlob = outputBlob;
      if (!isTimelineEdit) frameBlobs = [outputBlob];
    }

    self.postMessage({
      jobId: jobId,
      status: 'success',
      blob: isFinal ? outputBlob : previewBlob,
      originalFrames: isTimelineEdit ? null : globalCache.originalFramesPreviews, 
      processedFrames: isTimelineEdit ? null : frameBlobs, 
      originalDurations: globalCache.originalDurations,
      originalSize: file.size,
      processedSize: outputBlob.size, 
      originalWidth: globalCache.originalWidth,           
      originalHeight: globalCache.originalHeight,         
      processedWidth: globalCache.outputWidth,    
      processedHeight: globalCache.outputHeight,  
      isAnimated: globalCache.isAnimated,
      isFinal: isFinal,
      isTimelineEdit: isTimelineEdit,
      detectedFormat: globalCache.formatStr 
    });
  } catch (error) {
    console.error("Worker内エラー:", error);
    self.postMessage({ jobId, status: 'error', message: error.message });
  }
}