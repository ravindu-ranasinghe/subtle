import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(here, p);

/**
 * MV3 wants three different output shapes, so `pnpm build` runs Vite three
 * times over this one config:
 *
 *   main    — ESM: service worker, offscreen + popup pages, ASR/MT workers.
 *   content — classic script: content scripts cannot be modules.
 *   worklet — classic script: addModule() does not take a module graph.
 *
 * The two classic targets are IIFE single-entry builds, which is the only way
 * to guarantee Rollup emits no import statements and no shared chunks.
 */
const target = (process.env['SUBTLE_TARGET'] ?? 'main') as 'main' | 'content' | 'worklet';
const watch = process.env['SUBTLE_WATCH'] === '1';

/**
 * Transformers.js reaches for ORT's wasm with `new URL(..., import.meta.url)`,
 * which Vite turns into an emitted asset — a second, byte-identical copy of a
 * 21.6 MB file that nothing loads, because both workers point
 * `env.backends.onnx.wasm.wasmPaths` at dist/wasm instead. Drop it from the
 * bundle; copyExtensionAssets below puts the complete set there, loader .mjs
 * included, which Vite's partial emission does not.
 */
function dropDuplicateOrtWasm(): Plugin {
  return {
    name: 'subtle:drop-duplicate-ort-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && /ort-wasm.*\.wasm$/.test(fileName)) delete bundle[fileName];
      }
    },
  };
}

/** No remote code allowed in MV3: the ORT runtime ships inside the package. */
function copyExtensionAssets(): Plugin {
  return {
    name: 'subtle:copy-assets',
    apply: 'build',
    closeBundle() {
      const out = r('dist');
      mkdirSync(out, { recursive: true });
      copyFileSync(r('manifest.json'), resolve(out, 'manifest.json'));
      cpSync(r('licenses'), resolve(out, 'licenses'), { recursive: true });

      const candidates = [r('node_modules/onnxruntime-web/dist'), r('../node_modules/onnxruntime-web/dist')];
      const src = candidates.find(existsSync) ?? null;
      if (!src) {
        this.warn('onnxruntime-web not found: dist/wasm will be empty and ASR will not run');
        return;
      }
      const wasmDir = resolve(out, 'wasm');
      mkdirSync(wasmDir, { recursive: true });
      for (const f of readdirSync(src)) {
        // Only the runtime glue + binaries that wasmPaths points at; the
        // ort.*.mjs library bundles come in through the import graph.
        if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) cpSync(resolve(src, f), resolve(wasmDir, f));
      }
    },
  };
}

const inputs = {
  main: {
    sw: r('src/sw/index.ts'),
    'workers/asr': r('src/workers/asr/index.ts'),
    'workers/mt': r('src/workers/mt/index.ts'),
    'workers/tts': r('src/workers/tts/index.ts'),
    offscreen: r('offscreen.html'),
    popup: r('popup.html'),
  },
  content: { content: r('src/content/index.ts') },
  worklet: { 'worklets/resampler': r('src/worklets/resampler.ts') },
} as const;

export default defineConfig({
  root: here,
  // Everything is copied explicitly by the plugin above.
  publicDir: false,
  resolve: {
    alias: {
      '@subtle/shared/mocks': r('../shared/mocks/index.ts'),
      '@subtle/shared': r('../shared/index.ts'),
    },
  },
  build: {
    outDir: r('dist'),
    // Only the first pass clears dist; the classic passes add to it. In watch
    // mode all three run at once, so nobody gets to clear anything.
    emptyOutDir: target === 'main' && !watch,
    target: 'chrome128',
    sourcemap: true,
    minify: false,
    ...(watch ? { watch: {} } : {}),
    rollupOptions: {
      input: inputs[target],
      output:
        target === 'main'
          ? {
              format: 'es',
              entryFileNames: '[name].js',
              chunkFileNames: 'chunks/[name]-[hash].js',
              assetFileNames: 'assets/[name][extname]',
            }
          : { format: 'iife', entryFileNames: '[name].js', inlineDynamicImports: true },
    },
  },
  plugins: target === 'main' ? [dropDuplicateOrtWasm(), copyExtensionAssets()] : [],
});
