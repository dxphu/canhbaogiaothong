// Dữ liệu OSM giả lập theo đúng định dạng Overpass (out body geom) để test.
import { offset } from '../js/engine.js';

export const ORIGIN = { lat: 21.02, lng: 105.84 };

let nid = 1000;
function way(id, tags, pts, origin) {
  const nodes = [], geometry = [];
  for (const [x, y] of pts) {
    const p = offset(origin, x, y);
    nodes.push(nid++);
    geometry.push({ lat: p.lat, lon: p.lng });
  }
  return { type: 'way', id, tags: { highway: 'residential', ...tags }, nodes, geometry };
}
const line = (x1, y1, x2, y2, step = 100) => {
  const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
  return Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
};

// Tuyến đông–tây: Phố A (hai chiều, 40) → Phố C (cấm xe máy giờ cao điểm) → Phố D (cấm xe máy)
// Phố B: một chiều đi lên phía bắc, cắt Phố A tại x=300
export function makeFixture(origin = ORIGIN, { conditional = true } = {}) {
  nid = 1000;
  const A = way(1, { name: 'Phố A', maxspeed: '40', highway: 'tertiary' }, line(-300, 0, 600, 0), origin);
  const C = way(3, { name: 'Phố C', maxspeed: '30', ...(conditional ? { 'motorcycle:conditional': 'no @ (06:00-09:00,16:00-19:00)' } : { motorcycle: 'no' }) }, line(600, 0, 1000, 0), origin);
  const D = way(4, { name: 'Phố D', motorcycle: 'no' }, line(1000, 0, 1400, 0), origin);
  const B = way(2, { name: 'Phố B', oneway: 'yes' }, line(300, -400, 300, 400), origin);
  const signOnB = B.nodes[1]; // (300, -300)
  const noDir = B.nodes[2];
  const nodes = [
    { type: 'node', id: signOnB, lat: B.geometry[1].lat, lon: B.geometry[1].lon, tags: { traffic_sign: 'VN:P.127[30]', direction: 'forward' } },
    { type: 'node', id: noDir, lat: B.geometry[2].lat, lon: B.geometry[2].lon, tags: { traffic_sign: 'VN:P.123a' } },
  ];
  return [A, B, C, D, ...nodes];
}

// Thêm một đường hai chiều chạy song song sát Phố B (cách 8 m) để test trường hợp không chắc chắn
export function makeParallelFixture(origin = ORIGIN) {
  const base = makeFixture(origin);
  nid = 5000;
  return [...base, way(9, { name: 'Ngõ song song' }, line(308, -400, 308, 400), origin)];
}
