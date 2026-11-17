import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, isActiveAt, angleDiff } from '../js/engine.js';
import { demoSigns, simulateRoute } from './demo.js';

const at = (h, m = 0) => new Date(2026, 10, 17, h, m).getTime();

function run({ vehicle = 'motorbike', hour = 8, speed = 30, noise = 0, seed = 1 }) {
  const engine = new AlertEngine(demoSigns(), { vehicle });
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647); // ngẫu nhiên có seed
  const speedAt = typeof speed === 'function' ? speed : () => speed;
  const out = [];
  for (const fix of simulateRoute({ startTime: at(hour), speedAt, noise, rand })) {
    for (const a of engine.update(fix).alerts) out.push({ ...a, at: fix.travelled });
  }
  return out;
}
const ids = (alerts) => alerts.filter((a) => a.kind === 'sign').map((a) => a.sign.id);

test('xe máy giờ cao điểm: đọc đúng biển, đúng thứ tự', () => {
  assert.deepEqual(ids(run({ hour: 8 })), ['s1', 's2', 's3', 's6', 's8', 's9']);
});

test('ngoài khung giờ thì không đọc biển cấm theo giờ', () => {
  assert.deepEqual(ids(run({ hour: 12 })), ['s1', 's3', 's6', 's8', 's9']);
});

test('ô tô: đọc cấm ô tô, bỏ cấm xe máy', () => {
  assert.deepEqual(ids(run({ vehicle: 'car', hour: 8 })), ['s1', 's3', 's5', 's6', 's8', 's9']);
});

test('bỏ qua biển chiều ngược lại và biển ở đường song song', () => {
  const got = ids(run({ hour: 8 }));
  assert.ok(!got.includes('s4'));
  assert.ok(!got.includes('s7'));
});

test('cảnh báo trước biển trong khoảng 40–160 m', () => {
  for (const a of run({ hour: 8, speed: 40 }).filter((a) => a.kind === 'sign')) {
    assert.ok(a.distance > 0 && a.distance <= 160, `${a.sign.id}: ${a.distance}`);
  }
});

test('quá tốc độ chỉ sau khi đi qua biển 30, và hết sau biển DP.127', () => {
  // đoạn hướng bắc là mét 500–900 trên tuyến; biển 30 ở mét ~750, DP.127 ở mét ~1250
  const alerts = run({ hour: 12, speed: 40 });
  const over = alerts.filter((a) => a.kind === 'overspeed');
  assert.ok(over.length >= 1);
  assert.ok(over.every((a) => a.at > 745 && a.at < 1260), over.map((a) => a.at).join(','));
  assert.match(over[0].text, /tối đa 30/);
});

test('không báo quá tốc độ khi chạy 35 trong vùng 40', () => {
  const speed = (s) => (s < 500 ? 35 : 25);
  assert.equal(run({ hour: 12, speed }).filter((a) => a.kind === 'overspeed').length, 0);
});

test('GPS nhiễu ±5 m vẫn ra đúng danh sách biển', () => {
  for (let seed = 1; seed <= 20; seed++) {
    assert.deepEqual(ids(run({ hour: 8, noise: 5, seed })), ['s1', 's2', 's3', 's6', 's8', 's9'], `seed ${seed}`);
  }
});

test('câu đọc có khung giờ', () => {
  const a = run({ hour: 8 }).find((a) => a.sign?.id === 's2');
  assert.match(a.text, /^Cấm xe máy, từ 6 giờ đến 9 giờ và từ 16 giờ đến 19 giờ, \d+ mét nữa$/);
});

test('khung giờ qua nửa đêm', () => {
  const s = { times: [['22:00', '05:00']] };
  assert.equal(isActiveAt(s, new Date(2026, 0, 1, 23)), true);
  assert.equal(isActiveAt(s, new Date(2026, 0, 1, 4)), true);
  assert.equal(isActiveAt(s, new Date(2026, 0, 1, 12)), false);
});

test('angleDiff', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
});
