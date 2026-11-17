import { AlertEngine, SIGN_TYPES, distance, offset } from './engine.js';
import { compactWays, buildRoadIndex, RoadMonitor, everBanned, onewayFor } from './roads.js';
import { HANOI_CORE, bboxAround, fetchOsm, osmSigns, fetchMapillary, mapillarySigns } from './sources.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const PEAK = [['06:00', '09:00'], ['16:00', '19:00']];
const URGENT = new Set(['wrongway', 'overspeed', 'banned']);

const S = {
  mode: 'gps',
  vehicle: 'motorbike',
  voice: true,
  running: false,
  ways: [],
  osmSigns: [],
  mlySigns: [],
  mySigns: [],
  route: [],
};

const engine = new AlertEngine([], { vehicle: S.vehicle });
const road = new RoadMonitor(null, S.vehicle);
let stopFn = null;
let wakeLock = null;
let lastFix = null;
let logCount = 0;
let firstFix = true;

// ---------- Bản đồ ----------

const map = L.map('map', { preferCanvas: true }).setView([21.028, 105.834], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);
const renderer = L.canvas({ padding: 0.3 });
const dataLayer = L.layerGroup().addTo(map);
const routeLine = L.polyline([], { color: '#1f5fbf', weight: 3, dashArray: '6 6' }).addTo(map);
const routeDots = L.layerGroup().addTo(map);
const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2.5, fillColor: '#1f5fbf', fillOpacity: 1, interactive: false });
const MIN_DRAW_ZOOM = 15;

// Chỉ giữ sẵn các đường đáng vẽ (một chiều / cấm) kèm khung bao, để mỗi lần vẽ chỉ lọc theo vùng đang nhìn.
let special = [];
function prepareSpecial() {
  special = [];
  for (const w of S.ways) {
    const banned = everBanned(w.t, S.vehicle);
    const oneway = onewayFor(w.t, S.vehicle) !== 0;
    if (!banned && !oneway) continue;
    let s = 90, n = -90, west = 180, e = -180;
    const pts = [];
    for (let k = 0; k < w.g.length; k += 2) {
      const lat = w.g[k], lng = w.g[k + 1];
      pts.push([lat, lng]);
      if (lat < s) s = lat; if (lat > n) n = lat; if (lng < west) west = lng; if (lng > e) e = lng;
    }
    special.push({ pts, banned, s, n, w: west, e });
  }
}

const SIGN_COLOR = { osm: '#2f7d3b', mapillary: '#8a5a00', mine: '#c8261e' };
let drawnKey = '';
function drawData(force = false) {
  if (map.getZoom() < MIN_DRAW_ZOOM) {
    if (drawnKey !== 'none') { dataLayer.clearLayers(); drawnKey = 'none'; }
    $('mapNote').textContent = 'Phóng to để xem đường một chiều (xanh), đường cấm (đỏ) và biển báo (chấm).';
    return;
  }
  $('mapNote').textContent = 'Xanh: đường một chiều · Đỏ: đường cấm · Chấm: biển báo (xanh lá OSM, nâu Mapillary, đỏ của tôi).';
  const b = map.getBounds().pad(0.3);
  const key = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(3)).join(',');
  if (!force && key === drawnKey) return;
  drawnKey = key;
  const S0 = b.getSouth(), N0 = b.getNorth(), W0 = b.getWest(), E0 = b.getEast();
  dataLayer.clearLayers();
  for (const x of special) {
    if (x.n < S0 || x.s > N0 || x.e < W0 || x.w > E0) continue;
    L.polyline(x.pts, x.banned
      ? { renderer, interactive: false, color: '#c8261e', weight: 4, opacity: 0.75 }
      : { renderer, interactive: false, color: '#1f5fbf', weight: 2, opacity: 0.5 }).addTo(dataLayer);
  }
  for (const sg of allSigns()) {
    if (sg.lat < S0 || sg.lat > N0 || sg.lng < W0 || sg.lng > E0) continue;
    L.circleMarker([sg.lat, sg.lng], { renderer, radius: 5, color: '#fff', weight: 1.5, fillColor: SIGN_COLOR[sg.source] || '#c8261e', fillOpacity: 1 })
      .bindTooltip(`${sg.code} ${SIGN_TYPES[sg.code]?.name || ''}${sg.value ? ' ' + sg.value : ''}`)
      .addTo(dataLayer);
  }
}
let drawTimer = null;
map.on('moveend', () => { clearTimeout(drawTimer); drawTimer = setTimeout(() => drawData(), 120); });

