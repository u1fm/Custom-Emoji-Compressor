import { ImagequantImage, Imagequant } from 'imagequant';
import { encode } from '@jsquash/webp';

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
// キャッシュ機構
// ==========================================
let cachedFile = null;
let cachedAnimInfo = null;
let cachedFrames = []; 
let cachedStaticImage = null; 

function isSameFile(f1, f2) {
  if (!f1 || !f2) return false;
  return f1.name === f2.name && f1.size === f2.size && f1.lastModified === f2.lastModified;
}

async function checkIsAnimated(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (file.type === 'image/gif' || (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) {
    let frameCount = 0;
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x21 && bytes[i+1] === 0xF9 && bytes[i+2] === 0x04) {
        frameCount++;
        if (frameCount > 1) return { isAnimated: true, type: 'gif' };
      }
    }
  }
  if (file.type === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)) {
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4c) {
        return { isAnimated: true, type: 'apng' };
      }
    }
  }
  return { isAnimated: false, type: 'static' };
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
    if (typeof ImageDecoder === 'undefined') {
      throw new Error("お使いのブラウザはネイティブの高度なアニメーション解析に対応していません。ChromeまたはEdgeをご利用ください。");
    }

    const isNewFile = !isSameFile(cachedFile, file);

    if (isNewFile) {
      cachedAnimInfo = await checkIsAnimated(file);
      cachedFile = file;

      const decoder = new ImageDecoder({ data: file.stream(), type: file.type });
      await decoder.tracks.ready;
      const track = decoder.tracks[0];
      const isAnimated = track.frameCount > 1;

      if (cachedAnimInfo.isAnimated && isAnimated) {
        cachedFrames = [];
        let canvas = null, ctx = null;
        let width = 0, height = 0;

        for (let i = 0; i < track.frameCount; i++) {
          const result = await decoder.decode({ frameIndex: i });
          const image = result.image;
          const durationMs = Math.round((image.duration || 100000) / 1000);

          if (!canvas) {
            width = image.displayWidth;
            height = image.displayHeight;
            canvas = new OffscreenCanvas(width, height);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
          }

          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0);
          
          const originalBlob = await canvas.convertToBlob({ type: 'image/png' });

          cachedFrames.push({ 
            durationMs, 
            imageData: ctx.getImageData(0, 0, width, height), 
            width, 
            height,
            originalBlob
          });
          image.close();
        }
      } else {
        const result = await decoder.decode({ frameIndex: 0 });
        const image = result.image;
        const width = image.displayWidth;
        const height = image.displayHeight;
        
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close();

        cachedStaticImage = {
          imageData: ctx.getImageData(0, 0, width, height),
          width, height
        };
      }
    }

    let outputBlob;
    let frameBlobs = []; 
    const encodeMethod = isFinal ? 6 : 1; 
    
    // ★確実に変数を定義
    let outWidth = 0;
    let outHeight = 0;

    if (cachedAnimInfo.isAnimated && cachedFrames.length > 0) {
      const processedFrames = [];
      outWidth = cachedFrames[0].width;
      outHeight = cachedFrames[0].height;
      
      let canvas = new OffscreenCanvas(outWidth, outHeight);
      let ctx = canvas.getContext('2d', { willReadFrequently: true });

      for (const frame of cachedFrames) {
        let currentImageData = frame.imageData;

        if (settings.mode === 'lossless' && settings.colors < 256) {
          const uint8Array = new Uint8Array(currentImageData.data.buffer);
          const iqImage = new ImagequantImage(uint8Array, outWidth, outHeight, 0);
          const instance = new Imagequant();
          instance.set_max_colors(settings.colors);
          
          const output = instance.process(iqImage);
          const pngBlob = new Blob([output.buffer], { type: "image/png" });
          const bmp = await createImageBitmap(pngBlob);
          
          ctx.clearRect(0, 0, outWidth, outHeight);
          ctx.drawImage(bmp, 0, 0);
          currentImageData = ctx.getImageData(0, 0, outWidth, outHeight);
          bmp.close();
        }

        const webpBuffer = await encode(currentImageData, {
          lossless: settings.mode === 'lossless' ? 1 : 0,
          quality: settings.mode === 'lossy' ? settings.lossyQuality : 100,
          method: encodeMethod,
          exact: 1
        });

        processedFrames.push({ durationMs: frame.durationMs, webpBuffer });
      }

      const animatedWebPBuffer = assembleAnimatedWebP(processedFrames, outWidth, outHeight);
      outputBlob = new Blob([animatedWebPBuffer], { type: 'image/webp' });
      
      frameBlobs = processedFrames.map(f => new Blob([f.webpBuffer], { type: 'image/webp' }));

    } else {
      outWidth = cachedStaticImage.width;
      outHeight = cachedStaticImage.height;
      let currentImageData = cachedStaticImage.imageData;

      if (settings.mode === 'lossless' && settings.colors < 256) {
        const uint8Array = new Uint8Array(currentImageData.data.buffer);
        const iqImage = new ImagequantImage(uint8Array, outWidth, outHeight, 0);
        const instance = new Imagequant();
        instance.set_max_colors(settings.colors);
        
        const output = instance.process(iqImage);
        const pngBlob = new Blob([output.buffer], { type: "image/png" });
        const bmp = await createImageBitmap(pngBlob);
        
        const canvas = new OffscreenCanvas(outWidth, outHeight);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, outWidth, outHeight);
        ctx.drawImage(bmp, 0, 0);
        currentImageData = ctx.getImageData(0, 0, outWidth, outHeight);
        bmp.close();
      }

      const webpBuffer = await encode(currentImageData, {
        lossless: settings.mode === 'lossless' ? 1 : 0,
        quality: settings.mode === 'lossy' ? settings.lossyQuality : 100,
        method: encodeMethod,
        exact: 1
      });

      outputBlob = new Blob([webpBuffer], { type: 'image/webp' });
    }

    self.postMessage({
      jobId: jobId,
      status: 'success',
      blob: outputBlob,
      originalFrames: cachedFrames ? cachedFrames.map(f => f.originalBlob) : [], 
      processedFrames: frameBlobs, 
      originalSize: file.size,
      processedSize: outputBlob.size,
      width: outWidth,
      height: outHeight,
      isAnimated: cachedAnimInfo.isAnimated,
      isFinal: isFinal
    });

  } catch (error) {
    console.error("Worker内エラー:", error);
    self.postMessage({ jobId, status: 'error', message: error.message });
  }
}