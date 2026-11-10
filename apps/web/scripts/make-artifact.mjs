/**
 * 把 `vite build --mode preview` 生成的单文件 HTML 改成 Claude Artifact 预览页需要的格式：
 * - 发布时会自动套上 <!doctype>/<html>/<head>/<body>，所以这里去掉外壳；
 * - <title> 放在最前面（只扫描前 8KB）；
 * - 样式在前、#app 居中、脚本在后（module 脚本本来就会等 DOM 解析完）。
 * 输出：apps/web/artifact/index.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../dist-preview/index.html');
const outDir = path.resolve(here, '../artifact');

const html = fs.readFileSync(src, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';

const styles = [...head.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]);
const scripts = [...head.matchAll(/<script[\s\S]*?<\/script>/gi), ...body.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0]);
const bodyMarkup = body.replace(/<script[\s\S]*?<\/script>/gi, '').trim();

if (!scripts.length || !styles.length) {
  console.error('make-artifact: 没找到内联的脚本或样式，确认是用 --mode preview（vite-plugin-singlefile）构建的');
  process.exit(1);
}

const out = [
  '<title>ai-mobile 界面预览</title>',
  '<meta name="description" content="AI 陪伴 App 的界面骨架：聊天、剧场立绘、七个陪伴场景、通话、回忆、设置（演示数据）">',
  ...styles,
  bodyMarkup,
  ...scripts,
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), out);
console.log(`make-artifact: ${(out.length / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), path.join(outDir, 'index.html'))}`);
