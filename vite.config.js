import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [
    svelte(),
    wasm()
  ],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  // ★ ここから下を追記：WorkerをESモジュールとして出力し、Worker内でもWasmを処理できるようにする
  worker: {
    format: 'es',
    plugins: () => [
      wasm()
    ]
  }
})