function drawRoute() {
  routeLine.setLatLngs(S.route);
  routeDots.clearLayers();
  S.route.forEach((p) => L.circleMarker(p, { radius: 4, color: '#1f5fbf', fillOpacity: 1 }).addTo(routeDots));
}

map.on('click', (e) => {
  if (S.mode !== 'sim' || S.running) return;
  S.route.push([e.latlng.lat, e.latlng.lng]);
  drawRoute();
});

// ---------- Dữ liệu ----------

function allSigns() {
  return [...S.osmSigns, ...S.mlySigns, ...S.mySigns];
}

function rebuild() {
  road.setIndex(S.ways.length ? buildRoadIndex(S.ways) : null);
  engine.setSigns(allSigns());
  renderCounts();
  renderMine();
  prepareSpecial();
  drawData(true);
}

function renderCounts() {
  let oneway = 0, banned = 0, speed = 0;
  for (const w of S.ways) {
    if (onewayFor(w.t, S.vehicle) !== 0) oneway++;
    if (everBanned(w.t, S.vehicle)) banned++;
    if (w.t.maxspeed || w.t['maxspeed:motorcycle']) speed++;
  }
  const rows = [
    ['Đoạn đường', S.ways.length],
    ['— một chiều', oneway],
    [`— cấm ${S.vehicle === 'motorbike' ? 'xe máy' : 'ô tô'} (kể cả theo giờ)`, banned],
    ['— có giới hạn tốc độ', speed],
    ['Biển từ OSM', S.osmSigns.length],
    ['Biển từ Mapillary', S.mlySigns.length],
    ['Biển của tôi', S.mySigns.length],
  ];
  $('counts').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v.toLocaleString('vi-VN')}</td></tr>`).join('');
}

function renderMine() {
  const ul = $('mine');
  ul.innerHTML = '';
  for (const s of S.mySigns) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${s.code} ${SIGN_TYPES[s.code]?.name || ''}${s.value ? ' ' + s.value : ''}${s.times ? ' (giờ cao điểm)' : ''}`;
    const btn = document.createElement('button');
    btn.textContent = 'Xoá';
    btn.onclick = async () => {
      S.mySigns = S.mySigns.filter((x) => x.id !== s.id);
      await db.set('mySigns', S.mySigns);
      rebuild();
    };
    li.append(span, btn);
    ul.append(li);
  }
}

function mergeById(oldList, newList) {
  const m = new Map(oldList.map((x) => [x.id, x]));
  for (const x of newList) m.set(x.id, x);
  return [...m.values()];
}

function setStatus(t) { $('dataStatus').textContent = t; }

function lockData(locked) {
  for (const id of ['dlCore', 'dlHere', 'dlMly', 'clearData']) $(id).disabled = locked;
}

async function downloadOsm(bbox) {
  lockData(true);
  try {
    const el = await fetchOsm(bbox, (i, n) => setStatus(`Đang tải dữ liệu đường ${Math.min(i + 1, n)}/${n}…`));
    const ways = compactWays(el);
    const { signs, skipped } = osmSigns(el);
    S.ways = mergeById(S.ways, ways);
    S.osmSigns = mergeById(S.osmSigns, signs);
    await db.set('ways', S.ways);
    await db.set('osmSigns', S.osmSigns);
    rebuild();
    map.fitBounds([[bbox.s, bbox.w], [bbox.n, bbox.e]]);
    setStatus(`Xong: ${ways.length.toLocaleString('vi-VN')} đoạn đường, ${signs.length} biển OSM${skipped ? ` (bỏ ${skipped} biển không rõ áp dụng cho chiều nào)` : ''}.`);
  } catch (e) {
    setStatus(`Lỗi tải OSM: ${e.message}. Máy chủ Overpass có thể đang quá tải, thử lại sau vài phút.`);
  } finally {
    lockData(false);
  }
}

