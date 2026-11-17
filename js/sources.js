// Tải dữ liệu từ OpenStreetMap (Overpass API) và Mapillary, chuyển sang định dạng của app.
import { SIGN_TYPES, bearing } from './engine.js';
import { parseSpeed } from './roads.js';

export const HANOI_CORE = { s: 20.98, w: 105.78, n: 21.07, e: 105.88 }; // nội thành: Hoàn Kiếm, Ba Đình, Đống Đa, HBT, Tây Hồ, Cầu Giấy, Thanh Xuân

export function bboxAround(p, km) {
  const dLat = km / 111;
  const dLng = km / (111 * Math.cos((p.lat * Math.PI) / 180));
  return { s: p.lat - dLat, w: p.lng - dLng, n: p.lat + dLat, e: p.lng + dLng };
}

export function splitBbox(b, step) {
  const out = [];
  for (let s = b.s; s < b.n - 1e-9; s += step) {
    for (let w = b.w; w < b.e - 1e-9; w += step) {
      out.push({ s, w, n: Math.min(b.n, s + step), e: Math.min(b.e, w + step) });
    }
  }
  return out;
}

const HW = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street';

export function overpassQuery(b) {
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  return `[out:json][timeout:90];
(
  way["highway"~"^(${HW})$"](${bb});
  way["highway"="service"]["service"!~"parking_aisle|drive-through|driveway"](${bb});
  node["traffic_sign"](${bb});
);
out body geom qt;`;
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function fetchOverpassTile(b) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(b)), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return (await res.json()).elements || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Tải theo ô ~3 km để tránh Overpass báo quá tải. onProgress(i, n)
export async function fetchOsm(bbox, onProgress = () => {}) {
  const tiles = splitBbox(bbox, 0.03);
  const seen = new Set();
  const elements = [];
  for (let i = 0; i < tiles.length; i++) {
    onProgress(i, tiles.length);
    for (const e of await fetchOverpassTile(tiles[i])) {
      const k = e.type + e.id;
      if (seen.has(k)) continue;
      seen.add(k);
      elements.push(e);
    }
  }
  onProgress(tiles.length, tiles.length);
  return elements;
}

// ---------- Biển báo từ OSM ----------

export function parseSignTag(value, tags = {}) {
  const out = [];
  for (const part of String(value).split(/[;,]/)) {
    const m = /^\s*(?:VN:)?(DP|P)\.?(\d{3}[a-z]?)(?:\[(\d+)\])?\s*$/i.exec(part);
    if (!m) continue;
    const code = `${m[1].toUpperCase()}.${m[2].toLowerCase()}`;
    if (!SIGN_TYPES[code]) continue;
    const sign = { code };
    if (SIGN_TYPES[code].isLimit) {
      sign.value = m[3] ? +m[3] : parseSpeed(tags.maxspeed);
      if (!sign.value) continue;
    }
    out.push(sign);
  }
  return out;
}

// Biển OSM chỉ dùng được khi nằm trên đường và có direction=forward/backward (biết áp dụng cho chiều nào)
export function osmSigns(elements) {
  const nodeWay = new Map();
  for (const e of elements) {
    if (e.type !== 'way' || !e.nodes || !e.geometry) continue;
    e.nodes.forEach((id, i) => { if (!nodeWay.has(id)) nodeWay.set(id, { g: e.geometry, i }); });
  }
  const signs = [];
  let skipped = 0;
  for (const e of elements) {
    if (e.type !== 'node' || !e.tags?.traffic_sign) continue;
    const parsed = parseSignTag(e.tags.traffic_sign, e.tags);
    const dir = e.tags.direction ?? e.tags['traffic_sign:direction'];
    const w = nodeWay.get(e.id);
    if (!parsed.length || !w || (dir !== 'forward' && dir !== 'backward')) { skipped++; continue; }
    const a = w.g[w.i === 0 ? 0 : w.i - 1], b = w.g[w.i === 0 ? 1 : w.i];
    if (!a || !b) { skipped++; continue; }
    let heading = bearing({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon });
    if (dir === 'backward') heading = (heading + 180) % 360;
    parsed.forEach((p, k) => signs.push({ id: `o${e.id}-${k}`, ...p, lat: e.lat, lng: e.lon, heading: Math.round(heading), source: 'osm' }));
  }
  return { signs, skipped };
}

// ---------- Biển báo từ Mapillary ----------

const MLY_RULES = [
  [/end-of-(maximum-)?speed-limit/, () => ({ code: 'DP.127' })],
  [/maximum-speed-limit-(\d+)/, (m) => ({ code: 'P.127', value: +m[1] })],
  [/no-left-turn-or-u-turn|no-left-turn-and-u-turn/, () => ({ code: 'P.124c' })],
  [/no-left-turn/, () => ({ code: 'P.123a' })],
  [/no-right-turn/, () => ({ code: 'P.123b' })],
  [/no-u-turn/, () => ({ code: 'P.124a' })],
  [/no-entry/, () => ({ code: 'P.102' })],
  [/no-motorcycles/, () => ({ code: 'P.104' })],
  [/no-motor-vehicles-except-motorcycles/, () => ({ code: 'P.103a' })],
  [/no-motor-vehicles/, () => ({ code: 'P.105' })],
];

// Mapillary trả aligned_direction = hướng mặt biển nhìn ra. Xe đi ngược hướng đó mới thấy biển.
export const MLY_HEADING_OFFSET = 180;

export function mapillarySigns(features) {
  const signs = [];
  let skipped = 0;
  for (const f of features) {
    const v = f.object_value || '';
    const coords = f.geometry?.coordinates;
    if (f.aligned_direction == null || !coords) { skipped++; continue; }
    let sign = null;
    for (const [re, make] of MLY_RULES) {
      const m = re.exec(v);
      if (m) { sign = make(m); break; }
    }
    if (!sign) { skipped++; continue; }
    signs.push({
      id: `m${f.id}`,
      ...sign,
      lat: coords[1],
      lng: coords[0],
      heading: Math.round((f.aligned_direction + MLY_HEADING_OFFSET) % 360),
      source: 'mapillary',
    });
  }
  return { signs, skipped };
}

export async function fetchMapillary(bbox, token, onProgress = () => {}) {
  const tiles = splitBbox(bbox, 0.05); // API giới hạn bbox < 0.01 độ vuông
  const features = [];
  for (let i = 0; i < tiles.length; i++) {
    onProgress(i, tiles.length);
    const t = tiles[i];
    const url = `https://graph.mapillary.com/map_features?access_token=${encodeURIComponent(token)}`
      + `&fields=id,object_value,geometry,aligned_direction&object_values=regulatory--*&limit=2000`
      + `&bbox=${t.w},${t.s},${t.e},${t.n}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Token Mapillary không hợp lệ' : `Mapillary ${res.status}`);
    const json = await res.json();
    features.push(...(json.data || []));
  }
  onProgress(tiles.length, tiles.length);
  return features;
}
