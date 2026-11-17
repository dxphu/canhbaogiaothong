import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmSigns, mapillarySigns, parseSignTag, splitBbox, HANOI_CORE, overpassQuery } from '../js/sources.js';
import { compactWays } from '../js/roads.js';
import { makeFixture } from './fixture.js';

test('biển OSM: lấy biển có direction, bỏ biển không rõ chiều', () => {
  const { signs, skipped } = osmSigns(makeFixture());
  assert.equal(signs.length, 1);
  assert.equal(signs[0].code, 'P.127');
  assert.equal(signs[0].value, 30);
  assert.ok(signs[0].heading <= 1 || signs[0].heading >= 359, `heading ${signs[0].heading}`); // Phố B hướng bắc
  assert.equal(skipped, 1);
});

test('parseSignTag', () => {
  assert.deepEqual(parseSignTag('VN:P.104'), [{ code: 'P.104' }]);
  assert.deepEqual(parseSignTag('VN:P.127[50];VN:P.123a'), [{ code: 'P.127', value: 50 }, { code: 'P.123a' }]);
  assert.deepEqual(parseSignTag('VN:P.127', { maxspeed: '40' }), [{ code: 'P.127', value: 40 }]);
  assert.deepEqual(parseSignTag('VN:P.127'), []);
  assert.deepEqual(parseSignTag('VN:W.207'), []);
});

test('biển Mapillary → mã QCVN, hướng xe = hướng mặt biển + 180', () => {
  const f = (id, v, dir) => ({ id, object_value: v, aligned_direction: dir, geometry: { type: 'Point', coordinates: [105.84, 21.02] } });
  const { signs, skipped } = mapillarySigns([
    f(1, 'regulatory--maximum-speed-limit-50--g1', 270),
    f(2, 'regulatory--end-of-maximum-speed-limit-50--g1', 90),
    f(3, 'regulatory--no-left-turn--g1', 0),
    f(4, 'regulatory--no-motorcycles--g1', 200),
    f(5, 'regulatory--no-motor-vehicles-except-motorcycles--g2', 10),
    f(6, 'regulatory--no-motor-vehicles--g1', 10),
    f(7, 'regulatory--keep-right--g1', 10),
    { id: 8, object_value: 'regulatory--no-entry--g1', geometry: { coordinates: [105.84, 21.02] } },
  ]);
  assert.deepEqual(signs.map((s) => [s.id, s.code, s.value, s.heading]), [
    ['m1', 'P.127', 50, 90],
    ['m2', 'DP.127', undefined, 270],
    ['m3', 'P.123a', undefined, 180],
    ['m4', 'P.104', undefined, 20],
    ['m5', 'P.103a', undefined, 190],
    ['m6', 'P.105', undefined, 190],
  ]);
  assert.equal(skipped, 2);
});

test('chia ô: Mapillary < 0.01 độ vuông, Overpass ~3 km', () => {
  for (const t of splitBbox(HANOI_CORE, 0.05)) assert.ok((t.n - t.s) * (t.e - t.w) < 0.01);
  assert.equal(splitBbox(HANOI_CORE, 0.03).length, 12);
  assert.match(overpassQuery(HANOI_CORE), /out body geom qt;/);
});

test('compactWays giữ tag cần thiết, bỏ phần còn lại', () => {
  const [w] = compactWays([{ type: 'way', id: 1, tags: { highway: 'residential', name: 'X', surface: 'asphalt', 'motorcycle:conditional': 'no @ (06:00-09:00)' }, geometry: [{ lat: 21.0000001, lon: 105.8 }, { lat: 21.001, lon: 105.8 }] }]);
  assert.deepEqual(w.t, { highway: 'residential', name: 'X', 'motorcycle:conditional': 'no @ (06:00-09:00)' });
  assert.deepEqual(w.g, [21, 105.8, 21.001, 105.8]);
});
