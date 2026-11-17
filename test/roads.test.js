import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../js/engine.js';
import { compactWays, buildRoadIndex, RoadMonitor, parseConditional, banFor, onewayFor, maxspeedFor } from '../js/roads.js';
import { simulateRoute } from './demo.js';
import { ORIGIN, makeFixture, makeParallelFixture } from './fixture.js';

const at = (h, m = 0) => new Date(2026, 10, 17, h, m).getTime(); // thứ Ba

function drive(route, { hour = 12, speed = 30, elements = makeFixture(), vehicle = 'motorbike', noise = 0, seed = 3 } = {}) {
  const index = buildRoadIndex(compactWays(elements));
  const engine = new AlertEngine([], { vehicle });
  const road = new RoadMonitor(index, vehicle);
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (const fix of simulateRoute({ origin: ORIGIN, route, speedAt: () => speed, startTime: at(hour), noise, rand })) {
    engine.update(fix);
    const lead = Math.min(160, Math.max(40, engine.speed * 6));
    const r = road.update(fix, engine.heading, engine.speed, lead);
    for (const a of r.alerts) out.push({ ...a, at: fix.travelled, road: r.road?.name });
  }
  return out;
}
const texts = (a) => a.map((x) => x.text);

test('đi hết tuyến đông–tây lúc 8h: tốc độ, phía trước cấm, đang trên đường cấm', () => {
  const a = drive([[-250, 0], [1350, 0]], { hour: 8 });
  const t = texts(a);
  assert.equal(t[0], 'Tốc độ tối đa 40');
  assert.ok(t.includes('Phía trước, Phố C cấm xe máy, từ 6 giờ đến 9 giờ và từ 16 giờ đến 19 giờ'), t.join(' | '));
  assert.ok(t.includes('Phố C cấm xe máy, từ 6 giờ đến 9 giờ và từ 16 giờ đến 19 giờ'));
  assert.ok(t.includes('Tốc độ tối đa 30'));
  assert.ok(t.includes('Phía trước, Phố D cấm xe máy'));
  assert.ok(t.includes('Phố D cấm xe máy'));
  const ahead = a.find((x) => x.text.startsWith('Phía trước, Phố C'));
  assert.ok(ahead.at > 400 && ahead.at < 850, `cảnh báo phía trước ở mét ${ahead.at}`); // Phố C bắt đầu ở mét 850
});

test('12h: Phố C không cấm, Phố D vẫn cấm', () => {
  const t = texts(drive([[-250, 0], [1350, 0]], { hour: 12 }));
  assert.ok(!t.some((s) => s.includes('Phố C cấm')));
  assert.ok(t.includes('Phố D cấm xe máy'));
});

test('ô tô: không có cảnh báo cấm xe máy', () => {
  const t = texts(drive([[-250, 0], [1350, 0]], { hour: 8, vehicle: 'car' }));
  assert.ok(!t.some((s) => s.includes('cấm')), t.join(' | '));
});

test('đi ngược chiều Phố B (một chiều lên bắc) thì cảnh báo', () => {
  const a = drive([[300, 350], [300, -350]]);
  const w = a.filter((x) => x.kind === 'wrongway');
  assert.ok(w.length >= 1);
  assert.equal(w[0].text, 'Đang đi ngược chiều trên Phố B. Đường một chiều');
  assert.ok(w[0].at < 40, `báo muộn: mét ${w[0].at}`);
});

test('đi đúng chiều Phố B thì không cảnh báo', () => {
  assert.equal(drive([[300, -350], [300, 350]]).filter((x) => x.kind === 'wrongway').length, 0);
});

test('rẽ từ Phố A vào Phố B ngược chiều: cảnh báo phía trước hoặc ngay khi vào', () => {
  const a = drive([[-200, 0], [300, 0], [300, -350]]);
  assert.ok(a.some((x) => x.kind === 'wrongway'), texts(a).join(' | '));
});

test('có đường hai chiều sát bên (8 m) thì không kết luận ngược chiều', () => {
  const a = drive([[304, 350], [304, -350]], { elements: makeParallelFixture() });
  assert.equal(a.filter((x) => x.kind === 'wrongway').length, 0);
});

test('GPS nhiễu ±5 m: vẫn báo ngược chiều, không báo nhầm khi đi đúng chiều', () => {
  for (let seed = 1; seed <= 15; seed++) {
    assert.ok(drive([[300, 350], [300, -350]], { noise: 5, seed }).some((x) => x.kind === 'wrongway'), `seed ${seed}`);
    assert.equal(drive([[300, -350], [300, 350]], { noise: 5, seed }).filter((x) => x.kind === 'wrongway').length, 0, `seed ${seed}`);
    assert.equal(drive([[-250, 0], [550, 0]], { noise: 5, seed }).filter((x) => x.kind === 'wrongway').length, 0, `seed ${seed}`);
  }
});

test('parseConditional', () => {
  const r = parseConditional('no @ (Mo-Fr 06:00-09:00,16:00-19:00); yes @ (Su)');
  assert.equal(r.length, 2);
  assert.equal(r[0].value, 'no');
  assert.deepEqual([...r[0].days].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(r[0].times, [['06:00', '09:00'], ['16:00', '19:00']]);
  assert.deepEqual(parseConditional('no @ (6:00-9:00)')[0].times, [['06:00', '09:00']]);
});

test('banFor theo ngày trong tuần', () => {
  const t = { 'motorcycle:conditional': 'no @ (Mo-Fr 06:00-09:00)' };
  assert.equal(banFor(t, 'motorbike', new Date(2026, 10, 17, 7)).banned, true);  // thứ Ba
  assert.equal(banFor(t, 'motorbike', new Date(2026, 10, 22, 7)).banned, false); // Chủ nhật
  assert.equal(banFor({ highway: 'motorway' }, 'motorbike', new Date()).banned, true);
  assert.equal(banFor({ highway: 'motorway' }, 'car', new Date()).banned, false);
});

test('onewayFor và maxspeedFor', () => {
  assert.equal(onewayFor({ oneway: 'yes', 'oneway:motorcycle': 'no' }, 'motorbike'), 0);
  assert.equal(onewayFor({ oneway: 'yes', 'oneway:motorcycle': 'no' }, 'car'), 1);
  assert.equal(onewayFor({ junction: 'roundabout' }, 'motorbike'), 1);
  assert.equal(onewayFor({ oneway: '-1' }, 'motorbike'), -1);
  assert.equal(maxspeedFor({ maxspeed: '60', 'maxspeed:motorcycle': '50' }, 'motorbike', 1), 50);
  assert.equal(maxspeedFor({ maxspeed: '60', 'maxspeed:motorcycle': '50' }, 'car', 1), 60);
  assert.equal(maxspeedFor({ 'maxspeed:forward': '50', 'maxspeed:backward': '40' }, 'car', -1), 40);
});
