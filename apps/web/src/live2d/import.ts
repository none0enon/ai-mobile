import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import type { CharacterLive2D } from '@app/shared';
import { uid } from '../utils/id';
import { defaultBindings } from './cues';
import { parseManifest, referencedFiles, resolvePath, type ModelPackage } from './model';

interface Source { size: number; read(): Promise<Blob> }
export interface ImportedModel { config: CharacterLive2D; model: ModelPackage }
const MAX_MODEL_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export async function readModelFiles(sources: Map<string, Source>, name: string, progress: (message: string) => void = () => {}): Promise<ImportedModel> {
  const manifests = [...sources.keys()].filter(p => /\.model3\.json$/i.test(p) && !p.startsWith('__MACOSX/'));
  if (manifests.length !== 1) throw new Error(manifests.length ? '包内有多个模型，请上传单个模型的 ZIP 或文件夹' : '找不到 .model3.json，请上传完整模型 ZIP 或文件夹');
  const path = manifests[0]!;
  const source = sources.get(path)!;
  if (source.size > MAX_JSON_BYTES) throw new Error('模型清单过大');
  const manifest = parseManifest(await (await source.read()).text());
  const refs = referencedFiles(manifest);
  if (refs.length > 2048) throw new Error('模型引用文件过多');
  let total = 0;
  for (const ref of refs) {
    const item = sources.get(resolvePath(path, ref));
    if (!item) throw new Error(`缺少模型资源：${ref}`);
    if (!Number.isSafeInteger(item.size) || item.size < 0) throw new Error(`资源大小无效：${ref}`);
    if (/\.json$/i.test(ref) && item.size > MAX_JSON_BYTES) throw new Error(`JSON 资源过大：${ref}`);
    total += item.size;
  }
  if (total > MAX_MODEL_BYTES) throw new Error('模型运行资源超过 512 MB，请缩小模型或纹理');
  const files: Record<string, Blob> = Object.create(null);
  let loaded = 0;
  // BlobReader reads selected ZIP ranges. PSD/CMO3/art/history are never inflated.
  await Promise.all(refs.map(async ref => {
    const blob = await sources.get(resolvePath(path, ref))!.read();
    if (blob.size !== sources.get(resolvePath(path, ref))!.size) throw new Error(`资源大小不一致：${ref}`);
    if (/\.json$/i.test(ref)) JSON.parse(await blob.text());
    files[ref] = blob;
    progress(`读取模型 ${++loaded}/${refs.length}`);
  }));
  const moc = new Uint8Array(await files[manifest.FileReferences.Moc]!.slice(0, 4).arrayBuffer());
  if (String.fromCharCode(...moc) !== 'MOC3') throw new Error('MOC3 文件损坏或格式不正确');
  return {
    config: { assetId: uid('live2d'), name: name.replace(/\.zip$/i, ''), bytes: total, fileCount: refs.length, ...defaultBindings(manifest) },
    model: { manifest, files },
  };
}

export async function importModel(input: File[], progress?: (message: string) => void): Promise<ImportedModel> {
  if (!input.length) throw new Error('请选择模型文件');
  const first = input[0]!;
  if (input.length === 1 && /\.zip$/i.test(first.name)) {
    const reader = new ZipReader(new BlobReader(first), { useWebWorkers: false });
    try {
      const entries = await reader.getEntries();
      const sources = new Map<string, Source>();
      for (const e of entries) {
        if (e.directory) continue;
        const path = e.filename.replaceAll('\\', '/');
        if (sources.has(path)) throw new Error(`ZIP 内有重复文件：${path}`);
        sources.set(path, { size: e.uncompressedSize, read: async () => {
          if (e.encrypted) throw new Error('请先解密模型 ZIP');
          return e.getData!(new BlobWriter(), { checkSignature: true });
        } });
      }
      return await readModelFiles(sources, first.name, progress);
    } finally { await reader.close(); }
  }
  const sources = new Map<string, Source>();
  for (const f of input) {
    const path = f.webkitRelativePath || f.name;
    if (sources.has(path)) throw new Error(`模型文件重名：${path}`);
    sources.set(path, { size: f.size, read: async () => f });
  }
  return readModelFiles(sources, first.webkitRelativePath?.split('/')[0] || first.name, progress);
}
