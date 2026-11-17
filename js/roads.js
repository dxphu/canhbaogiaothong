// Cảnh báo theo dữ liệu đường OSM: đi ngược chiều đường một chiều, đường cấm xe máy (kể cả theo giờ),
// đường phía trước, giới hạn tốc độ của đoạn đường đang đi.
import { angleDiff, bearing, isActiveAt, offset, timesText } from './engine.js';

const VNAME = { motorbike: 'xe máy', car: 'ô tô' };

// ---------- Đọc tag OSM ----------

const KEEP = /^(highway|name|oneway|oneway:motorcycle|oneway:moped|junction|maxspeed|maxspeed:forward|maxspeed:backward|maxspeed:motorcycle|motorcycle|motor_vehicle|vehicle|access|motorcar)(:conditional)?$/;

// Rút gọn kết quả Overpass để lưu trên máy: { id, t: tag cần dùng, g: [lat, lng, lat, lng, ...] }
export function compactWays(elements) {
  const out = [];
  for (const e of elements) {
    if (e.type !== 'way' || !e.tags?.highway || !Array.isArray(e.geometry)) continue;
    const g = [];
    for (const p of e.geometry) {
      if (!p) continue;
      g.push(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6);
    }
    if (g.length < 4) continue;
    const t = {};
    for (const k in e.tags) if (KEEP.test(k)) t[k] = e.tags[k];
    out.push({ id: e.id, t, g });
  }
  return out;
}

// 1: một chiều theo thứ tự node, -1: một chiều ngược thứ tự node, 0: hai chiều
export function onewayFor(t, vehicle) {
  if (vehicle === 'motorbike') {
    const ex = t['oneway:motorcycle'] ?? t['oneway:moped'];
    if (ex === 'no') return 0;
  }
  const o = t.oneway;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no') return 0;
  if (t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular') return 1;
  return 0;
}

export function parseSpeed(v) {
  if (!v) return null;
  const m = /^\s*(\d+)\s*(mph)?/.exec(String(v));
  if (!m) return null;
  return m[2] ? Math.round(+m[1] * 1.609) : +m[1];
}

export function maxspeedFor(t, vehicle, dir) {
  if (vehicle === 'motorbike') {
    const v = parseSpeed(t['maxspeed:motorcycle']);
    if (v != null) return v;
  }
  const dv = parseSpeed(t[dir === -1 ? 'maxspeed:backward' : 'maxspeed:forward']);
  return dv ?? parseSpeed(t.maxspeed);
}

const DAYS = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };

function parseDays(spec) {
  const set = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-');
    if (b == null) { set.add(DAYS[a]); continue; }
    for (let d = DAYS[a]; ; d = (d + 1) % 7) { set.add(d); if (d === DAYS[b]) break; }
  }
  return set;
}

// "no @ (Mo-Fr 06:00-09:00,16:00-19:00); yes @ (Su)" → [{ value, days, times }]
export function parseConditional(str) {
  if (!str) return [];
  const out = [];
  for (const raw of str.split(';')) {
    const m = /^\s*([^@]+?)\s*@\s*\(?\s*(.*?)\s*\)?\s*$/.exec(raw);
    if (!m) continue;
    let spec = m[2];
    let days = null;
    const d = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\b\s*/.exec(spec);
    if (d) { days = parseDays(d[1]); spec = spec.slice(d[0].length); }
    const times = [...spec.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)].map((x) => [x[1].padStart(5, '0'), x[2].padStart(5, '0')]);
    if (!times.length && !days) continue;
    out.push({ value: m[1].trim(), days, times });
  }
  return out;
}

function ruleActive(r, date) {
  if (r.days && !r.days.has(date.getDay())) return false;
  return isActiveAt({ times: r.times }, date);
}

const ACCESS_KEYS = {
  motorbike: ['motorcycle', 'motor_vehicle', 'vehicle', 'access'],
  car: ['motorcar', 'motor_vehicle', 'vehicle', 'access'],
};