$('dlCore').onclick = () => downloadOsm(HANOI_CORE);
$('dlHere').onclick = () => {
  if (lastFix) return downloadOsm(bboxAround(lastFix, 3));
  setStatus('Đang lấy vị trí…');
  navigator.geolocation.getCurrentPosition(
    (p) => downloadOsm(bboxAround({ lat: p.coords.latitude, lng: p.coords.longitude }, 3)),
    (e) => setStatus('Không lấy được vị trí: ' + e.message),
    { enableHighAccuracy: true, timeout: 20000 },
  );
};

$('dlMly').onclick = async () => {
  const token = $('token').value.trim();
  if (!token) { setStatus('Nhập Mapillary access token trước.'); return; }
  await db.set('token', token);
  lockData(true);
  try {
    const feats = await fetchMapillary(HANOI_CORE, token, (i, n) => setStatus(`Đang tải biển Mapillary ${Math.min(i + 1, n)}/${n}…`));
    const { signs, skipped } = mapillarySigns(feats);
    S.mlySigns = mergeById(S.mlySigns, signs);
    await db.set('mlySigns', S.mlySigns);
    rebuild();
    setStatus(`Xong: ${signs.length} biển Mapillary dùng được (bỏ ${skipped} biển loại khác hoặc không rõ hướng).`);
  } catch (e) {
    setStatus(`Lỗi tải Mapillary: ${e.message}`);
  } finally {
    lockData(false);
  }
};

$('clearData').onclick = async () => {
  S.ways = []; S.osmSigns = []; S.mlySigns = [];
  await Promise.all([db.del('ways'), db.del('osmSigns'), db.del('mlySigns')]);
  rebuild();
  setStatus('Đã xoá dữ liệu tải về. Biển của tôi vẫn giữ.');
};

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(S.mySigns, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bien-cua-toi-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    if (!Array.isArray(list)) throw new Error('không phải danh sách');
    const ok = list.filter((s) => s && s.id && SIGN_TYPES[s.code] && Number.isFinite(s.lat) && Number.isFinite(s.lng) && Number.isFinite(s.heading))
      .map((s) => ({ ...s, source: 'mine' }));
    const before = S.mySigns.length;
    S.mySigns = mergeById(S.mySigns, ok);
    await db.set('mySigns', S.mySigns);
    rebuild();
    setStatus(`Đã nhập ${ok.length} biển (${S.mySigns.length - before} biển mới).`);
  } catch (err) {
    setStatus('File không hợp lệ: ' + err.message);
  }
  e.target.value = '';
};

// ---------- Giọng nói ----------

let viVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) { $('voiceNote').textContent = 'Trình duyệt không hỗ trợ đọc giọng nói. Cảnh báo chỉ hiện bằng chữ.'; return; }
  const vs = speechSynthesis.getVoices();
  viVoice = vs.find((v) => /^vi/i.test(v.lang)) || null;
  $('voiceNote').textContent = vs.length && !viVoice ? 'Máy chưa có giọng tiếng Việt cho trình duyệt. Cài giọng tiếng Việt trong phần Chuyển văn bản thành giọng nói của máy.' : '';
}
try { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } catch {}

function speak(text, urgent) {
  if (!S.voice || !('speechSynthesis' in window)) return;
  try {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    if (viVoice) u.voice = viVoice;
    speechSynthesis.speak(u);
  } catch {}
}

// ---------- Theo dõi ----------

function setBanner(text, warn = false) {
  $('banner').textContent = text;
  $('banner').className = 'banner' + (warn ? ' warn' : '');
}

function addLog(time, text, warn) {
  const ol = $('log');
  if (logCount === 0) ol.innerHTML = '';
  logCount++;
  const li = document.createElement('li');
  if (warn) li.className = 'warn';
  const t = document.createElement('time');
  t.textContent = time;
  const s = document.createElement('span');
  s.textContent = text;
  li.append(t, s);
  ol.prepend(li);
  while (ol.children.length > 40) ol.lastChild.remove();
}

