<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';

  let currentFile = null;
  let originalUrl = null;
  let processedUrl = null;
  
  let originalFramesUrls = [];
  let processedFramesUrls = [];
  let currentFrame = -1; 
  let zoomedSrc = null;
  
  let showLicenseModal = false;
  let showBatchDurationModal = false;
  let batchDurationValue = 100;
  
  let isProcessing = false;
  let isSaving = false;
  
  let resultStats = null;
  let detectedFormatName = '';
  let worker;
  let currentJobId = 0;
  let debounceTimer;

  let settings = { 
    mode: 'lossless', 
    colors: 256, 
    lossyQuality: 80, 
    isResizeEnabled: false, 
    resizeHeight: 256,
    syncPreviewLoop: true 
  };
  let warningConfig = { enabled: true, limitStaticKB: 10, limitAnimatedKB: 64 };
  
  let isEditorOpen = false; 
  let originalDurations = []; 
  let frameControls = []; 
  let frameViewMode = 'grid'; 
  let lastClickedFrame = -1;
  
  let syncTrigger = 0;
  let syncInterval = null;

  let isFreeColorMode = false;
  const colorPresets = [16, 32, 64, 128, 256];
  let presetIndex = 4;
  
  let fileInput;

  // --- タイムラインシーク（時間ベース）用の状態管理 ---
  let currentTimeMs = 0;

  $: accumulatedTimes = originalDurations.reduce((acc, dur, i) => {
    if (i === 0) acc.push(0);
    else acc.push(acc[i - 1] + originalDurations[i - 1]);
    return acc;
  }, []);

  $: totalDuration = originalDurations.reduce((a, b) => a + b, 0);

  // 時間(ms)スライダーを動かした時に、現在のオリジナルコマ番号を逆算して同期させる
  function syncFrameFromTime() {
    if (accumulatedTimes.length === 0) return;
    let idx = accumulatedTimes.findIndex((startTime, i) => {
      const endTime = startTime + originalDurations[i];
      return currentTimeMs >= startTime && currentTimeMs < endTime;
    });
    if (idx === -1) idx = accumulatedTimes.length - 1; 
    currentFrame = idx;
  }

  // アニメーション再生ループ等でコマが進んだ時に、時間を同期させる
  function syncTimeFromFrame() {
    if (currentFrame >= 0 && currentFrame < accumulatedTimes.length) {
      currentTimeMs = accumulatedTimes[currentFrame];
    }
  }

  // 現在の「圧縮後のコマ位置」を計算する処理
  $: currentProcessedFrameIndex = (() => {
    if (currentFrame === -1 || !frameControls || frameControls.length === 0) return currentFrame + 1;
    let count = 0;
    for (let i = 0; i <= currentFrame; i++) {
      if (frameControls[i] && frameControls[i].state === 'keep') {
        count++;
      }
    }
    return Math.max(1, count);
  })();

  $: effectiveDurations = (() => {
    const result = new Array(frameControls.length);
    let absorbedAfter = 0;

    for (let i = frameControls.length - 1; i >= 0; i--) {
      const control = frameControls[i];
      if (!control) {
        result[i] = originalDurations[i] || 0;
        continue;
      }
      
      const base = control.customDuration !== null ? control.customDuration : originalDurations[i];

      if (control.state === 'absorb') {
        absorbedAfter += base;
        result[i] = 0;
        continue;
      }

      if (control.state === 'discard') {
        absorbedAfter = 0;
        result[i] = 0;
        continue;
      }

      result[i] = base + absorbedAfter;
      absorbedAfter = 0;
    }

    return result;
  })();

  $: if (!isFreeColorMode) {
    settings.colors = colorPresets[presetIndex];
  }

  function handleModeToggle(e) {
    isFreeColorMode = e.target.checked;
    if (!isFreeColorMode) {
      const closest = colorPresets.reduce((a, b) => Math.abs(b - settings.colors) < Math.abs(a - settings.colors) ? b : a);
      presetIndex = colorPresets.indexOf(closest);
    }
  }

  let pendingTimelineEdit = false;
  
  function scheduleWorker(isTimelineEdit = false) {
    if (isTimelineEdit) pendingTimelineEdit = true;
    clearTimeout(debounceTimer);
    const delay = pendingTimelineEdit ? 100 : 400; 
    debounceTimer = setTimeout(() => {
      runWorker(false, pendingTimelineEdit);
      pendingTimelineEdit = false; 
    }, delay);
  }

  $: if (currentFile && settings) {
    scheduleWorker(false);
  }

  function revokeAll(urls) {
    if (urls) urls.forEach(u => URL.revokeObjectURL(u));
  }

  function resetState() {
    currentFile = null;
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = null;
    if (processedUrl) URL.revokeObjectURL(processedUrl);
    processedUrl = null;
    
    revokeAll(originalFramesUrls);
    originalFramesUrls = [];
    revokeAll(processedFramesUrls);
    processedFramesUrls = [];
    
    isEditorOpen = false;
    showBatchDurationModal = false;
    originalDurations = [];
    frameControls = [];
    lastClickedFrame = -1;
    
    clearInterval(syncInterval);
    syncTrigger = 0;
    
    currentTimeMs = 0;
    currentFrame = -1;
    zoomedSrc = null;
    resultStats = null;
    isProcessing = false;
    isSaving = false;
    
    if (fileInput) fileInput.value = '';
  }

  onMount(() => {
    worker = new Worker(new URL('./imageworker.js', import.meta.url), { type: 'module' });
    
    worker.onmessage = (e) => {
      const data = e.data;
      if (data.jobId === currentJobId) {
        if (data.status === 'success') {
          if (data.isFinal) {
            const downloadUrl = URL.createObjectURL(data.blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            
            const originalName = currentFile.name;
            const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
            a.download = `${nameWithoutExt}_compressed.webp`;
            
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(downloadUrl);
            
            isSaving = false;
            return;
          }

          if (originalUrl) URL.revokeObjectURL(originalUrl);
          if (processedUrl) URL.revokeObjectURL(processedUrl);
          originalUrl = URL.createObjectURL(currentFile);
          processedUrl = URL.createObjectURL(data.blob);
          
          if (!data.isTimelineEdit) {
            revokeAll(originalFramesUrls);
            originalFramesUrls = data.originalFrames ? data.originalFrames.map(b => URL.createObjectURL(b)) : [];
          }
          revokeAll(processedFramesUrls);
          processedFramesUrls = data.processedFrames ? data.processedFrames.map(b => URL.createObjectURL(b)) : [];
          
          if (currentFrame >= originalFramesUrls.length) {
            currentFrame = -1;
            currentTimeMs = 0;
          }

          if (data.originalDurations && !data.isTimelineEdit) {
            originalDurations = data.originalDurations;
            if (frameControls.length !== originalDurations.length) {
              frameControls = originalDurations.map(() => ({ state: 'keep', customDuration: null }));
            }
          }
          
          startSyncLoop();

          detectedFormatName = data.detectedFormat ? data.detectedFormat.toUpperCase() : '';

          resultStats = {
            original: data.originalSize,
            processed: data.processedSize,
            isAnimated: data.isAnimated,
            originalWidth: data.originalWidth,
            originalHeight: data.originalHeight,
            processedWidth: data.processedWidth,
            processedHeight: data.processedHeight,
            originalFrameCount: data.originalFrames ? data.originalFrames.length : (resultStats?.originalFrameCount || 1),
            processedFrameCount: data.processedFrames ? data.processedFrames.length : (resultStats?.processedFrameCount || 1)
          };
          
          isProcessing = false;
        } else {
          console.error("Workerエラー:", data.message);
          alert(`処理エラー: ${data.message}`);
          resetState();
        }
      }
    };
  });

  onDestroy(() => {
    clearTimeout(debounceTimer);
    clearInterval(syncInterval);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (processedUrl) URL.revokeObjectURL(processedUrl);
    revokeAll(originalFramesUrls);
    revokeAll(processedFramesUrls);
    if (worker) worker.terminate();
  });

  function processSelectedFile(file) {
    if (!file) return;
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      alert(`ファイルサイズが大きすぎます（上限: 10MB）。\n現在のサイズ: ${formatSize(file.size)}`);
      resetState();
      return;
    }
    resetState();
    currentFile = file;
    originalUrl = URL.createObjectURL(file);
    runWorker(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    processSelectedFile(event.dataTransfer.files[0]);
  }
  
  function handleFileInputChange(event) {
    processSelectedFile(event.target.files[0]);
  }

  function handlePaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        processSelectedFile(file);
        break;
      }
    }
  }

  function runWorker(isFinal = false, isTimelineEdit = false) {
    if (!currentFile || !worker) return;
    if (isFinal) isSaving = true;
    else isProcessing = true;

    currentJobId = Date.now();
    worker.postMessage({
      jobId: currentJobId,
      file: currentFile,
      settings: { ...settings, frameControls: frameControls },
      isFinal: isFinal,
      isTimelineEdit: isTimelineEdit 
    });
  }

  function handleDownloadClick() {
    runWorker(true);
  }

  function startSyncLoop() {
    clearInterval(syncInterval);
    if (!settings.syncPreviewLoop) return;
    
    const totalOriginalDuration = originalDurations.reduce((a, b) => a + b, 0);
    if (totalOriginalDuration > 0) {
      syncInterval = setInterval(() => {
        if (currentFrame === -1 && !isProcessing) {
          syncTrigger++; 
          syncTimeFromFrame();
        }
      }, totalOriginalDuration);
    }
  }

  $: originalPreviewSrc = currentFrame === -1 ? originalUrl : (originalFramesUrls[currentFrame] || originalUrl);
  
  function getPreviewFrameUrl(origIndex) {
    if (!processedFramesUrls || processedFramesUrls.length === 0) return processedUrl || originalUrl;
    if (frameControls && frameControls.length > 0) {
      let keepCount = 0;
      for (let i = 0; i <= origIndex; i++) {
        if (frameControls[i] && frameControls[i].state === 'keep') {
          keepCount++;
        }
      }
      let previewIndex = Math.max(0, keepCount - 1);
      previewIndex = Math.min(previewIndex, processedFramesUrls.length - 1);
      return processedFramesUrls[previewIndex];
    }
    let safeIndex = Math.min(origIndex, processedFramesUrls.length - 1);
    return processedFramesUrls[safeIndex];
  }
  
  $: processedPreviewSrc = currentFrame === -1 ? (processedUrl || originalUrl) : getPreviewFrameUrl(currentFrame);

  let origImg1, procImg1, origImg2, procImg2;
  $: if (settings.syncPreviewLoop && syncTrigger > 0) {
    [origImg1, procImg1, origImg2, procImg2].forEach(img => {
      if (img && img.src) {
        const s = img.src;
        img.src = '';
        setTimeout(() => { if (img) img.src = s; }, 10);
      }
    });
  }

  function toggleFrameState(index, event) {
    if (event.shiftKey && lastClickedFrame !== -1 && lastClickedFrame !== index) {
      let start = Math.min(lastClickedFrame, index);
      let end = Math.max(lastClickedFrame, index);
      let targetState = frameControls[lastClickedFrame].state;
      for (let j = start; j <= end; j++) {
        frameControls[j].state = targetState;
      }
    } else {
      let current = frameControls[index].state;
      let next = current === 'keep' ? 'absorb' : (current === 'absorb' ? 'discard' : 'keep');
      frameControls[index].state = next;
      lastClickedFrame = index;
    }
    frameControls = frameControls; 
    scheduleWorker(true);
  }

  function applyBatchState(action) {
    for (let i = 0; i < frameControls.length; i++) {
      if (action === 'all_keep') frameControls[i].state = 'keep';
      else if (action === 'all_discard') frameControls[i].state = 'discard';
      else if (action === 'even_absorb' && i % 2 !== 0) {
        if (frameControls[i].state !== 'discard') frameControls[i].state = 'absorb';
      }
      else if (action === 'odd_absorb' && i % 2 === 0) {
        if (frameControls[i].state !== 'discard') frameControls[i].state = 'absorb';
      }
    }
    frameControls = frameControls;
    scheduleWorker(true);
  }

  function applyBatchDuration() {
    let num = parseInt(batchDurationValue, 10);
    if (isNaN(num)) num = null;
    else if (num < 11) num = 11;
    
    for (let i = 0; i < frameControls.length; i++) {
      frameControls[i].customDuration = num;
    }
    frameControls = frameControls;
    scheduleWorker(true);
    showBatchDurationModal = false;
  }

  function trimBefore(targetIndex) {
    for (let i = 0; i < targetIndex; i++) {
      frameControls[i].state = 'discard';
    }
    frameControls = frameControls;
    scheduleWorker(true);
  }

  function trimAfter(targetIndex) {
    for (let i = targetIndex + 1; i < frameControls.length; i++) {
      frameControls[i].state = 'discard';
    }
    frameControls = frameControls;
    scheduleWorker(true);
  }

  function handleEffectiveDurationChange(index, value) {
    let num = parseInt(value, 10);
    if (isNaN(num)) {
      frameControls[index].customDuration = null;
    } else {
      if (num < 11) num = 11;
      let absorbedTime = 0;
      for (let j = index + 1; j < frameControls.length; j++) {
        if (frameControls[j].state === 'absorb') {
           absorbedTime += (frameControls[j].customDuration !== null ? frameControls[j].customDuration : originalDurations[j]);
        } else break;
      }
      frameControls[index].customDuration = Math.max(0, num - absorbedTime);
    }
    frameControls = frameControls;
    scheduleWorker(true);
  }

  function formatSize(bytes) {
    if (bytes === undefined || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
  
  function getFileFormat(file, isAnimated) {
    if (!file) return '';
    let format = detectedFormatName; 
    if (!format) {
      format = file.name.split('.').pop().toUpperCase();
      if (file.type === 'image/png') format = 'PNG';
      else if (file.type === 'image/webp') format = 'WebP';
      else if (file.type === 'image/gif') format = 'GIF';
      else if (file.type === 'image/jpeg') format = 'JPEG';
    }
    if (format === 'ANIMATED-WEBP') return 'WebP (アニメーション)';
    if (isAnimated && !format.includes('アニメーション')) {
      return `${format} (アニメーション)`;
    }
    return format;
  }

  $: limitKB = resultStats?.isAnimated ? warningConfig.limitAnimatedKB : warningConfig.limitStaticKB;
  $: isOverLimit = resultStats && (resultStats.processed / 1024) > limitKB;
  $: isSizeIncreased = resultStats && resultStats.processed > resultStats.original;
  $: sizeDiffPercent = resultStats ? Math.abs(Math.round((1 - resultStats.processed / resultStats.original) * 100)) : 0;
</script>

<svelte:window on:paste={handlePaste} />

<main>
  <h1>カスタム絵文字コンプレッサー</h1>
  
  <input type="file" accept="image/png, image/jpeg, image/webp, image/gif" bind:this={fileInput} on:change={handleFileInputChange} style="display: none;" />

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="dropzone" on:drop={handleDrop} on:dragover|preventDefault on:click={() => fileInput.click()}>
    <p>ここをクリックして画像を選択<br><small>またはドロップ、ペースト(Ctrl+V)</small></p>
    <p class="format-note">
      対応フォーマット: PNG (APNG), GIF, WebP, JPEG<br>
      上限: サイズ 10 MB / 解像度 2048×2048 px / アニメ 150 コマ<br>
      展開後の総ピクセル数 5000万 px
    </p>
  </div>

  <div class="control-panel">
    <div class="setting-row">
      <div class="setting-group" style="flex: 1;">
        <label>圧縮モード:</label>
        <div class="toggle-group">
          <button class:active={settings.mode === 'lossless'} on:click={() => settings.mode = 'lossless'}>可逆 (減色)</button>
          <button class:active={settings.mode === 'lossy'} on:click={() => settings.mode = 'lossy'}>非可逆</button>
        </div>
      </div>
      
      <div class="setting-group">
        <label>縮小 (縦幅):</label>
        <div class="toggle-group">
          <button class:active={!settings.isResizeEnabled} on:click={() => settings.isResizeEnabled = false}>オフ</button>
          <button class:active={settings.isResizeEnabled} on:click={() => settings.isResizeEnabled = true}>オン</button>
        </div>
      </div>
      
      <div class="setting-group limit-settings">
        <label>目標サイズ (KB):</label>
        <div class="limit-inputs">
          <label class="inline-label">静止画: <input type="number" min="1" bind:value={warningConfig.limitStaticKB} /> KB</label>
          <label class="inline-label">アニメ: <input type="number" min="1" bind:value={warningConfig.limitAnimatedKB} /> KB</label>
        </div>
      </div>
    </div>

    {#if settings.mode === 'lossless'}
      <div class="setting-group">
        <div class="label-with-toggle">
          <label>色数: {settings.colors}色</label>
          <label class="checkbox-label">
            <input type="checkbox" checked={isFreeColorMode} on:change={handleModeToggle} />
            自由選択モード
          </label>
        </div>
        {#if isFreeColorMode}
          <input type="range" min="2" max="256" bind:value={settings.colors} />
          <div class="slider-labels"><span>2</span><span>256</span></div>
        {:else}
          <input type="range" min="0" max="{colorPresets.length - 1}" step="1" bind:value={presetIndex} />
          <div class="slider-labels">
            {#each colorPresets as preset}<span>{preset}</span>{/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="setting-group">
        <label>圧縮品質: {settings.lossyQuality}</label>
        <input type="range" min="0" max="100" bind:value={settings.lossyQuality} />
      </div>
    {/if}

    {#if settings.isResizeEnabled}
      <div class="setting-group resize-settings" transition:fade={{duration: 150}}>
        <div class="label-with-toggle">
          <label>目標の縦幅: 
            <input type="number" min="16" max="512" bind:value={settings.resizeHeight} class="inline-number" /> px以下に縮小
          </label>
        </div>
        <input type="range" min="64" max="512" bind:value={settings.resizeHeight} />
        <div class="slider-labels"><span>64px</span><span>512px</span></div>
      </div>
    {/if}
  </div>

  {#if originalUrl}
    <div class="preview-area" transition:fade={{duration: 150}}>
      <h3>プレビュー</h3>
      
      <div class="comparison-container">
        <div class="image-box">
          <div class="size-label-container">
            <span class="label-title">オリジナル</span>
            <span class="label-value">{formatSize(currentFile.size)}</span>
            <span class="meta-info">
              {getFileFormat(currentFile, resultStats?.isAnimated)}
              {#if resultStats?.originalHeight}
                | {resultStats.originalHeight} × {resultStats.originalWidth} px
              {/if}
              {#if resultStats?.isAnimated && resultStats?.originalFrameCount}
                | {resultStats.originalFrameCount} コマ
              {/if}
            </span>
          </div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <div class="image-container">
            <img bind:this={origImg1}
              src={originalPreviewSrc} 
              alt="元画像" class="zoomable" draggable="false" 
              on:contextmenu|preventDefault
              on:click={() => zoomedSrc = originalPreviewSrc} 
            />
          </div>
        </div>

        <div class="image-box">
          <div class="size-label-container">
            <span class="label-title">圧縮後 (プレビュー画質)</span>
            {#if resultStats}
              <span class="label-value highlight" class:text-danger={isOverLimit || isSizeIncreased}>
                {formatSize(resultStats.processed)}
              </span>
              <span class="label-sub" class:text-danger={isSizeIncreased}>
                ({isSizeIncreased ? `+${sizeDiffPercent}% 増加` : `${sizeDiffPercent}% 削減`})
              </span>
              <span class="meta-info">
                WebP
                {#if resultStats.processedHeight}
                  | {resultStats.processedHeight} × {resultStats.processedWidth} px
                {/if}
                {#if resultStats?.isAnimated && resultStats?.processedFrameCount}
                  | {resultStats.processedFrameCount} コマ
                {/if}
              </span>
            {:else}
              <span class="label-value">計算中...</span>
            {/if}
          </div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <div class="image-container">
            <img bind:this={procImg1}
              src={processedPreviewSrc} 
              alt="プレビュー" class="zoomable" class:processing={isProcessing} draggable="false" 
              on:contextmenu|preventDefault
              on:click={() => zoomedSrc = processedPreviewSrc}
            />
            {#if isProcessing}
              <div class="loading-overlay">処理中...</div>
            {/if}
          </div>
        </div>
      </div>
      
      {#if resultStats?.isAnimated && processedFramesUrls.length > 0}
        <div class="frame-controls">
          <div class="frame-buttons">
            <button class:active={currentFrame === -1} on:click={() => { currentFrame = -1; startSyncLoop(); }}>▶ アニメーション</button>
            <button class:active={currentFrame !== -1} on:click={() => { 
              if (currentFrame === -1) {
                currentFrame = 0;
                if (accumulatedTimes.length > 0) currentTimeMs = accumulatedTimes[0];
              }
              clearInterval(syncInterval); 
            }}>⏸ コマ送りで比較</button>
          </div>
          
          <div class="sync-option-row">
            <label class="sync-checkbox-wrapper">
              <input type="checkbox" bind:checked={settings.syncPreviewLoop} />
              <span>ループを同期</span>
            </label>
          </div>

          <!-- ★ トグルを廃止し、時間(ms)ベースの滑らかなシークバーに一本化 ＆ 情報を常時併記 -->
          {#if currentFrame !== -1}
            <div class="frame-slider">
              <input type="range" min="0" max={totalDuration > 0 ? totalDuration - 1 : 0} bind:value={currentTimeMs} on:input={syncFrameFromTime} />
              <span class="frame-counter">
                {currentTimeMs} / {totalDuration} ms
                <span class="separator">|</span>
                オリジナル: {currentFrame + 1} / {originalFramesUrls.length} コマ
                <span class="separator">|</span>
                圧縮後: {currentProcessedFrameIndex} / {Math.max(1, processedFramesUrls.length)} コマ
              </span>
            </div>
          {/if}
          
          {#if originalDurations.length > 1}
            <div class="editor-toggle-area">
              <button class="editor-toggle-btn" on:click={() => isEditorOpen = true}>
                ▼ タイムライン編集を開く (コマ間引き/尺調整)
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <div class="warnings-container">
        {#if isSizeIncreased}
          <p class="notice-text">⚠️ 圧縮後のファイルサイズが元画像よりも増加しています。設定を見直すか、元画像をそのまま使用することをおすすめします。</p>
        {/if}
        {#if isOverLimit}
          <p class="warning-text">⚠️ 目標サイズ ({limitKB}KB) を超えています。さらに色数や品質を下げてください。</p>
        {/if}
      </div>

      <div class="action-area">
        <button class="download-button" on:click={handleDownloadClick} disabled={isSaving || isProcessing}>
          {#if isSaving}保存中...{:else}保存{/if}
        </button>
      </div>
      
    </div>
  {/if}

  {#if zoomedSrc}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="zoom-modal" on:click={() => zoomedSrc = null} transition:fade={{ duration: 150 }}>
      <img src={zoomedSrc} alt="拡大プレビュー" draggable="false" on:contextmenu|preventDefault />
    </div>
  {/if}
</main>

{#if isEditorOpen && resultStats?.isAnimated && originalDurations.length > 1}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="editor-modal-backdrop" transition:fade={{ duration: 150 }}>
    <div class="editor-modal-content">
      
      <div class="modal-top-section">
        <div class="editor-modal-header">
          <h2>タイムライン編集</h2>
          <button class="modal-close-x" on:click={() => isEditorOpen = false}>✕ 閉じて戻る</button>
        </div>
        
        <div class="comparison-container">
          <div class="image-box">
            <div class="size-label-container">
              <span class="label-title">オリジナル</span>
              <span class="label-value">{formatSize(currentFile.size)}</span>
              <span class="meta-info">
                {getFileFormat(currentFile, resultStats?.isAnimated)}
                {#if resultStats?.originalHeight}
                  | {resultStats.originalHeight} × {resultStats.originalWidth} px
                {/if}
                {#if resultStats?.isAnimated && resultStats?.originalFrameCount}
                  | {resultStats.originalFrameCount} コマ
                {/if}
              </span>
            </div>
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <div class="image-container">
              <img bind:this={origImg2}
                src={originalPreviewSrc} 
                alt="元画像" class="zoomable" draggable="false" 
                on:contextmenu|preventDefault
                on:click={() => zoomedSrc = originalPreviewSrc} 
              />
            </div>
          </div>

          <div class="image-box">
            <div class="size-label-container">
              <span class="label-title">圧縮後 (プレビュー画質)</span>
              {#if resultStats}
                <span class="label-value highlight" class:text-danger={isOverLimit || isSizeIncreased}>
                  {formatSize(resultStats.processed)}
                </span>
                <span class="label-sub" class:text-danger={isSizeIncreased}>
                  ({isSizeIncreased ? `+${sizeDiffPercent}% 増加` : `${sizeDiffPercent}% 削減`})
                </span>
                <span class="meta-info">
                  WebP
                  {#if resultStats.processedHeight}
                    | {resultStats.processedHeight} × {resultStats.processedWidth} px
                  {/if}
                  {#if resultStats?.isAnimated && resultStats?.processedFrameCount}
                    | {resultStats.processedFrameCount} コマ
                  {/if}
                </span>
              {:else}
                <span class="label-value">計算中...</span>
              {/if}
            </div>
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <div class="image-container">
              <img bind:this={procImg2}
                src={processedPreviewSrc} 
                alt="プレビュー" class="zoomable" class:processing={isProcessing} draggable="false" 
                on:contextmenu|preventDefault
                on:click={() => zoomedSrc = processedPreviewSrc}
              />
              {#if isProcessing}
                <div class="loading-overlay">処理中...</div>
              {/if}
            </div>
          </div>
        </div>
        
        {#if resultStats?.isAnimated && processedFramesUrls.length > 0}
          <div class="frame-controls">
            <div class="frame-buttons">
              <button class:active={currentFrame === -1} on:click={() => { currentFrame = -1; startSyncLoop(); }}>▶ アニメーション</button>
              <button class:active={currentFrame !== -1} on:click={() => { 
                if (currentFrame === -1) {
                  currentFrame = 0;
                  if (accumulatedTimes.length > 0) currentTimeMs = accumulatedTimes[0];
                }
                clearInterval(syncInterval); 
              }}>⏸ コマ送りで比較</button>
            </div>
            <div class="sync-option-row">
              <label class="sync-checkbox-wrapper">
                <input type="checkbox" bind:checked={settings.syncPreviewLoop} />
                <span>ループを同期</span>
              </label>
            </div>

            <!-- ★ モーダル内のスライダーも時間ベースに一本化 ＆ 情報併記 -->
            {#if currentFrame !== -1}
              <div class="frame-slider">
                <input type="range" min="0" max={totalDuration > 0 ? totalDuration - 1 : 0} bind:value={currentTimeMs} on:input={syncFrameFromTime} />
                <span class="frame-counter">
                  {currentTimeMs} / {totalDuration} ms
                  <span class="separator">|</span>
                  オリジナル: {currentFrame + 1} / {originalFramesUrls.length} コマ
                  <span class="separator">|</span>
                  圧縮後: {currentProcessedFrameIndex} / {Math.max(1, processedFramesUrls.length)} コマ
                </span>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="modal-bottom-section">
        <div class="editor-header">
          <h3>コマごとの詳細設定</h3>
          <span class="editor-hint">※画像クリックで状態切替 / Shift+クリックで範囲選択</span>
        </div>
        
        <div class="editor-toolbar">
          <div class="view-toggles">
            <button class:active={frameViewMode === 'strip'} on:click={() => frameViewMode = 'strip'}>ストリップ</button>
            <button class:active={frameViewMode === 'grid'} on:click={() => frameViewMode = 'grid'}>グリッド</button>
          </div>
          <div class="batch-actions">
            <button on:click={() => applyBatchState('even_absorb')} title="偶数コマを間引き(時間吸収)状態にします">偶数間引き</button>
            <button on:click={() => applyBatchState('odd_absorb')} title="奇数コマを間引き(時間吸収)状態にします">奇数間引き</button>
            <button on:click={() => applyBatchState('all_keep')} title="すべてのコマを有効状態に戻します">全リセット</button>
            <button on:click={() => showBatchDurationModal = true} title="すべてのコマの表示時間を一括で変更します">⏱ 時間一括設定</button>
          </div>
        </div>

        <div class="frame-container {frameViewMode}">
          {#each originalFramesUrls as url, i (i)}
            <div class="frame-item" class:discard={frameControls[i].state === 'discard'} class:absorb={frameControls[i].state === 'absorb'}>
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div class="frame-image-wrapper" on:click={(e) => toggleFrameState(i, e)} title="クリックで切替 / Shift+クリックで範囲選択">
                <img src={url} alt="コマ {i+1}" draggable="false" loading="lazy" decoding="async" />
                
                {#if frameControls[i].state === 'absorb'}
                  <div class="state-overlay absorb">
                    <span class="icon">⏬</span>
                    <span class="text">吸収</span>
                  </div>
                {:else if frameControls[i].state === 'discard'}
                  <div class="state-overlay discard">
                    <span class="icon">✖</span>
                    <span class="text">カット</span>
                  </div>
                {/if}
                
                <span class="frame-number">{i + 1}</span>
              </div>

              <div class="frame-controls-box">
                <div class="trim-controls">
                  <button on:click={() => trimBefore(i)} title="ここより前のコマを全てカットします">◀ ｶｯﾄ</button>
                  <button on:click={() => trimAfter(i)} title="ここより後のコマを全てカットします">ｶｯﾄ ▶</button>
                </div>
                <div class="duration-control">
                  <input 
                    type="number" min="11" step="1" 
                    value={frameControls[i].state === 'keep' ? effectiveDurations[i] : 0} 
                    disabled={frameControls[i].state !== 'keep'}
                    on:change={(e) => handleEffectiveDurationChange(i, e.target.value)}
                    title={frameControls[i].state !== 'keep' ? "間引き・カットされたコマは時間設定できません" : "表示時間(ミリ秒)を手動上書き (最小11ms)"}
                  /> <small>ms</small>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showBatchDurationModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="zoom-modal" on:click={() => showBatchDurationModal = false} transition:fade={{ duration: 150 }}>
    <div class="license-box" on:click|stopPropagation>
      <h2>表示時間の一括設定</h2>
      <p class="license-intro">すべてのコマの表示時間(ミリ秒)を同じ値に上書きします。<br>※最小11ms。空欄のまま適用すると元の長さにリセットされます。</p>
      
      <div class="batch-duration-input-wrapper">
        <input type="number" min="11" step="1" bind:value={batchDurationValue} placeholder="リセット" /> <span>ms</span>
      </div>
      
      <div class="modal-buttons">
        <button class="modal-btn cancel" on:click={() => showBatchDurationModal = false}>キャンセル</button>
        <button class="modal-btn apply" on:click={applyBatchDuration}>適用する</button>
      </div>
    </div>
  </div>
{/if}

<footer>
  <p><a href="https://misskey.io/@u1f" target="_blank" rel="noopener noreferrer">Misskey.io account</a></p>
  <p><a href="https://mi.u1f.info/@u1f" target="_blank" rel="noopener noreferrer">Misskey 個人サーバー</a></p>
  <p>製作者 : 葵@u1f</p>
  <p class="license-link"><button on:click={() => showLicenseModal = true}>クレジット / ライセンス</button></p>
</footer>

{#if showLicenseModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="zoom-modal" on:click={() => showLicenseModal = false} transition:fade={{ duration: 150 }}>
    <div class="license-box" on:click|stopPropagation>
      <h2>クレジット / ライセンス</h2>
      <p class="license-intro">当ツールは、以下の素晴らしいツールやオープンソースライブラリを利用して構築されています。</p>
      <div class="license-list">
        <div class="license-item"><strong>アイコン作成: EmoteLab</strong><p>感謝の意を表します。</p></div>
        <div class="license-item"><strong>Svelte / Vite</strong><p>MIT License</p></div>
        <div class="license-item"><strong>@jsquash/webp</strong><p>ISC / MIT License</p></div>
        <div class="license-item"><strong>apng-js</strong><p>MIT License</p></div>
        <div class="license-item"><strong>gifuct-js</strong><p>MIT License</p></div>
        <div class="license-item"><strong>imagequant (Wasm)</strong><p>MIT / GPL License</p></div>
        <div class="license-item"><strong>pica</strong><p>MIT License</p></div>
      </div>
      <button class="close-modal-btn" on:click={() => showLicenseModal = false}>閉じる</button>
    </div>
  </div>
{/if}

<style>
  main { max-width: 800px; margin: 2rem auto; font-family: sans-serif; padding: 0 1rem; }
  .dropzone { border: 2px dashed #aaa; border-radius: 8px; padding: 3rem 1rem; text-align: center; background: #fdfdfd; cursor: pointer; margin-bottom: 1.5rem; transition: background 0.2s; }
  .dropzone:hover { background: #f0f8ff; border-color: #007bff; }
  .format-note { color: #666; font-size: 0.85rem; margin-top: 1rem; line-height: 1.5; }
  
  .control-panel { background: #f5f5f5; padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; }
  .setting-row { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
  .setting-group { margin-bottom: 1rem; }
  .setting-group label { display: block; margin-bottom: 0.5rem; font-weight: bold; }
  
  .limit-settings { background: #e9ecef; padding: 0.75rem; border-radius: 6px; }
  .limit-inputs { display: flex; gap: 1rem; align-items: center; }
  .inline-label { font-weight: normal !important; display: inline-flex; align-items: center; gap: 0.25rem; margin-bottom: 0 !important; font-size: 0.9rem;}
  .inline-label input { width: 60px; padding: 0.25rem; border: 1px solid #ccc; border-radius: 4px; text-align: right;}
  
  .label-with-toggle { display: flex; justify-content: space-between; align-items: center; }
  .checkbox-label { font-weight: normal !important; cursor: pointer; font-size: 0.9em; }
  .toggle-group button { padding: 0.5rem 1rem; border: 1px solid #ccc; background: white; cursor: pointer; }
  .toggle-group button.active { background: #007bff; color: white; border-color: #007bff; }
  input[type="range"] { width: 100%; margin: 0; }
  .slider-labels { display: flex; justify-content: space-between; margin-top: 4px; padding: 0 5px; font-size: 0.75em; color: #666; }
  
  .resize-settings { border-top: 1px solid #ddd; padding-top: 1rem; margin-top: 1rem; }
  .inline-number { width: 70px; text-align: right; padding: 0.25rem; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; font-size: 0.95rem; }

  .preview-area { text-align: center; margin-top: 1rem; }
  .comparison-container { display: flex; gap: 1rem; justify-content: center; align-items: flex-start; margin-top: 1rem; }
  .image-box { flex: 1; width: 48%; display: flex; flex-direction: column; }
  .size-label-container { height: 5.5rem; display: flex; flex-direction: column; justify-content: flex-end; margin-bottom: 0.5rem; }
  .label-title { font-size: 0.9em; color: #555; }
  .label-value { font-size: 1.1em; }
  .label-value.highlight { color: #007bff; font-weight: bold; font-size: 1.2em; }
  .label-value.text-danger { color: #dc3545; }
  .label-sub { font-size: 0.8em; color: #666; }
  .label-sub.text-danger { color: #dc3545; font-weight: bold; }
  .meta-info { font-size: 0.75rem; color: #888; margin-top: 2px; line-height: 1.4; }
  
  .image-container { 
    height: 280px;
    position: relative; padding: 1rem; border-radius: 8px; display: flex; justify-content: center; align-items: center;
    background-color: #e5e5e5;
    background-image: linear-gradient(45deg, #d0d0d0 25%, transparent 25%), linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d0d0d0 75%), linear-gradient(-45deg, transparent 75%, #d0d0d0 75%);
    background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  }
  .image-container img { 
    width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; transition: opacity 0.2s; 
  }
  .image-container img.processing { opacity: 0.5; }
  .zoomable { cursor: zoom-in; }
  
  .frame-controls { margin-top: 1.5rem; padding: 1rem; background: #fdfdfd; border: 1px solid #ddd; border-radius: 8px; }
  .frame-buttons { display: flex; gap: 0.5rem; justify-content: center; margin-bottom: 0.5rem; flex-wrap: wrap; align-items: center; }
  .frame-buttons button { padding: 0.5rem 1.5rem; border: 1px solid #ccc; background: white; cursor: pointer; border-radius: 4px; font-weight: bold; }
  .frame-buttons button.active { background: #6c757d; color: white; border-color: #6c757d; }
  
  .sync-option-row { text-align: center; margin-bottom: 1rem; }
  .sync-checkbox-wrapper { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.9rem; cursor: pointer; user-select: none; color: #555; }
  .sync-checkbox-wrapper input { cursor: pointer; }

  .frame-slider { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; margin-bottom: 1rem;}
  .frame-counter { font-size: 0.9em; font-weight: bold; color: #555; }
  .sub-counter { color: #888; margin-left: 4px; }
  .separator { color: #ccc; margin: 0 0.5rem; }

  .editor-toggle-area { margin-top: 0.5rem; text-align: center; border-top: 1px dashed #ccc; padding-top: 1.5rem; }
  .editor-toggle-btn { background: #f0f0f0; border: 1px solid #ccc; padding: 0.5rem 1.5rem; border-radius: 20px; font-size: 0.9rem; cursor: pointer; color: #333; transition: all 0.2s; font-weight: bold; }
  .editor-toggle-btn:hover { background: #e0e0e0; }
  .editor-toggle-btn.active { background: #007bff; color: white; border-color: #007bff; }

  .editor-modal-backdrop {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.85); 
    display: flex; justify-content: center; align-items: center; z-index: 1000;
  }
  .editor-modal-content {
    background: #f8f9fa;
    width: 98vw; max-width: 1200px; height: 96vh;
    border-radius: 12px; display: flex; flex-direction: column;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;
  }
  .modal-top-section {
    padding: 1rem 1.5rem; background: white; border-bottom: 1px solid #ddd;
    display: flex; flex-direction: column; gap: 0.5rem;
    overflow-y: auto; flex-shrink: 0;
  }
  .modal-bottom-section {
    padding: 1rem 1.5rem; flex: 1; overflow-y: auto; display: flex; flex-direction: column;
  }
  .editor-modal-header {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  }
  .editor-modal-header h2 { margin: 0; font-size: 1.4rem; color: #333; }
  .modal-close-x {
    background: #6c757d; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s; font-size: 1rem;
  }
  .modal-close-x:hover { background: #5a6268; }

  .modal-top-section .image-container {
    height: 192px; min-height: 192px;
  }

  .editor-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;}
  .editor-header h3 { margin: 0; font-size: 1.1rem; }
  .editor-hint { font-size: 0.8rem; color: #666; }
  
  .editor-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
  .view-toggles button, .batch-actions button { padding: 0.4rem 0.8rem; background: white; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .view-toggles button.active, .batch-actions button:active { background: #007bff; color: white; border-color: #007bff; }
  .batch-actions button:hover:not(:active) { background: #e9ecef; }
  .view-toggles, .batch-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; }

  .frame-container { transition: opacity 0.2s; }
  .frame-container.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px; }
  .frame-container.strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 10px; }
  @media (max-width: 600px) {
    .frame-container.strip { flex-direction: column; overflow-x: hidden; overflow-y: auto; max-height: 450px; }
    .frame-container.strip .frame-item { flex-direction: row; align-items: center; width: 100%; box-sizing: border-box; }
    .frame-container.strip .frame-image-wrapper { width: 90px; height: 90px; flex-shrink: 0; }
    .frame-container.strip .frame-controls-box { margin-left: 15px; flex: 1; display: flex; flex-direction: column; justify-content: center;}
  }

  .frame-item { 
    background: white; border: 1px solid #ddd; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 6px; 
    content-visibility: auto; contain-intrinsic-size: 110px 180px;
  }
  .frame-image-wrapper { position: relative; cursor: pointer; background: #e5e5e5; border-radius: 4px; overflow: hidden; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; user-select: none; }
  .frame-image-wrapper img { max-width: 100%; max-height: 100%; object-fit: contain; }
  
  .state-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; font-weight: bold; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  .state-overlay .icon { font-size: 1.5rem; line-height: 1; margin-bottom: 2px; }
  .state-overlay .text { font-size: 0.75rem; }
  .state-overlay.absorb { background: rgba(255, 170, 0, 0.6); } 
  .state-overlay.discard { background: rgba(220, 53, 69, 0.6); } 
  
  .frame-number { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.6); color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; line-height: 1; pointer-events: none;}
  
  .frame-controls-box { display: flex; flex-direction: column; gap: 4px; }
  .trim-controls { display: flex; justify-content: space-between; gap: 4px; }
  .trim-controls button { flex: 1; font-size: 0.7rem; padding: 3px 0; border: 1px solid #ccc; background: #f8f9fa; border-radius: 3px; cursor: pointer; color: #555; }
  .trim-controls button:hover { background: #e2e6ea; color: #000; }
  
  .duration-control { display: flex; align-items: center; justify-content: space-between; font-size: 0.8rem; color: #555; background: #f5f5f5; border-radius: 3px; padding: 2px 4px; border: 1px solid #eee; }
  .duration-control input { width: 50px; padding: 2px 4px; text-align: right; border: 1px solid #ccc; border-radius: 3px; font-size: 0.8rem;}
  .duration-control input:disabled { background: #e9ecef; cursor: not-allowed; }
  
  .loading-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.7); color: white; padding: 0.5rem 1rem; border-radius: 4px; font-weight: bold; }
  
  .warnings-container { margin: 1rem 0; text-align: center; }
  .warning-text { color: #dc3545; font-weight: bold; margin: 0 0 0.5rem 0; font-size: 0.95rem; }
  .notice-text { color: #000; font-weight: bold; margin: 0 0 0.5rem 0; font-size: 0.95rem; }

  .action-area { margin-top: 1rem; margin-bottom: 0.5rem; display: flex; justify-content: center; }
  .download-button { background: #28a745; color: white; border: none; padding: 1rem 4rem; font-size: 1.2rem; font-weight: bold; border-radius: 50px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: all 0.2s; }
  .download-button:hover:not(:disabled) { background: #218838; transform: translateY(-2px); }
  .download-button:disabled { background: #6c757d; cursor: not-allowed; }
  
  .zoom-modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.85); display: flex; justify-content: center; align-items: center; z-index: 1000; cursor: zoom-out; }
  .zoom-modal img { max-width: 90vw; max-height: 90vh; object-fit: contain; box-shadow: 0 0 20px rgba(0,0,0,0.5); background-color: #e5e5e5; background-image: linear-gradient(45deg, #d0d0d0 25%, transparent 25%), linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d0d0d0 75%), linear-gradient(-45deg, transparent 75%, #d0d0d0 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; }

  .batch-duration-input-wrapper { margin: 1.5rem 0; text-align: center; font-size: 1.2rem; }
  .batch-duration-input-wrapper input { width: 100px; padding: 0.5rem; font-size: 1.1rem; text-align: right; border: 1px solid #ccc; border-radius: 4px; }
  .modal-buttons { display: flex; gap: 1rem; }
  .modal-btn { flex: 1; padding: 0.75rem; border-radius: 4px; font-weight: bold; cursor: pointer; border: none; color: white; transition: background 0.2s; }
  .modal-btn.cancel { background: #6c757d; }
  .modal-btn.cancel:hover { background: #5a6268; }
  .modal-btn.apply { background: #007bff; }
  .modal-btn.apply:hover { background: #0056b3; }

  footer { text-align: center; margin-top: 3rem; padding-bottom: 2rem; color: #666; font-size: 0.95rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans JP", sans-serif; }
  footer a { color: #007bff; text-decoration: none; font-weight: bold; transition: color 0.2s; }
  footer a:hover { color: #0056b3; text-decoration: underline; }
  .license-link { margin-top: 0.5rem; }
  .license-link button { background: none; border: none; color: #6c757d; font-size: 0.85rem; cursor: pointer; text-decoration: underline; padding: 0; }
  .license-link button:hover { color: #007bff; }
  .license-box { background: white; padding: 2rem; border-radius: 8px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; text-align: left; color: #333; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
  .license-box h2 { margin-top: 0; font-size: 1.25rem; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
  .license-intro { font-size: 0.9rem; color: #666; margin-bottom: 1rem; }
  .license-list { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem; }
  .license-item { background: #f8f9fa; padding: 0.75rem; border-radius: 6px; border: 1px solid #e9ecef; }
  .license-item strong { font-size: 0.95rem; color: #007bff; }
  .license-item p { margin: 0.25rem 0 0 0; font-size: 0.85rem; color: #555; }
  .close-modal-btn { display: block; width: 100%; background: #007bff; color: white; border: none; padding: 0.75rem; border-radius: 4px; font-weight: bold; cursor: pointer; text-align: center; }
  .close-modal-btn:hover { background: #0056b3; }
</style>