// { banned, times } — times là khung giờ cấm nếu cấm theo giờ
export function banFor(t, vehicle, date) {
  if (vehicle === 'motorbike' && /^motorway/.test(t.highway || '') && t.motorcycle !== 'yes') {
    return { banned: true, times: null };
  }
  for (const k of ACCESS_KEYS[vehicle]) {
    for (const r of parseConditional(t[k + ':conditional'])) {
      if (ruleActive(r, date)) return { banned: r.value === 'no', times: r.value === 'no' && r.times.length ? r.times : null };
    }
    if (t[k] != null) return { banned: t[k] === 'no', times: null };
  }
  return { banned: false, times: null };
}

// Đường có bị cấm vào lúc nào đó không (để vẽ bản đồ)
export function everBanned(t, vehicle) {
  if (vehicle === 'motorbike' && /^motorway/.test(t.highway || '') && t.motorcycle !== 'yes') return true;
  for (const k of ACCESS_KEYS[vehicle]) {
    if (parseConditional(t[k + ':conditional']).some((r) => r.value === 'no')) return true;
    if (t[k] != null) return t[k] === 'no';
  }
  return false;
}

// ---------- Chỉ mục không gian ----------

const CELL = 0.002; // ~220 m

export function buildRoadIndex(ways) {
  const grid = new Map();
  for (const w of ways) {
    for (let k = 0; k + 3 < w.g.length; k += 2) {
      const a = { lat: w.g[k], lng: w.g[k + 1] };
      const b = { lat: w.g[k + 2], lng: w.g[k + 3] };
      if (a.lat === b.lat && a.lng === b.lng) continue;
      const seg = { w, a, b, brg: bearing(a, b) };
      const i0 = Math.floor(Math.min(a.lat, b.lat) / CELL), i1 = Math.floor(Math.max(a.lat, b.lat) / CELL);
      const j0 = Math.floor(Math.min(a.lng, b.lng) / CELL), j1 = Math.floor(Math.max(a.lng, b.lng) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 1e6 + j;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(seg);
        }
      }
    }
  }
  return { grid, ways };
}