function onFix(fix) {
  lastFix = fix;
  const date = new Date(fix.time);
  const res = engine.update(fix);
  const lead = Math.min(160, Math.max(40, engine.speed * 6));
  const rr = road.update(fix, engine.heading, engine.speed, lead, date);

  // Giới hạn tốc độ: đoạn đường mới có maxspeed thì dùng; biển P.127 vừa đi qua vẫn được ưu tiên tới khi đổi đường
  if (rr.alerts.some((a) => a.kind === 'limit')) engine.limit = { value: rr.limit, signId: 'road' };
  else if (rr.limit == null && engine.limit?.signId === 'road') engine.limit = null;

  const kmh = engine.speed * 3.6;
  const lim = engine.limit?.value ?? null;
  $('speed').textContent = Math.round(kmh);
  $('speed').className = lim != null && kmh > lim + 3 ? 'over' : '';
  $('limit').textContent = lim ?? '—';
  $('road').textContent = rr.road ? (rr.road.name || 'Đường không tên') : (road.index ? 'Chưa khớp được đường' : 'Chưa có dữ liệu đường — tải ở mục Dữ liệu');

  me.setLatLng([fix.lat, fix.lng]);
  if (!map.hasLayer(me)) me.addTo(map);
  if (S.running) {
    if (firstFix) { firstFix = false; map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 16), { animate: false }); }
    else if (!map.getBounds().pad(-0.25).contains([fix.lat, fix.lng])) map.panTo([fix.lat, fix.lng], { animate: false });
  }

  const hh = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  for (const a of [...res.alerts, ...rr.alerts]) {
    const urgent = URGENT.has(a.kind);
    addLog(hh, a.text, urgent);
    setBanner(a.text, urgent);
    speak(a.text, urgent);
  }
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (S.running && document.visibilityState === 'visible') keepAwake();
});

function startGps() {
  if (!window.isSecureContext) { setBanner('Cần mở app bằng địa chỉ https:// để dùng GPS.', true); return false; }
  if (!('geolocation' in navigator)) { setBanner('Trình duyệt không hỗ trợ GPS.', true); return false; }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({
      lat: p.coords.latitude,
      lng: p.coords.longitude,
      speed: p.coords.speed,
      heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
      accuracy: p.coords.accuracy,
      time: p.timestamp,
    }),
    (e) => setBanner(e.code === 1 ? 'Chưa cho phép truy cập vị trí. Bật quyền vị trí cho trình duyệt rồi thử lại.' : 'Lỗi GPS: ' + e.message, true),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  stopFn = () => navigator.geolocation.clearWatch(id);
  return true;
}

function startSim(rate = 3) {
  if (S.route.length < 2) { setBanner('Chạm lên bản đồ để vẽ tuyến trước (ít nhất 2 điểm).', true); return false; }
  const pts = S.route.map(([lat, lng]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  let s = 0, k = 0;
  const t0 = Date.now();
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const timer = setInterval(() => {
    const v = Number($('simSpeed').value) / 3.6;
    if (s > total) { stop(); setBanner('Hết tuyến mô phỏng.'); return; }
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = cum[i] === cum[i - 1] ? 0 : (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
    const p = { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * f };
    const noisy = offset(p, rand() * 4, rand() * 4);
    onFix({ ...noisy, speed: v, heading: null, time: t0 + k * 1000 });
    s += v;
    k++;
  }, 1000 / rate);
  stopFn = () => clearInterval(timer);
  return true;
}

function start() {
  firstFix = true;
  engine.reset();
  road.reset();
  engine.setVehicle(S.vehicle);
  road.setVehicle(S.vehicle);
  const ok = S.mode === 'gps' ? startGps() : startSim(window.__simRate || 3);
  if (!ok) return;
  S.running = true;
  $('startBtn').textContent = 'Dừng';
  $('startBtn').classList.add('stop');
  $('modeSeg').classList.add('locked');
  $('vehSeg').classList.add('locked');
  setBanner(S.mode === 'gps' ? 'Đang chờ tín hiệu GPS…' : 'Đang mô phỏng…');
  speak(S.mode === 'gps' ? 'Bắt đầu cảnh báo' : 'Bắt đầu mô phỏng', false);
  keepAwake();
}

function stop() {
  stopFn?.();
  stopFn = null;
  S.running = false;
  try { speechSynthesis.cancel(); } catch {}
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
  $('startBtn').textContent = 'Bắt đầu';
  $('startBtn').classList.remove('stop');
  $('modeSeg').classList.remove('locked');
  $('vehSeg').classList.remove('locked');
  $('speed').textContent = '0';
}

$('startBtn').onclick = () => (S.running ? stop() : start());

function bindSeg(id, key, after) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      S[key] = b.dataset.v;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      db.set(key, S[key]);
      after?.();
    };
  });
}
bindSeg('modeSeg', 'mode', () => { $('simBox').hidden = S.mode !== 'sim'; });
bindSeg('vehSeg', 'vehicle', () => { engine.setVehicle(S.vehicle); road.setVehicle(S.vehicle); renderCounts(); prepareSpecial(); drawData(true); });

