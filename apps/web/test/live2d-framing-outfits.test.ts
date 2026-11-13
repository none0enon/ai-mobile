import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaBounds, fitSilhouette } from '../src/live2d/framing';
import { outfitScene, selectOutfit, suggestedOutfits } from '../src/live2d/outfits';

test('off-centre, wide and full-body silhouettes keep their proportions and meet the bottom edge', () => {
  for (const bounds of [
    { left: 14, right: 18, bottom: -7, top: -2 },
    { left: -0.4, right: 0.4, bottom: -1.6, top: 1.4 },
    { left: -3, right: 4, bottom: 2, top: 3 },
  ]) for (const [width, height] of [[390, 500], [844, 260], [320, 380]]) {
    const fit = fitSilhouette(bounds, width!, height!);
    assert.ok(Math.abs(fit.x * width! - fit.y * height!) < 1e-9, 'no aspect-ratio distortion');
    assert.ok(Math.abs(bounds.bottom * fit.y + fit.ty + 1) < 1e-9, 'visible lower edge is grounded');
    assert.ok(bounds.top * fit.y + fit.ty <= 1);
    assert.ok(bounds.left * fit.x + fit.tx >= -1 && bounds.right * fit.x + fit.tx <= 1);
    const zoom = fitSilhouette(bounds, width!, height!, 1.3);
    assert.ok(Math.abs(bounds.bottom * zoom.y + zoom.ty + 1) < 1e-9, 'manual zoom preserves bottom anchor');
  }
});

test('calibration ignores transparent padding and faint texture noise', () => {
  const pixels = new Uint8Array(10 * 20 * 4);
  pixels[3] = 10;
  for (let y = 4; y < 18; y++) for (let x = 2; x < 8; x++) pixels[(y * 10 + x) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(pixels, 10, 20), { left: 2, right: 8, bottom: 4, top: 18 });
  assert.equal(alphaBounds(new Uint8Array(16), 2, 2), undefined);
});

const madaraParameters = ['ParamGestureLive', 'ParamGestureRaise', 'ParamGestureFold', 'ParamOutfitPose'].map(id => ({ id, name: id, min: 0, max: 5, default: 0 }));
const outfits = suggestedOutfits(madaraParameters);

test('rhythm garments match names or explicit aliases before the saved fallback', () => {
  const config = { outfits, defaultOutfit: 'clan' };
  assert.equal(selectOutfit(config, { name: '赤色铠甲', tags: '' })?.id, 'armour');
  assert.equal(selectOutfit(config, { name: '出战', tags: 'red_armor, long_hair' })?.id, 'armour');
  assert.equal(selectOutfit(config, { name: '宇智波族服', tags: '' })?.id, 'clan');
  assert.equal(selectOutfit(config, { name: '校服', tags: 'school_uniform' })?.id, 'clan');
  assert.equal(selectOutfit(config, { name: '', tags: 'armorless' })?.id, 'clan');
  assert.equal(selectOutfit(config)?.id, 'clan');
  assert.equal(selectOutfit({ outfits, defaultOutfit: 'deleted' })?.id, 'armour');
  assert.equal(selectOutfit({}, undefined, outfits)?.id, 'armour', 'existing uploads migrate lazily');
  assert.equal(selectOutfit({})?.id, undefined);
  assert.equal(selectOutfit({ outfits: [...outfits, { id: 'special', name: '赤色铠甲', match: '', parameters: {} }] }, { name: '赤色铠甲', tags: 'armor' })?.id, 'special');
});

test('generic clothing selectors preserve defaults; unrelated moving parts are not outfits', () => {
  const choices = suggestedOutfits([
    { id: 'ParamClothes', name: '服装', min: 0, max: 2, default: 1 },
    { id: 'ParamSkirtSway', name: '衣服摆动', min: -1, max: 1, default: 0 },
    { id: 'ParamAngleX', name: '角度', min: -30, max: 30, default: 0 },
  ]);
  assert.equal(choices.length, 3);
  assert.deepEqual(choices[0]!.parameters, { ParamClothes: 1 });
  assert.deepEqual(choices[1]!.parameters, { ParamClothes: 0 });
  assert.deepEqual(suggestedOutfits([]), [{ id: 'model-default', name: '模型原装', match: '', parameters: {} }]);
});

test('current rhythm activity chooses the relevant daily outfit category', () => {
  const scene = (status: string) => outfitScene({ from: '00:00', to: '24:00', locationId: 'custom-place', status });
  assert.equal(scene('睡觉中'), 'sleep');
  assert.equal(scene('在体育馆训练'), 'exercise');
  assert.equal(scene('出门约会'), 'date');
  assert.equal(scene('在图书馆读书'), null);
  assert.equal(outfitScene(), null);
});
