<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  let currentFile = null;
  let originalUrl = null;
  let processedUrl = null;
  
  let originalFramesUrls = [];
  let processedFramesUrls = [];
  let currentFrame = -1; 
  let zoomedSrc = null;
  
  let isProcessing = false;
  let isSaving = false;
  
  let resultStats = null;
  let worker;
  let currentJobId = 0;
  let debounceTimer;

  let settings = { mode: 'lossless', colors: 256, lossyQuality: 80 };
  let warningConfig = { enabled: true, limitStaticKB: 10, limitAnimatedKB: 64 };
  
  let isFreeColorMode = false;
  const colorPresets = [16, 32, 64, 128, 256];
  let presetIndex = 4;
  
  // ★ 非表示のファイル選択inputタグを参照するための変数
  let fileInput;

  $: if (!isFreeColorMode) {
    settings.colors = colorPresets[presetIndex];
  }

  function handleModeToggle(e) {
    isFreeColorMode = e.target.checked;
    if (!isFreeColorMode) {
      const closest = colorPresets.reduce((a, b) => 
        Math.abs(b - settings.colors) < Math.abs(a - settings.colors) ? b : a
      );
      presetIndex = colorPresets.indexOf(closest);
    }
  }

  $: if (currentFile && settings) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runWorker(false);
    }, 400);
  }

  function resetState() {
    currentFile = null;
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = null;
    if (processedUrl) URL.revokeObjectURL(processedUrl);
    processedUrl = null;
    
    originalFramesUrls.forEach(URL.revokeObjectURL);
    originalFramesUrls = [];
    processedFramesUrls.forEach(URL.revokeObjectURL);
    processedFramesUrls = [];
    
    currentFrame = -1;
    zoomedSrc = null;
    resultStats = null;
    isProcessing = false;
    isSaving = false;
    
    if (fileInput) fileInput.value = '';
  }

  onMount(() => {
    worker = new Worker(new URL('./imageWorker.js', import.meta.url), { type: 'module' });
    
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

          if (processedUrl) URL.revokeObjectURL(processedUrl);
          processedUrl = URL.createObjectURL(data.blob);
          
          originalFramesUrls.forEach(URL.revokeObjectURL);
          processedFramesUrls.forEach(URL.revokeObjectURL);
          originalFramesUrls = data.originalFrames ? data.originalFrames.map(b => URL.createObjectURL(b)) : [];
          processedFramesUrls = data.processedFrames ? data.processedFrames.map(b => URL.createObjectURL(b)) : [];
          
          if (currentFrame >= processedFramesUrls.length) currentFrame = -1;

          resultStats = {
            original: data.originalSize,
            processed: data.processedSize,
            isAnimated: data.isAnimated,
            width: data.width,
            height: data.height
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

  // ★ 共通のファイル処理関数
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
  
  // ★ タップ（クリック）でファイル選択ダイアログを開く
  function handleFileInputChange(event) {
    processSelectedFile(event.target.files[0]);
  }

  // ★ クリップボードからのペースト（Ctrl+V）に対応
  function handlePaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        processSelectedFile(file);
        break; // 最初の画像だけ処理する
      }
    }
  }

  function runWorker(isFinal = false) {
    if (!currentFile || !worker) return;
    if (isFinal) isSaving = true;
    else isProcessing = true;

    currentJobId = Date.now();
    worker.postMessage({
      jobId: currentJobId,
      file: currentFile,
      settings: { ...settings },
      isFinal: isFinal
    });
  }

  function handleDownloadClick() {
    runWorker(true);
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
    const ext = file.name.split('.').pop().toUpperCase();
    
    let format = ext;
    if (file.type === 'image/png') format = 'PNG';
    else if (file.type === 'image/webp') format = 'WebP';
    else if (file.type === 'image/gif') format = 'GIF';
    else if (file.type === 'image/jpeg') format = 'JPEG';

    if (isAnimated) {
      return `${format} (アニメーション)`;
    }
    return format;
  }

  $: limitKB = resultStats?.isAnimated ? warningConfig.limitAnimatedKB : warningConfig.limitStaticKB;
  $: isOverLimit = resultStats && (resultStats.processed / 1024) > limitKB;
  
  $: isSizeIncreased = resultStats && resultStats.processed > resultStats.original;
  $: sizeDiffPercent = resultStats ? Math.abs(Math.round((1 - resultStats.processed / resultStats.original) * 100)) : 0;