$('simSpeed').oninput = () => { $('simSpeedVal').textContent = $('simSpeed').value; };
$('simUndo').onclick = () => { S.route.pop(); drawRoute(); };
$('simClear').onclick = () => { S.route = []; drawRoute(); };
$('voice').onchange = () => { S.voice = $('voice').checked; db.set('voice', S.voice); };

// ---------- Thêm biển ----------

$('codeList').innerHTML = Object.entries(SIGN_TYPES)
  .map(([c, t], i) => `<label><input type="radio" name="code" value="${c}" ${i === 0 ? 'checked' : ''}><b>${c}</b>${t.name}</label>`)
  .join('');
const syncValueRow = () => {
  const c = document.querySelector('input[name=code]:checked').value;
  $('valueRow').hidden = !SIGN_TYPES[c].isLimit;
};
$('codeList').onchange = syncValueRow;
syncValueRow();

$('addBtn').onclick = () => {
  if (!S.running || !lastFix) { setBanner('Bấm Bắt đầu trước, rồi thêm biển khi đang ở cạnh biển.', true); return; }
  if (engine.heading == null) { setBanner('Chưa rõ hướng đi. Đi thêm vài chục mét rồi thêm biển.', true); return; }
  $('addDlg').showModal();
};
$('addCancel').onclick = () => $('addDlg').close();
$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const code = document.querySelector('input[name=code]:checked').value;
  const sign = {
    id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    code,
    lat: Math.round(lastFix.lat * 1e6) / 1e6,
    lng: Math.round(lastFix.lng * 1e6) / 1e6,
    heading: Math.round(engine.heading),
    source: 'mine',
    addedAt: new Date().toISOString(),
  };
  if (SIGN_TYPES[code].isLimit) {
    const v = parseInt($('signValue').value, 10);
    if (!(v >= 5 && v <= 120)) { $('signValue').focus(); return; }
    sign.value = v;
  }
  if ($('signPeak').checked) sign.times = PEAK;
  S.mySigns = [...S.mySigns, sign];
  await db.set('mySigns', S.mySigns);
  rebuild();
  $('addDlg').close();
  speak('Đã lưu biển', false);
};

// ---------- Khởi động ----------

async function init() {
  const [ways, o, m, mine, token, voice, mode, vehicle] = await Promise.all(
    ['ways', 'osmSigns', 'mlySigns', 'mySigns', 'token', 'voice', 'mode', 'vehicle'].map((k) => db.get(k)),
  );
  S.ways = ways || [];
  S.osmSigns = o || [];
  S.mlySigns = m || [];
  S.mySigns = mine || [];
  if (token) $('token').value = token;
  if (voice === false) { S.voice = false; $('voice').checked = false; }
  if (mode) document.querySelector(`#modeSeg [data-v=${mode}]`)?.click();
  if (vehicle) document.querySelector(`#vehSeg [data-v=${vehicle}]`)?.click();
  rebuild();
  if (!S.ways.length) setStatus('Chưa có dữ liệu đường. Bấm "Tải nội thành Hà Nội" (khoảng 1–3 phút, nên dùng Wi-Fi).');
}
init();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Dùng cho test tự động
window.__app = { S, onFix, setRoute: (r) => { S.route = r; drawRoute(); }, map };
