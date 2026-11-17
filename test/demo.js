// Dữ liệu MẪU để thử logic — vị trí biển là giả lập, không phải biển thật ngoài đường.
import { offset } from '../js/engine.js';

export const ORIGIN = { lat: 21.0285, lng: 105.8542 };

// Tuyến mẫu (mét, x: đông, y: bắc): đi đông 500 m, rẽ trái lên bắc 400 m, rẽ phải đi đông 400 m
export const ROUTE_XY = [[0, 0], [500, 0], [500, 400], [900, 400]];

// heading = hướng xe đi mà biển áp dụng (90 = đi về phía đông, 0 = đi về phía bắc, 270 = phía tây)
export const SIGNS_XY = [
  { id: 's1', code: 'P.127', value: 40, x: 120, y: -6, heading: 90 },
  { id: 's2', code: 'P.104', x: 300, y: -6, heading: 90, times: [['06:00', '09:00'], ['16:00', '19:00']] },
  { id: 's3', code: 'P.123b', x: 485, y: -6, heading: 90 },
  { id: 's4', code: 'P.102', x: 240, y: 6, heading: 270, note: 'Biển cho chiều ngược lại — không được đọc' },
  { id: 's5', code: 'P.103a', x: 506, y: 150, heading: 0, note: 'Chỉ cấm ô tô' },
  { id: 's6', code: 'P.127', value: 30, x: 506, y: 250, heading: 0 },
  { id: 's7', code: 'P.124a', x: 300, y: -45, heading: 90, note: 'Đường song song cách 45 m — không được đọc' },
  { id: 's8', code: 'P.124a', x: 700, y: 394, heading: 90 },
  { id: 's9', code: 'DP.127', x: 850, y: 394, heading: 90 },
];

export const demoSigns = (origin = ORIGIN) =>
  SIGNS_XY.map(({ x, y, ...s }) => ({ ...s, ...offset(origin, x, y), x, y }));

// Sinh chuỗi điểm GPS dọc tuyến. speedAt(metersTravelled) trả về km/h. noise: độ lệch GPS (mét).
export function* simulateRoute({ origin = ORIGIN, route = ROUTE_XY, speedAt = () => 30, dt = 1, startTime, noise = 0, rand = Math.random }) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const [x1, y1] = route[i - 1], [x2, y2] = route[i];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segs.push({ x1, y1, x2, y2, len, start: total });
    total += len;
  }
  let s = 0, t = startTime;
  while (s <= total) {
    const seg = segs.find((g) => s <= g.start + g.len) || segs[segs.length - 1];
    const k = (s - seg.start) / seg.len;
    const x = seg.x1 + (seg.x2 - seg.x1) * k + (rand() * 2 - 1) * noise;
    const y = seg.y1 + (seg.y2 - seg.y1) * k + (rand() * 2 - 1) * noise;
    const kmh = speedAt(s);
    yield { ...offset(origin, x, y), x, y, speed: kmh / 3.6, heading: null, time: t, travelled: s, total };
    s += (kmh / 3.6) * dt;
    t += dt * 1000;
  }
}
