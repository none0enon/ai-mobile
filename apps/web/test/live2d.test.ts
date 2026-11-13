import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { defaultBindings, dialogueCue, gestureFor, mouthLevel } from '../src/live2d/cues';
import { GestureMotion } from '../src/live2d/gesture';
import { importModel, readModelFiles } from '../src/live2d/import';
import { parseManifest, resolvePath } from '../src/live2d/model';

const manifest = {
  Version: 3,
  FileReferences: {
    Moc: 'avatar.moc3', Textures: ['textures/0.png'],
    Expressions: [{ Name: 'calm', File: 'calm.exp3.json' }, { Name: 'smirk', File: 'smirk.exp3.json' }, { Name: 'angry', File: 'angry.exp3.json' }],
    Motions: { Nod: [{ File: 'nod.motion3.json' }], Shake: [{ File: 'shake.motion3.json' }] },
  },
};
function sources() {
  const items = {
    'full/model/avatar.model3.json': JSON.stringify(manifest),
    'full/model/avatar.moc3': 'MOC3data', 'full/model/textures/0.png': 'png',
    'full/model/calm.exp3.json': '{}', 'full/model/smirk.exp3.json': '{}', 'full/model/angry.exp3.json': '{}',
    'full/model/nod.motion3.json': '{}', 'full/model/shake.motion3.json': '{}',
  };
  return new Map(Object.entries(items).map(([name, value]) => [name, { size: new Blob([value]).size, read: async () => new Blob([value]) }]));
}

test('imports only referenced data from nested packages', async () => {
  const map = sources();
  map.set('full/art/source.psd', { size: 800000000, read: async () => { throw new Error('must never inflate editor assets'); } });
  map.set('full/runtime/untrusted.js', { size: 10, read: async () => { throw new Error('must never execute uploaded scripts'); } });
  const result = await readModelFiles(map, 'test.zip');
  assert.equal(result.config.fileCount, 7);
  assert.deepEqual(Object.keys(result.model.files).sort(), ['avatar.moc3', 'textures/0.png', 'calm.exp3.json', 'smirk.exp3.json', 'angry.exp3.json', 'nod.motion3.json', 'shake.motion3.json'].sort());
  assert.equal(result.config.expressionMap.smile, 'smirk');
  assert.equal(result.config.motionMap.agree, 'Nod:0');
});

test('actual ZIP imports and folder imports have identical references', async () => {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await Promise.all([...sources()].map(async ([path, source]) => writer.add(path, new BlobReader(await source.read()))));
  await writer.add('full/art/source.psd', new TextReader('ignore'));
  const zip = new File([await writer.close()], 'test.zip');
  const result = await importModel([zip]);
  assert.equal(result.config.fileCount, 7);
  assert.equal(result.model.files['avatar.moc3']!.size, 8);
});

test('missing resources and ambiguous manifests fail before storage', async () => {
  const map = sources();
  map.delete('full/model/textures/0.png');
  await assert.rejects(readModelFiles(map, 'broken'), /缺少模型资源/);
  map.set('extra.model3.json', map.get('full/model/avatar.model3.json')!);
  await assert.rejects(readModelFiles(map, 'ambiguous'), /多个模型/);
});

test('invalid MOC, external references, traversal, and oversized runtime fail', async () => {
  const map = sources();
  map.set('full/model/avatar.moc3', { size: 8, read: async () => new Blob(['BAD!data']) });
  await assert.rejects(readModelFiles(map, 'broken'), /MOC3 文件损坏/);
  for (const p of ['https://example.com/model.moc3', '//remote/file', '../../../file', 'file?query', 'data:bad']) assert.throws(() => resolvePath('a/b.model3.json', p));
  assert.equal(resolvePath('a/models/model.model3.json', '../texture.png'), 'a/texture.png');
  assert.throws(() => parseManifest('{}'));
  map.set('full/model/avatar.moc3', { size: 600 * 1024 * 1024, read: async () => { throw new Error('must not allocate'); } });
  await assert.rejects(readModelFiles(map, 'huge'), /超过 512 MB/);
});

test('emotion and dialogue map only to available expressions and motions', () => {
  const bindings = defaultBindings(manifest);
  assert.equal(bindings.expressionMap.neutral, 'calm');
  assert.equal(bindings.expressionMap.smile, 'smirk');
  assert.equal(bindings.expressionMap.angry, 'angry');
  assert.equal(bindings.motionMap.disagree, 'Shake:0');
  assert.equal(dialogueCue('不可以，别这样'), 'disagree');
  assert.equal(gestureFor('angry'), 'crossed');
  assert.equal(gestureFor('smile', '你好呀'), 'wave');
  assert.equal(mouthLevel(1, false), 0);
  assert.equal(mouthLevel(NaN, true), 0);
  assert.equal(mouthLevel(0.01, true), 0);
  assert.equal(mouthLevel(0.8, true), 0.8);
});

test('a new gesture retargets immediately and remains continuous', () => {
  const g = new GestureMotion();
  g.setTarget('wave');
  for (let i = 0; i < 20; i++) g.update(1 / 60);
  const before = g.raise;
  g.setTarget('crossed');
  assert.equal(g.target, 'crossed');
  assert.equal(g.raise, before);
  for (let i = 0; i < 240; i++) {
    g.update(1 / 60);
    assert.ok(g.raise >= 0 && g.fold >= 0 && g.raise + g.fold <= 1.000001);
  }
  assert.ok(g.fold > 0.99 && g.raise < 0.01);
});
