import { fileURLToPath, URL } from 'node:url';
import { VantResolver } from '@vant/auto-import-resolver';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import Components from 'unplugin-vue-components/vite';
import { defineConfig, type PluginOption } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * mode = preview：给 Claude Artifact 预览用的单文件构建（内存路由 + 所有资源内联）。
 * 其余 mode：正式 PWA / APK 资源（hash 路由，多文件）。
 */
export default defineConfig(({ mode }) => {
  const isPreview = mode === 'preview';
  const plugins: PluginOption[] = [
    // KaTeX 的字体只要 woff2（App 支持的浏览器都认）：不打包 woff / ttf，单文件预览页也小一圈
    {
      name: 'katex-woff2-only',
      enforce: 'pre',
      transform(code, id) {
        if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id.split('?')[0]!)) return null;
        return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g, '');
      },
    },
    vue(),
    UnoCSS(),
    // 只自动引入 Vant 组件；自己的组件一律显式 import，读代码时一眼能找到来源
    Components({ resolvers: [VantResolver()], dirs: [], dts: 'src/components.d.ts' }),
  ];
  if (isPreview) plugins.push(viteSingleFile({ removeViteModuleLoader: true }));

  return {
    base: './',
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    plugins,
    build: {
      outDir: isPreview ? 'dist-preview' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 2000,
    },
    server: { host: true, port: 5173 },
  };
});