function distToSeg(p, s) {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 110540;
  const ax = (s.a.lng - p.lng) * kx, ay = (s.a.lat - p.lat) * ky;
  const bx = (s.b.lng - p.lng) * kx, by = (s.b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Các đường gần điểm p, cùng phương với hướng đi. dir = 1 nếu đi theo thứ tự node, -1 nếu ngược.
export function matchRoad(index, p, heading, { radius = 20, maxAlign = 40 } = {}) {
  const i = Math.floor(p.lat / CELL), j = Math.floor(p.lng / CELL);
  const best = new Map();
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const list = index.grid.get((i + di) * 1e6 + (j + dj));
      if (!list) continue;
      for (const s of list) {
        const d = distToSeg(p, s);
        if (d > radius) continue;
        const diff = Math.abs(angleDiff(s.brg, heading));
        const dir = diff <= 90 ? 1 : -1;
        const align = dir === 1 ? diff : 180 - diff;
        if (align > maxAlign) continue;
        const score = d + align * 0.3;
        const prev = best.get(s.w.id);
        if (!prev || score < prev.score) best.set(s.w.id, { way: s.w, d, dir, align, score });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.score - b.score);
}

// ---------- Theo dõi ----------

export class RoadMonitor {
  constructor(index, vehicle = 'motorbike') {
    this.index = index;
    this.vehicle = vehicle;
    this.reset();
  }

  reset() {
    this.prevWay = null;
    this.wrongCount = 0;
    this.lastWrong = -Infinity;
    this.banSaid = new Map();
    this.aheadSaid = new Map();
    this.cand = null;
    this.candN = 0;
    this.noSpeed = 0;
    this.limit = null;
  }

  setIndex(index) { this.index = index; this.reset(); }
  setVehicle(v) { this.vehicle = v; this.reset(); }

  // heading: độ, speed: m/s, lead: mét nhìn trước
  update(fix, heading, speed, lead, date = new Date(fix.time)) {
    const alerts = [];
    if (!this.index || heading == null) return { alerts, road: null, limit: this.limit };
    const now = fix.time;
    const v = this.vehicle;
    const veh = VNAME[v];

    const cands = matchRoad(this.index, fix, heading);
    let cur = cands[0] || null;
    if (this.prevWay != null) {
      const p = cands.find((c) => c.way.id === this.prevWay);
      if (p && cur && p.score <= cur.score + 6) cur = p; // bám đường cũ, tránh nhảy qua lại
    }
    this.prevWay = cur ? cur.way.id : null;

    if (cur) {
      const t = cur.way.t;
      const name = t.name || '';

      // Đi ngược chiều — bỏ qua nếu có đường hợp lệ khác sát bên (không chắc mình đang ở đường nào)
      const ow = onewayFor(t, v);
      const wrong = ow !== 0 && cur.dir === -ow && speed >= 2;
      const ambiguous = wrong && cands.some((c) => c.way.id !== cur.way.id && c.d <= cur.d + 8 && onewayFor(c.way.t, v) !== -c.dir);
      this.wrongCount = wrong && !ambiguous ? this.wrongCount + 1 : 0;
      if (this.wrongCount >= 2 && now - this.lastWrong >= 20000) {
        this.lastWrong = now;
        alerts.push({ kind: 'wrongway', distance: 0, text: `Đang đi ngược chiều${name ? ' trên ' + name : ''}. Đường một chiều` });
      }

      // Đang ở trên đường cấm
      const ban = banFor(t, v, date);
      if (ban.banned && speed >= 1) {
        if (now - (this.banSaid.get(cur.way.id) ?? -Infinity) >= 60000) {
          this.banSaid.set(cur.way.id, now);
          alerts.push({ kind: 'banned', distance: 0, text: `${name || 'Đường này'} cấm ${veh}${timesText(ban.times)}` });
        }
      }

      // Giới hạn tốc độ: đổi khi giá trị mới ổn định 2 lần liên tiếp
      const ms = maxspeedFor(t, v, cur.dir);
      if (ms != null) {
        this.noSpeed = 0;
        if (ms === this.cand) this.candN++; else { this.cand = ms; this.candN = 1; }
        if (this.candN >= 2 && ms !== this.limit) {
          this.limit = ms;
          alerts.push({ kind: 'limit', distance: 0, text: `Tốc độ tối đa ${ms}` });
        }
      } else if (++this.noSpeed >= 5) {
        this.limit = null;
        this.cand = null;
      }
    }

    // Đường phía trước theo hướng đang đi
    if (speed >= 2) {
      const h = (heading * Math.PI) / 180;
      const ahead = offset(fix, Math.sin(h) * lead, Math.cos(h) * lead);
      const ac = matchRoad(this.index, ahead, heading, { radius: 15 })[0];
      if (ac && ac.way.id !== cur?.way.id && now - (this.aheadSaid.get(ac.way.id) ?? -Infinity) >= 60000) {
        const t = ac.way.t;
        const name = t.name || '';
        const ban = banFor(t, v, date);
        const ow = onewayFor(t, v);
        let text = null;
        if (ban.banned) text = `Phía trước, ${name || 'đường'} cấm ${veh}${timesText(ban.times)}`;
        else if (ow !== 0 && ac.dir === -ow) text = `Phía trước là đường một chiều${name ? ' ' + name : ''}, ngược hướng`;
        if (text) {
          this.aheadSaid.set(ac.way.id, now);
          alerts.push({ kind: 'ahead', distance: lead, text });
        }
      }
    }

    return { alerts, road: cur ? { id: cur.way.id, name: cur.way.t.name || '' } : null, limit: this.limit };
  }
}
