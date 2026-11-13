export interface ModelManifest {
  Version: number;
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Expressions?: { Name: string; File: string }[];
    Motions?: Record<string, { File: string; FadeInTime?: number; FadeOutTime?: number }[]>;
  };
  Groups?: { Name: string; Target: string; Ids: string[] }[];
  Layout?: Record<string, number>;
}

export interface ModelPackage {
  manifest: ModelManifest;
  /** Paths are resolved relative to the manifest at import time. */
  files: Record<string, Blob>;
}

export function parseManifest(text: string): ModelManifest {
  const m = JSON.parse(text) as ModelManifest;
  const r = m?.FileReferences;
  if (m?.Version !== 3 || !r || typeof r.Moc !== 'string' || !/\.moc3$/i.test(r.Moc) || !Array.isArray(r.Textures) || !r.Textures.length || r.Textures.some(p => typeof p !== 'string' || !/\.(png|jpe?g|webp)$/i.test(p))) {
    throw new Error('需要 Cubism 3/4/5 的 model3.json、MOC3 和纹理文件');
  }
  if (r.Expressions && (!Array.isArray(r.Expressions) || r.Expressions.some(e => !e || typeof e.Name !== 'string' || typeof e.File !== 'string'))) throw new Error('表情清单格式不正确');
  if (r.Motions && (typeof r.Motions !== 'object' || Object.values(r.Motions).some(group => !Array.isArray(group) || group.some(m => !m || typeof m.File !== 'string')))) throw new Error('动作清单格式不正确');
  if (m.Groups && (!Array.isArray(m.Groups) || m.Groups.some(g => !g || !Array.isArray(g.Ids) || g.Ids.some(id => typeof id !== 'string')))) throw new Error('参数分组格式不正确');
  return m;
}

export function referencedFiles(m: ModelManifest): string[] {
  const r = m.FileReferences;
  return [...new Set([r.Moc, ...r.Textures, r.Physics, r.Pose,
    ...(r.Expressions ?? []).map(e => e.File),
    ...Object.values(r.Motions ?? {}).flat().map(m => m.File),
  ].filter((p): p is string => !!p))];
}

/** Resolve within the archive, never as a network URL or executable resource. */
export function resolvePath(manifestPath: string, reference: string): string {
  const path = reference.replaceAll('\\', '/');
  if (!path || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path) || /[?#\0]/.test(path)) throw new Error(`资源路径无效：${reference}`);
  const parts = manifestPath.replaceAll('\\', '/').split('/').slice(0, -1);
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) throw new Error(`资源路径越界：${reference}`); parts.pop(); }
    else parts.push(p);
  }
  return parts.join('/');
}