</script>

<!-- ★ 画面全体のどこでペーストしても反応するように設定 -->
<svelte:window on:paste={handlePaste} />

<main>
  <h1>カスタム絵文字コンプレッサー</h1>
  
  <!-- ★ 非表示のファイル選択 input -->
  <input 
    type="file" 
    accept="image/png, image/jpeg, image/webp, image/gif" 
    bind:this={fileInput} 
    on:change={handleFileInputChange} 
    style="display: none;" 
  />

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- ★ クリック（タップ）でファイル選択を開く処理を追加 -->
  <div class="dropzone" on:drop={handleDrop} on:dragover|preventDefault on:click={() => fileInput.click()}>
    <p>ここをクリックして画像を選択<br><small>またはドロップ、ペースト(Ctrl+V)</small></p>
    <p class="format-note">
      対応フォーマット: PNG (APNG), GIF, WebP, JPEG<br>
      上限: サイズ 10 MB / 解像度 2048×2048 px / アニメ 150 コマ
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
  </div>

  {#if originalUrl}
    <div class="preview-area">
      <h3>プレビュー</h3>
      
      <div class="comparison-container">
        <!-- 左: 元画像 -->
        <div class="image-box">
          <div class="size-label-container">
            <span class="label-title">オリジナル</span>
            <span class="label-value">{formatSize(currentFile.size)}</span>
            <span class="meta-info">
              {getFileFormat(currentFile, resultStats?.isAnimated)}
              {#if resultStats?.width}
                | {resultStats.width} × {resultStats.height} px
              {/if}
            </span>
          </div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <div class="image-container">
            <img 
              src={currentFrame === -1 ? originalUrl : originalFramesUrls[currentFrame]} 
              alt="元画像" 
              class="zoomable"
              draggable="false" 
              on:contextmenu|preventDefault
              on:click={() => zoomedSrc = (currentFrame === -1 ? originalUrl : originalFramesUrls[currentFrame])} 
            />
          </div>
        </div>

        <!-- 右: 処理後画像 -->
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
            {:else}
              <span class="label-value">計算中...</span>
            {/if}
          </div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <div class="image-container">
            <img 
              src={currentFrame === -1 ? (processedUrl || originalUrl) : processedFramesUrls[currentFrame]} 
              alt="プレビュー" 
              class="zoomable" 
              class:processing={isProcessing}
              draggable="false" 
              on:contextmenu|preventDefault
              on:click={() => zoomedSrc = (currentFrame === -1 ? (processedUrl || originalUrl) : processedFramesUrls[currentFrame])}
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
            <button class:active={currentFrame === -1} on:click={() => currentFrame = -1}>▶ アニメーション</button>
            <button class:active={currentFrame !== -1} on:click={() => currentFrame = currentFrame === -1 ? 0 : currentFrame}>⏸ コマ送りで比較</button>
          </div>
          
          {#if currentFrame !== -1}
            <div class="frame-slider">
              <input type="range" min="0" max={processedFramesUrls.length - 1} bind:value={currentFrame} />
              <span class="frame-counter">{currentFrame + 1} / {processedFramesUrls.length} コマ目</span>
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
          {#if isSaving}
            保存中...
          {:else}
            保存
          {/if}
        </button>
      </div>
    </div>
  {/if}

  {#if zoomedSrc}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="zoom-modal" on:click={() => zoomedSrc = null} transition:fade={{ duration: 150 }}>
      <img src={zoomedSrc} alt="拡大プレビュー" draggable="false" on:contextmenu|preventDefault />
    </div>
  {/if}
</main>

<style>
  main { max-width: 800px; margin: 2rem auto; font-family: sans-serif; padding: 0 1rem; }
  /* ★ ドロップエリアのホバーエフェクトなどを追加 */
  .dropzone { 
    border: 2px dashed #aaa; border-radius: 8px; padding: 3rem 1rem; text-align: center; 
    background: #fdfdfd; cursor: pointer; margin-bottom: 1.5rem; transition: background 0.2s; 
  }
  .dropzone:hover { background: #f0f8ff; border-color: #007bff; }
  .format-note { color: #666; font-size: 0.85rem; margin-top: 1rem; line-height: 1.5; }
  .safari-warning { color: #dc3545; font-size: 0.8rem; font-weight: bold; margin-top: 0.5rem; }
  
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
  
  .preview-area { text-align: center; margin-top: 1rem; }
  .comparison-container { display: flex; gap: 1rem; justify-content: center; align-items: stretch; margin-top: 1rem; }
  .image-box { flex: 1; max-width: 48%; display: flex; flex-direction: column; }
  .size-label-container { height: 4.5rem; display: flex; flex-direction: column; justify-content: flex-end; margin-bottom: 0.5rem; }
  .label-title { font-size: 0.9em; color: #555; }
  .label-value { font-size: 1.1em; }
  .label-value.highlight { color: #007bff; font-weight: bold; font-size: 1.2em; }
  .label-value.text-danger { color: #dc3545; }
  .label-sub { font-size: 0.8em; color: #666; }
  .label-sub.text-danger { color: #dc3545; font-weight: bold; }
  .meta-info { font-size: 0.75rem; color: #888; margin-top: 2px; }
  
  .image-container { 
    flex: 1; position: relative; padding: 1rem; border-radius: 8px; display: flex; justify-content: center; align-items: center;
    background-color: #e5e5e5;
    background-image: 
      linear-gradient(45deg, #d0d0d0 25%, transparent 25%), 
      linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), 
      linear-gradient(45deg, transparent 75%, #d0d0d0 75%), 
      linear-gradient(-45deg, transparent 75%, #d0d0d0 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  }
  .image-container img { max-width: 100%; max-height: 256px; transition: opacity 0.2s; }
  .image-container img.processing { opacity: 0.5; }
  .zoomable { cursor: zoom-in; }
  
  .frame-controls { margin-top: 1.5rem; padding: 1rem; background: #fdfdfd; border: 1px solid #ddd; border-radius: 8px; }
  .frame-buttons { display: flex; gap: 0.5rem; justify-content: center; margin-bottom: 1rem; }
  .frame-buttons button { padding: 0.5rem 1.5rem; border: 1px solid #ccc; background: white; cursor: pointer; border-radius: 4px; font-weight: bold; }
  .frame-buttons button.active { background: #6c757d; color: white; border-color: #6c757d; }
  .frame-slider { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
  .frame-counter { font-size: 0.9em; font-weight: bold; color: #555; }
  
  .loading-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.7); color: white; padding: 0.5rem 1rem; border-radius: 4px; font-weight: bold; }
  
  .warnings-container { margin-top: 1.5rem; }
  .warning-text { color: #dc3545; font-weight: bold; margin: 0.5rem 0; font-size: 0.95rem; }
  .notice-text { color: #000; font-weight: bold; margin: 0.5rem 0; font-size: 0.95rem; }

  .action-area { margin-top: 2rem; padding-top: 2rem; border-top: 1px solid #eee; }
  .download-button { background: #28a745; color: white; border: none; padding: 1rem 4rem; font-size: 1.2rem; font-weight: bold; border-radius: 50px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: all 0.2s; }
  .download-button:hover:not(:disabled) { background: #218838; transform: translateY(-2px); }
  .download-button:disabled { background: #6c757d; cursor: not-allowed; }
  
  .zoom-modal {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.85); display: flex; justify-content: center; align-items: center; z-index: 1000; cursor: zoom-out;
  }
  .zoom-modal img {
    max-width: 90vw; max-height: 90vh; object-fit: contain; box-shadow: 0 0 20px rgba(0,0,0,0.5);
    background-color: #e5e5e5;
    background-image: linear-gradient(45deg, #d0d0d0 25%, transparent 25%), linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d0d0d0 75%), linear-gradient(-45deg, transparent 75%, #d0d0d0 75%);
    background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  }
</style>