// Engine cảnh báo biển báo — JS thuần, dùng chung cho app Expo, trang mô phỏng và test Node.
// Không phụ thuộc thư viện nào.

export const VEHICLE = { MOTORBIKE: 'motorbike', CAR: 'car' };

// Mã biển theo QCVN 41:2024/BGTVT. appliesTo: loại xe bị biển ràng buộc.
// speak(sign): câu đọc, chưa gồm khoảng cách.
export const SIGN_TYPES = {
  'P.102':  { name: 'Cấm đi ngược chiều',          appliesTo: ['motorbike', 'car'], speak: () => 'Cấm đi ngược chiều' },
  'P.103a': { name: 'Cấm xe ô tô',                 appliesTo: ['car'],              speak: () => 'Cấm ô tô' },
  'P.104':  { name: 'Cấm xe mô tô',                appliesTo: ['motorbike'],        speak: () => 'Cấm xe máy' },
  'P.105':  { name: 'Cấm xe ô tô và xe mô tô',     appliesTo: ['motorbike', 'car'], speak: () => 'Cấm ô tô và xe máy' },
  'P.123a': { name: 'Cấm rẽ trái',                 appliesTo: ['motorbike', 'car'], speak: () => 'Cấm rẽ trái' },
  'P.123b': { name: 'Cấm rẽ phải',                 appliesTo: ['motorbike', 'car'], speak: () => 'Cấm rẽ phải' },
  'P.124a': { name: 'Cấm quay đầu xe',             appliesTo: ['motorbike', 'car'], speak: () => 'Cấm quay đầu' },
  'P.124c': { name: 'Cấm rẽ trái và quay đầu xe',  appliesTo: ['motorbike', 'car'], speak: () => 'Cấm rẽ trái và quay đầu' },
  'P.127':  { name: 'Tốc độ tối đa cho phép',      appliesTo: ['motorbike', 'car'], speak: (s) => `Tốc độ tối đa ${s.value}`, isLimit: true },
  'DP.127': { name: 'Hết tốc độ tối đa cho phép',  appliesTo: ['motorbike', 'car'], speak: () => 'Hết hạn chế tốc độ', endsLimit: true },
};

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Chênh lệch góc có dấu, trong khoảng (-180, 180]
export function angleDiff(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

// Chuyển toạ độ mét cục bộ (x: đông, y: bắc) quanh một gốc sang lat/lng — dùng cho dữ liệu mẫu.
export function offset(origin, x, y) {
  return {
    lat: origin.lat + deg(y / R),
    lng: origin.lng + deg(x / (R * Math.cos(rad(origin.lat)))),
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function isActiveAt(sign, date) {
  if (!sign.times || sign.times.length === 0) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return sign.times.some(([from, to]) => {
    const f = toMinutes(from), t = toMinutes(to);
    return f <= t ? now >= f && now < t : now >= f || now < t; // khung qua nửa đêm
  });
}

export function appliesTo(sign, vehicle) {
  const list = sign.vehicles || SIGN_TYPES[sign.code]?.appliesTo || [];
  return list.includes(vehicle);
}

export function timesText(times) {
  if (!times || times.length === 0) return '';
  const fmt = (s) => {
    const [h, m] = s.split(':').map(Number);
    return m ? `${h} giờ ${m}` : `${h} giờ`;
  };
  return ', ' + times.map(([f, t]) => `từ ${fmt(f)} đến ${fmt(t)}`).join(' và ');
}

export function signText(sign) {
  const t = SIGN_TYPES[sign.code];
  return (t ? t.speak(sign) : sign.code) + timesText(sign.times);
}

export const DEFAULTS = {
  vehicle: VEHICLE.MOTORBIKE,
  leadSeconds: 6,       // cảnh báo trước khoảng N giây
  minLead: 40,          // mét
  maxLead: 160,         // mét
  corridor: 20,         // lệch ngang tối đa so với hướng đi (mét) — loại biển ở đường song song
  headingTolerance: 40, // biển phải quay về hướng mình đang đi (độ)
  headingMinMove: 12,   // phải đi ít nhất N mét mới tính hướng
  headingWindow: 20,    // hướng tính trên quãng đi gần nhất dài khoảng N mét
  minSpeedForGpsHeading: 3, // m/s; chậm hơn thì không tin hướng của GPS
  overspeedMargin: 3,   // km/h
  overspeedRepeatMs: 15000,
  forgetDistance: 250,  // mét — xa hơn thì cho phép cảnh báo lại biển này
};

export class AlertEngine {
  constructor(signs = [], options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.signs = signs;
    this.reset();
  }

  reset() {
    this.alerted = new Set();
    this.applied = new Set();
    this.trail = [];
    this.heading = null;
    this.speed = 0;
    this.limit = null;
    this.lastOverspeed = 0;
    this.lastFix = null;
  }

  setSigns(signs) { this.signs = signs; this.alerted.clear(); this.applied.clear(); }
  setVehicle(v) { this.opts.vehicle = v; this.alerted.clear(); this.applied.clear(); this.limit = null; }

  // fix: { lat, lng, speed (m/s hoặc null), heading (độ hoặc null), time (ms) }
  update(fix) {
    const o = this.opts;
    const date = new Date(fix.time ?? Date.now());

    // Tốc độ: ưu tiên GPS, nếu không có thì tự tính
    if (fix.speed != null && fix.speed >= 0) {
      this.speed = fix.speed;
    } else if (this.lastFix) {
      const dt = (fix.time - this.lastFix.time) / 1000;
      if (dt > 0) this.speed = distance(this.lastFix, fix) / dt;
    }
    this.lastFix = fix;

    // Hướng đi: GPS khi đủ nhanh; nếu không thì lấy từ quãng đã đi gần nhất (12–30 m) để giảm nhiễu
    this.trail.push(fix);
    while (this.trail.length > 1 && distance(this.trail[1], fix) >= o.headingWindow) this.trail.shift();
    if (fix.heading != null && fix.heading >= 0 && this.speed >= o.minSpeedForGpsHeading) {
      this.heading = fix.heading;
    } else if (distance(this.trail[0], fix) >= o.headingMinMove) {
      this.heading = bearing(this.trail[0], fix);
    }

    const alerts = [];
    const speedKmh = this.speed * 3.6;

    if (this.heading != null) {
      const lead = Math.min(o.maxLead, Math.max(o.minLead, this.speed * o.leadSeconds));

      for (const sign of this.signs) {
        const d = distance(fix, sign);
        if (d > o.forgetDistance) { this.alerted.delete(sign.id); this.applied.delete(sign.id); continue; }

        const off = angleDiff(this.heading, bearing(fix, sign));
        const along = d * Math.cos(rad(off));
        const cross = Math.abs(d * Math.sin(rad(off)));
        const facing = Math.abs(angleDiff(this.heading, sign.heading)) <= o.headingTolerance;
        if (!facing || cross > o.corridor) continue;

        const type = SIGN_TYPES[sign.code];

        // Đã đi qua biển tốc độ → áp dụng giới hạn mới
        if (along <= 0 && this.alerted.has(sign.id)) {
          if (!this.applied.has(sign.id)) {
            this.applied.add(sign.id);
            if (type?.isLimit && appliesTo(sign, o.vehicle)) this.limit = { value: sign.value, signId: sign.id };
            if (type?.endsLimit) this.limit = null;
          }
          continue;
        }

        if (along <= 0 || along > lead) continue;
        if (this.alerted.has(sign.id)) continue;
        if (!appliesTo(sign, o.vehicle)) continue;
        if (!isActiveAt(sign, date)) continue;

        this.alerted.add(sign.id);
        const meters = Math.max(10, Math.round(along / 10) * 10);
        alerts.push({
          kind: 'sign',
          sign,
          distance: along,
          text: `${signText(sign)}, ${meters} mét nữa`,
        });
      }
    }

    // Quá tốc độ
    if (this.limit && speedKmh > this.limit.value + o.overspeedMargin) {
      const now = fix.time ?? Date.now();
      if (now - this.lastOverspeed >= o.overspeedRepeatMs) {
        this.lastOverspeed = now;
        alerts.push({
          kind: 'overspeed',
          distance: 0,
          text: `Quá tốc độ. Đang chạy ${Math.round(speedKmh)}, tối đa ${this.limit.value}`,
        });
      }
    }

    alerts.sort((a, b) => a.distance - b.distance);
    return {
      alerts,
      state: { heading: this.heading, speedKmh, limit: this.limit?.value ?? null },
    };
  }
}
