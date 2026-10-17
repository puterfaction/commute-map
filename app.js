/* Commute × Rent map — client-side isochrones from a precomputed
   station-to-station matrix (see pipeline/build_data.py), plus
   listing-level rent stats recomputed live as filters change. */

const BANDS = [
  { max: 20, color: [0xec, 0xb9, 0x6a] },
  { max: 30, color: [0x74, 0xb2, 0x5c] },
  { max: 40, color: [0xd8, 0x83, 0xae] },
  { max: 50, color: [0x91, 0x79, 0xe8] },
  { max: 65, color: [0x35, 0xa0, 0x8c] },
  { max: 200, color: [0x7f, 0xb3, 0xef] },
];
// sequential amber ramp for rent mode (dark -> bright = cheap -> expensive)
const RENT_RAMP = [
  [0x4a, 0x35, 0x18], [0x77, 0x54, 0x20], [0xa4, 0x74, 0x28], [0xd2, 0x96, 0x38], [0xff, 0xc0, 0x58],
];
const ISO_ALPHA = 158;          // 0-255 overlay opacity
const WALK_M_PER_MIN = 70;      // effective straight-line walking speed
const STATION_WALK_CAP = 14;    // minutes of walking from a station we paint
const ORIGIN_WALK_CAP = 25;     // minutes of direct walking from the office
const DEFAULT_ORIGIN = [40.7527, -73.9772]; // Grand Central
const RENT_BIN_M = 350;         // spatial bin size for rent stats
const RENT_MIN_N = 3;           // min listings in a ~1km window to paint a cell
const LABEL_RADIUS_M = 900;     // listings within this of a label point
const LABEL_MIN_N = 5;

// Grid covering the city (cells ~110 m)
const GRID = {
  lat0: 40.53, lat1: 40.93,
  lon0: -74.06, lon1: -73.68,
  dLat: 0.001, dLon: 0.0013,
};
GRID.rows = Math.round((GRID.lat1 - GRID.lat0) / GRID.dLat);
GRID.cols = Math.round((GRID.lon1 - GRID.lon0) / GRID.dLon);

const M_PER_LAT = 110540;
const M_PER_LON = 111320 * Math.cos((40.73 * Math.PI) / 180);

const map = L.map('map', {
  center: [40.72, -73.94],
  zoom: 12,
  zoomControl: true,
  attributionControl: true,
});
map.attributionControl.setPrefix(false);

// Esri Dark Gray Canvas: keyless (CARTO started watermarking "API KEY REQUIRED", Sept 2026)
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
L.tileLayer(ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  maxZoom: 19, maxNativeZoom: 16,
}).addTo(map);

map.createPane('iso');    map.getPane('iso').style.zIndex = 350;
map.createPane('lines');  map.getPane('lines').style.zIndex = 400;
map.createPane('citylabels'); map.getPane('citylabels').style.zIndex = 450;
map.getPane('citylabels').style.pointerEvents = 'none';

L.tileLayer(ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
  pane: 'citylabels', maxZoom: 19, maxNativeZoom: 16,
}).addTo(map);

const state = {
  stations: null, n: 0, matrix: null,
  best: null,           // Float32Array minutes office->station
  grid: null,           // commute minutes per grid cell
  rentGrid: null,       // median rent per grid cell (filtered)
  rentBreaks: null,     // quantile breakpoints for the ramp
  origin: null,
  mode: 'commute',      // 'commute' | 'rent'
  isoOverlay: null, officeMarker: null,
  rentLayer: null, lineLayer: null, stationLayer: null,
  sources: {},          // {streeteasy?, craigslist?} loaded listings files
  listings: null,       // active source {flagBits, listings: [[lat,lon,price,br,flags],...]}
  filtered: null,       // filtered listings (same row shape)
  rentsMeta: null,      // rents.json (label points + static fallback)
  labelMarkers: [],
  neighborhoodStats: [],
};

function walkMin(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * M_PER_LON;
  const dy = (lat2 - lat1) * M_PER_LAT;
  return Math.sqrt(dx * dx + dy * dy) / WALK_M_PER_MIN;
}

function median(sortedArr) {
  const n = sortedArr.length;
  if (!n) return null;
  return n % 2 ? sortedArr[(n - 1) / 2] : (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

function fmtK(v) { return `$${(v / 1000).toFixed(1)}k`; }

function bandColor(t) {
  for (const b of BANDS) if (t <= b.max) return b.color;
  return null;
}

function rentColor(v) {
  const br = state.rentBreaks;
  if (!br) return null;
  for (let i = 0; i < br.length; i++) if (v <= br[i]) return RENT_RAMP[i];
  return RENT_RAMP[RENT_RAMP.length - 1];
}

// ---- commute computation ----

function computeBest(origin) {
  const { stations, matrix, n } = state;
  const best = new Float32Array(n).fill(Infinity);
  const access = [];
  for (let a = 0; a < n; a++) {
    const w = walkMin(origin.lat, origin.lng, stations[a].lat, stations[a].lon);
    if (w <= STATION_WALK_CAP) access.push([a, w]);
  }
  for (let s = 0; s < n; s++) {
    let m = Infinity;
    for (const [a, w] of access) {
      const t = matrix[a * n + s];
      if (t < 255) {
        const v = w + t;
        if (v < m) m = v;
      }
    }
    best[s] = m;
  }
  state.best = best;
}

function paintDisc(grid, lat, lon, baseMin, capMin) {
  const rSpan = ((capMin - baseMin) * WALK_M_PER_MIN);
  if (rSpan <= 0) return;
  const dRow = Math.ceil(rSpan / (GRID.dLat * M_PER_LAT));
  const dCol = Math.ceil(rSpan / (GRID.dLon * M_PER_LON));
  const row0 = Math.floor((lat - GRID.lat0) / GRID.dLat);
  const col0 = Math.floor((lon - GRID.lon0) / GRID.dLon);
  for (let r = Math.max(0, row0 - dRow); r <= Math.min(GRID.rows - 1, row0 + dRow); r++) {
    const cellLat = GRID.lat0 + (r + 0.5) * GRID.dLat;
    for (let c = Math.max(0, col0 - dCol); c <= Math.min(GRID.cols - 1, col0 + dCol); c++) {
      const cellLon = GRID.lon0 + (c + 0.5) * GRID.dLon;
      const t = baseMin + walkMin(lat, lon, cellLat, cellLon);
      if (t <= capMin) {
        const i = r * GRID.cols + c;
        if (t < grid[i]) grid[i] = t;
      }
    }
  }
}

function computeGrid(origin) {
  const { stations, best, n } = state;
  const grid = new Float32Array(GRID.rows * GRID.cols).fill(Infinity);
  paintDisc(grid, origin.lat, origin.lng, 0, ORIGIN_WALK_CAP);
  for (let s = 0; s < n; s++) {
    const b = best[s];
    if (b < 120) paintDisc(grid, stations[s].lat, stations[s].lon, b, b + STATION_WALK_CAP);
  }
  state.grid = grid;
}

// ---- rent computation (filtered listings -> bins -> grid) ----

function currentFilter() {
  const brSel = document.getElementById('f-br').value;
  const bits = state.listings ? state.listings.flagBits : {};
  let mask = 0;
  for (const el of document.querySelectorAll('.f-amen:checked')) {
    mask |= bits[el.dataset.bit] || 0;
  }
  return { br: brSel === 'any' ? null : parseInt(brSel, 10), mask };
}

function applyFilter() {
  if (!state.listings) return;
  const { br, mask } = currentFilter();
  const out = [];
  for (const row of state.listings.listings) {
    if (br !== null && row[3] !== br) continue;
    if (mask && (row[4] & mask) !== mask) continue;
    out.push(row);
  }
  state.filtered = out;
  const el = document.getElementById('f-count');
  el.textContent = `${out.length.toLocaleString()} listings match`;
  computeRentStats();
}

function computeRentStats() {
  const rows = state.filtered || [];
  // quantile breaks for the ramp legend
  const prices = rows.map(r => r[2]).sort((a, b) => a - b);
  if (prices.length >= 20) {
    const q = p => prices[Math.min(prices.length - 1, Math.floor(p * prices.length))];
    state.rentBreaks = [q(0.2), q(0.4), q(0.6), q(0.8)];
  } else {
    state.rentBreaks = null;
  }

  // spatial bins
  const binRows = Math.ceil((GRID.lat1 - GRID.lat0) * M_PER_LAT / RENT_BIN_M);
  const binCols = Math.ceil((GRID.lon1 - GRID.lon0) * M_PER_LON / RENT_BIN_M);
  const bins = new Map();
  for (const row of rows) {
    const br_ = Math.floor((row[0] - GRID.lat0) * M_PER_LAT / RENT_BIN_M);
    const bc = Math.floor((row[1] - GRID.lon0) * M_PER_LON / RENT_BIN_M);
    if (br_ < 0 || br_ >= binRows || bc < 0 || bc >= binCols) continue;
    const k = br_ * binCols + bc;
    let arr = bins.get(k);
    if (!arr) bins.set(k, arr = []);
    arr.push(row[2]);
  }
  // per-bin 3x3-window median (~1 km), shared by all cells in the bin
  const binMedian = new Map();
  for (const k of bins.keys()) {
    const br_ = Math.floor(k / binCols), bc = k % binCols;
    const acc = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const kk = (br_ + dr) * binCols + (bc + dc);
      const arr = bins.get(kk);
      if (arr) acc.push(...arr);
    }
    if (acc.length >= RENT_MIN_N) {
      acc.sort((a, b) => a - b);
      binMedian.set(k, median(acc));
    }
  }
  // grid cells inherit their bin's value
  const rentGrid = new Float32Array(GRID.rows * GRID.cols).fill(NaN);
  for (let r = 0; r < GRID.rows; r++) {
    const cellLat = GRID.lat0 + (r + 0.5) * GRID.dLat;
    const br_ = Math.floor((cellLat - GRID.lat0) * M_PER_LAT / RENT_BIN_M);
    for (let c = 0; c < GRID.cols; c++) {
      const cellLon = GRID.lon0 + (c + 0.5) * GRID.dLon;
      const bc = Math.floor((cellLon - GRID.lon0) * M_PER_LON / RENT_BIN_M);
      const v = binMedian.get(br_ * binCols + bc);
      if (v !== undefined) rentGrid[r * GRID.cols + c] = v;
    }
  }
  state.rentGrid = rentGrid;

  computeNeighborhoodStats();
  refreshLabels();
  renderIso();
  renderScatter();
  renderLegend();
}

function computeNeighborhoodStats() {
  const rows = state.filtered || [];
  const stats = [];
  if (!state.rentsMeta) return;
  for (const nb of state.rentsMeta.neighborhoods) {
    const acc = [];
    for (const row of rows) {
      const dx = (row[1] - nb.lon) * M_PER_LON;
      const dy = (row[0] - nb.lat) * M_PER_LAT;
      if (dx * dx + dy * dy <= LABEL_RADIUS_M * LABEL_RADIUS_M) acc.push(row[2]);
    }
    acc.sort((a, b) => a - b);
    const commute = state.grid ? timeAt({ lat: nb.lat, lng: nb.lon }) : null;
    stats.push({
      nb, n: acc.length,
      median: acc.length >= LABEL_MIN_N ? median(acc) : null,
      commute,
    });
  }
  state.neighborhoodStats = stats;
}

// ---- overlay rendering ----

function bandIndex(t) {
  for (let i = 0; i < BANDS.length; i++) if (t <= BANDS[i].max) return i;
  return -1;
}

// value view: intensity = rent tercile WITHIN each commute band.
// full brightness = cheap for how close it is (the spatial Pareto read).
const VALUE_SCALE = [1.0, 0.62, 0.34];

function computeBandTerciles() {
  const commute = state.grid, rent = state.rentGrid;
  if (!commute || !rent) return null;
  const byBand = BANDS.map(() => []);
  for (let i = 0; i < commute.length; i++) {
    const t = commute[i];
    const v = rent[i];
    if (t === Infinity || Number.isNaN(v)) continue;
    const b = bandIndex(t);
    if (b >= 0) byBand[b].push(v);
  }
  return byBand.map(arr => {
    if (arr.length < 6) return null;
    arr.sort((a, b) => a - b);
    return [arr[Math.floor(arr.length / 3)], arr[Math.floor(2 * arr.length / 3)]];
  });
}

function renderIso() {
  const canvas = document.createElement('canvas');
  canvas.width = GRID.cols;
  canvas.height = GRID.rows;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(GRID.cols, GRID.rows);
  const px = img.data;
  const commute = state.grid;
  const rent = state.rentGrid;
  const mode = state.mode;
  const terciles = mode === 'value' ? computeBandTerciles() : null;
  for (let r = 0; r < GRID.rows; r++) {
    const gr = GRID.rows - 1 - r; // canvas row 0 = top = max lat
    for (let c = 0; c < GRID.cols; c++) {
      const gi = gr * GRID.cols + c;
      let col = null;
      let alpha = ISO_ALPHA;
      if (mode === 'commute') {
        const t = commute ? commute[gi] : Infinity;
        if (t !== Infinity) col = bandColor(t);
      } else if (mode === 'rent') {
        const v = rent ? rent[gi] : NaN;
        if (!Number.isNaN(v)) col = rentColor(v);
      } else {
        const t = commute ? commute[gi] : Infinity;
        if (t !== Infinity) {
          const b = bandIndex(t);
          const base = BANDS[b].color;
          const v = rent ? rent[gi] : NaN;
          const tc = terciles && terciles[b];
          if (!Number.isNaN(v) && tc) {
            const k = v <= tc[0] ? 0 : v <= tc[1] ? 1 : 2;
            const s = VALUE_SCALE[k];
            col = [base[0] * s, base[1] * s, base[2] * s];
          } else {
            // commute known, rent unknown: ghost the band so shape survives
            col = base;
            alpha = 55;
          }
        }
      }
      if (!col) continue;
      const o = (r * GRID.cols + c) * 4;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  const bounds = [[GRID.lat0, GRID.lon0], [GRID.lat1, GRID.lon1]];
  if (state.isoOverlay) {
    state.isoOverlay.setUrl(url);
  } else {
    state.isoOverlay = L.imageOverlay(url, bounds, {
      pane: 'iso', className: 'iso-img', interactive: false,
    }).addTo(map);
  }
}

function renderLegend() {
  const el = document.getElementById('legend');
  if (state.mode === 'value') {
    const cols = BANDS.map((b, i) => {
      const cells = VALUE_SCALE.map(s =>
        `<i style="background:rgb(${Math.round(b.color[0]*s)},${Math.round(b.color[1]*s)},${Math.round(b.color[2]*s)})"></i>`
      ).join('');
      const lab = i === 0 ? '&le;20' : i === BANDS.length - 1 ? '65+' : `${BANDS[i - 1].max}&ndash;${b.max}`;
      return `<div class="v-col">${cells}<span>${lab}</span></div>`;
    }).join('');
    el.innerHTML = `<div class="v-grid"><div class="v-axis"><span>cheap</span><span>for the band</span><span>pricey</span></div>${cols}</div>
      <div class="v-note">bright = best value at that commute · faint = no listing data · min</div>`;
    return;
  }
  if (state.mode === 'commute') {
    el.innerHTML = BANDS.map((b, i) => {
      const lab = i === 0 ? '&le;20' : i === BANDS.length - 1 ? '65+ min'
        : `${BANDS[i - 1].max}&ndash;${b.max}`;
      const c = b.color;
      return `<span class="band"><i style="background:rgb(${c[0]},${c[1]},${c[2]})"></i>${lab}</span>`;
    }).join('');
  } else if (state.rentBreaks) {
    const stops = [null, ...state.rentBreaks];
    el.innerHTML = RENT_RAMP.map((c, i) => {
      const lab = i === 0 ? `&lt;${fmtK(state.rentBreaks[0])}`
        : i === RENT_RAMP.length - 1 ? `${fmtK(state.rentBreaks[3])}+`
        : `${fmtK(stops[i])}&ndash;${fmtK(state.rentBreaks[i])}`;
      return `<span class="band"><i style="background:rgb(${c[0]},${c[1]},${c[2]})"></i>${lab}</span>`;
    }).join('');
  } else {
    el.innerHTML = '<span class="band">not enough listings match — loosen the filters</span>';
  }
}

function timeAt(latlng) {
  const r = Math.floor((latlng.lat - GRID.lat0) / GRID.dLat);
  const c = Math.floor((latlng.lng - GRID.lon0) / GRID.dLon);
  if (r < 0 || r >= GRID.rows || c < 0 || c >= GRID.cols) return null;
  const t = state.grid ? state.grid[r * GRID.cols + c] : Infinity;
  return t === Infinity ? null : t;
}

function rentAt(latlng) {
  const r = Math.floor((latlng.lat - GRID.lat0) / GRID.dLat);
  const c = Math.floor((latlng.lng - GRID.lon0) / GRID.dLon);
  if (r < 0 || r >= GRID.rows || c < 0 || c >= GRID.cols) return null;
  const v = state.rentGrid ? state.rentGrid[r * GRID.cols + c] : NaN;
  return Number.isNaN(v) ? null : v;
}

function setOrigin(latlng, label) {
  state.origin = latlng;
  localStorage.setItem('commute-map-origin', JSON.stringify([latlng.lat, latlng.lng]));
  const t0 = performance.now();
  computeBest(latlng);
  computeGrid(latlng);
  computeNeighborhoodStats();
  refreshLabels();
  renderIso();
  renderScatter();
  console.log(`isochrone recomputed in ${(performance.now() - t0).toFixed(0)} ms`);

  if (!state.officeMarker) {
    const icon = L.divIcon({
      className: 'office-marker',
      html: '<div class="dot"></div><div class="tag">office</div>',
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    state.officeMarker = L.marker(latlng, { icon, draggable: true, keyboard: false }).addTo(map);
    state.officeMarker.on('dragend', () => setOrigin(state.officeMarker.getLatLng()));
  } else {
    state.officeMarker.setLatLng(latlng);
  }

  let nearest = null, nd = Infinity;
  for (const s of state.stations) {
    const d = walkMin(latlng.lat, latlng.lng, s.lat, s.lon);
    if (d < nd) { nd = d; nearest = s; }
  }
  document.getElementById('origin-name').textContent =
    label || (nearest && nd < 20 ? `near ${nearest.name}` : `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`);
  refreshStationPopups();
}

// ---- static layers ----

function buildLines(lines) {
  const layer = L.layerGroup([], { pane: 'lines' });
  for (const route of lines) {
    for (const path of route.paths) {
      L.polyline(path, {
        pane: 'lines', color: '#ffffff', weight: 1.2, opacity: 0.22, interactive: false,
      }).addTo(layer);
    }
  }
  state.lineLayer = layer.addTo(map);
}

function stationRadius() {
  const z = map.getZoom();
  return z >= 14 ? 3.5 : z >= 12 ? 2.4 : 1.4;
}

function buildStations() {
  const layer = L.layerGroup([], { pane: 'lines' });
  const renderer = L.canvas({ pane: 'lines' });
  state.stationMarkers = state.stations.map((s, i) => {
    const m = L.circleMarker([s.lat, s.lon], {
      pane: 'lines', renderer,
      radius: stationRadius(),
      color: 'rgba(255,255,255,0.75)', weight: 1,
      fillColor: '#1a1a1a', fillOpacity: 0.9,
    }).addTo(layer);
    m._stationIdx = i;
    m.bindPopup(() => stationPopupHtml(i));
    return m;
  });
  state.stationLayer = layer.addTo(map);
  map.on('zoomend', () => {
    const r = stationRadius();
    for (const m of state.stationMarkers) m.setRadius(r);
  });
}

function stationPopupHtml(i) {
  const s = state.stations[i];
  const t = state.best ? state.best[i] : Infinity;
  const tt = t === Infinity ? 'not reachable' : `~${Math.round(t)} min from office`;
  return `<b>${s.name}</b><br>${s.routes.join(' · ')}<br>${tt}`;
}

function refreshStationPopups() {
  if (!state.stationMarkers) return;
  for (const m of state.stationMarkers) {
    if (m.isPopupOpen()) m.setPopupContent(stationPopupHtml(m._stationIdx));
  }
}

// ---- rent labels (live medians when listings are loaded) ----

function buildRents(rents) {
  state.rentsMeta = rents;
  const layer = L.layerGroup();
  state.labelMarkers = rents.neighborhoods.map((nb) => {
    const m = L.marker([nb.lat, nb.lon], {
      icon: L.divIcon({ className: '', html: '', iconSize: [130, 32], iconAnchor: [65, 16] }),
      interactive: false, keyboard: false,
    });
    m._nb = nb;
    m._primary = nb.src === 'streeteasy';
    return m;
  });
  const refreshDensity = () => {
    const showAll = map.getZoom() >= 12;
    for (const m of state.labelMarkers) {
      const want = showAll || m._primary;
      if (want && !layer.hasLayer(m)) layer.addLayer(m);
      if (!want && layer.hasLayer(m)) layer.removeLayer(m);
    }
  };
  refreshDensity();
  map.on('zoomend', refreshDensity);
  state.rentLayer = layer.addTo(map);
  refreshLabels();
}

function refreshLabels() {
  if (!state.labelMarkers.length) return;
  const stats = state.neighborhoodStats;
  const byName = new Map(stats.map(s => [s.nb.name, s]));
  for (const m of state.labelMarkers) {
    const nb = m._nb;
    const st = byName.get(nb.name);
    let priceHtml;
    if (state.listings && st && st.median !== null) {
      priceHtml = `<div class="price">${fmtK(st.median)} · ${st.n} listings</div>`;
    } else if (state.listings) {
      priceHtml = `<div class="price approx">n &lt; ${LABEL_MIN_N}</div>`;
    } else {
      priceHtml = `<div class="price${nb.src !== 'streeteasy' ? ' approx' : ''}">${fmtK(nb.rent)} studio${nb.src !== 'streeteasy' ? '~' : ''}</div>`;
    }
    const el = m.getElement();
    const html = `<div class="rent-label"><div>${nb.name}</div>${priceHtml}</div>`;
    if (el) el.innerHTML = html;
    else m.setIcon(L.divIcon({ className: '', html, iconSize: [130, 32], iconAnchor: [65, 16] }));
  }
}

// ---- scatter: rent vs commute, Pareto frontier ----

function renderScatter() {
  const host = document.getElementById('scatter');
  if (!host || host.classList.contains('collapsed')) return;
  const stats = (state.neighborhoodStats || []).filter(s => s.median !== null && s.commute !== null);
  const svgW = 300, svgH = 210, mL = 44, mB = 26, mT = 8, mR = 10;
  if (stats.length < 3) {
    host.querySelector('.scatter-body').innerHTML =
      '<div class="scatter-empty">not enough neighborhoods match the filters</div>';
    return;
  }
  const xs = stats.map(s => s.commute), ys = stats.map(s => s.median);
  const xMax = Math.min(80, Math.max(...xs) + 5);
  const yMin = Math.floor(Math.min(...ys) / 500) * 500;
  const yMax = Math.ceil(Math.max(...ys) / 500) * 500;
  const X = v => mL + (v / xMax) * (svgW - mL - mR);
  const Y = v => svgH - mB - ((v - yMin) / (yMax - yMin || 1)) * (svgH - mB - mT);

  // Pareto frontier: cheapest rent among neighborhoods at or under each commute
  const sorted = [...stats].sort((a, b) => a.commute - b.commute);
  const pareto = [];
  let bestRent = Infinity;
  for (const s of sorted) {
    if (s.median < bestRent) { bestRent = s.median; pareto.push(s); }
  }
  const paretoSet = new Set(pareto);

  let g = '';
  // gridlines + axes
  for (let x = 20; x < xMax; x += 20) {
    g += `<line x1="${X(x)}" y1="${mT}" x2="${X(x)}" y2="${svgH - mB}" class="sc-grid"/>`;
    g += `<text x="${X(x)}" y="${svgH - mB + 14}" class="sc-tick" text-anchor="middle">${x}</text>`;
  }
  for (let y = yMin; y <= yMax; y += 1000) {
    g += `<line x1="${mL}" y1="${Y(y)}" x2="${svgW - mR}" y2="${Y(y)}" class="sc-grid"/>`;
    g += `<text x="${mL - 5}" y="${Y(y) + 3.5}" class="sc-tick" text-anchor="end">${(y / 1000)}k</text>`;
  }
  g += `<text x="${(mL + svgW - mR) / 2}" y="${svgH - 2}" class="sc-axis" text-anchor="middle">commute (min)</text>`;
  // frontier step line
  if (pareto.length > 1) {
    let dPath = `M ${X(pareto[0].commute)} ${Y(pareto[0].median)}`;
    for (let i = 1; i < pareto.length; i++) {
      dPath += ` H ${X(pareto[i].commute)} V ${Y(pareto[i].median)}`;
    }
    g += `<path d="${dPath}" class="sc-frontier"/>`;
  }
  // dots, band-colored by commute (redundant with x position)
  for (const s of stats) {
    const c = bandColor(s.commute) || [150, 150, 150];
    const onF = paretoSet.has(s);
    g += `<circle cx="${X(s.commute)}" cy="${Y(s.median)}" r="${onF ? 4.5 : 3.2}"
      fill="rgb(${c[0]},${c[1]},${c[2]})" class="sc-dot${onF ? ' sc-pareto' : ''}"
      data-name="${s.nb.name}" data-lat="${s.nb.lat}" data-lon="${s.nb.lon}"
      data-lab="${s.nb.name} — ${fmtK(s.median)}, ~${Math.round(s.commute)} min (${s.n} listings)"/>`;
  }
  // direct labels for frontier points (cap at 7), minutes kept, staggered to avoid pileups
  pareto.slice(0, 7).forEach((s, i) => {
    let yOff = i % 2 ? 13 : -7;
    if (Y(s.median) < mT + 14) yOff = 13;
    if (Y(s.median) > svgH - mB - 14) yOff = -7;
    g += `<text x="${X(s.commute) + 4}" y="${Y(s.median) + yOff}" class="sc-lab">${s.nb.name} · ${Math.round(s.commute)}m</text>`;
  });
  host.querySelector('.scatter-body').innerHTML =
    `<svg viewBox="0 0 ${svgW} ${svgH}" width="100%">${g}</svg><div class="sc-tip" id="sc-tip"></div>`;

  const tip = document.getElementById('sc-tip');
  for (const dot of host.querySelectorAll('.sc-dot')) {
    dot.addEventListener('mouseenter', () => { tip.textContent = dot.dataset.lab; });
    dot.addEventListener('mouseleave', () => { tip.textContent = ''; });
    dot.addEventListener('click', () => {
      map.setView([parseFloat(dot.dataset.lat), parseFloat(dot.dataset.lon)], 14);
    });
  }
}

// ---- combined source: StreetEasy + Craigslist, de-duplicated ----

const DUP_RADIUS_M = 150; // CL pins are fuzzy; same price+beds within this = same unit

function mergeSources(se, cl) {
  const byKey = new Map();
  for (const r of se.listings) {
    const k = r[2] + '|' + r[3];
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, arr = []);
    arr.push(r);
  }
  const extra = [];
  let dups = 0;
  for (const r of cl.listings) {
    const twin = (byKey.get(r[2] + '|' + r[3]) || []).some(s => {
      const dx = (s[1] - r[1]) * M_PER_LON, dy = (s[0] - r[0]) * M_PER_LAT;
      return dx * dx + dy * dy <= DUP_RADIUS_M * DUP_RADIUS_M;
    });
    if (twin) dups++; else extra.push(r);
  }
  // a filter is only honest if every source carries that bit — otherwise
  // checking it silently drops the whole source that lacks it
  const has = (src, bit) => src.listings.some(r => r[4] & bit);
  const availBits = {};
  for (const [name, bit] of Object.entries(se.flagBits)) {
    availBits[name] = cl.flagBits[name] === bit && has(se, bit) && has(cl, bit);
  }
  const listings = se.listings.concat(extra);
  return {
    flagBits: se.flagBits, availBits, listings, count: listings.length,
    source: `streeteasy + craigslist (${dups.toLocaleString()} dupes merged)`,
    // each source refreshes on its own schedule, so show both dates
    asOf: `SE ${monthOf(se.asOf)} · CL ${monthOf(cl.asOf)}`,
  };
}

// "2026-07-31" -> "Jul 2026"
function monthOf(iso) {
  const [y, m] = (iso || '').split('-').map(Number);
  if (!y || !m) return iso || '?';
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

// ---- wire-up ----

function setSource(name) {
  const src = state.sources[name];
  if (!src) return;
  state.listings = src;
  localStorage.setItem('commute-map-source', name);
  for (const n of ['both', 'streeteasy', 'craigslist']) {
    const btn = document.getElementById('src-' + n);
    if (btn) btn.classList.toggle('active', n === name);
  }
  document.getElementById('data-src').textContent =
    `${src.count.toLocaleString()} listings · ${src.source} · ${src.asOf}`;
  // A filter is only offered if the active source actually carries that bit
  // (e.g. "laundry in bldg" is StreetEasy-only, and StreetEasy has amenity
  // bits only for the sweeps that have been run) — grey the rest out rather
  // than let them silently match nothing.
  const bits = src.flagBits || {};
  let anyAvail = false;
  for (const el of document.querySelectorAll('.f-amen')) {
    const bit = bits[el.dataset.bit] || 0;
    const avail = src.availBits ? !!src.availBits[el.dataset.bit]
      : bit !== 0 && src.listings.some(r => r[4] & bit);
    anyAvail = anyAvail || avail;
    el.disabled = !avail;
    if (!avail) el.checked = false;
    el.closest('label').classList.toggle('unavailable', !avail);
    el.closest('label').title = avail ? '' : (src.availBits ? 'only one source has this' : 'not available from this source');
  }
  document.getElementById('src-note').textContent = anyAvail ? '' : 'no amenity data';
  applyFilter();
}

function setMode(mode) {
  state.mode = mode;
  for (const m of ['commute', 'rent', 'value']) {
    document.getElementById('mode-' + m).classList.toggle('active', mode === m);
  }
  renderIso();
  renderLegend();
}

async function init() {
  const optional = (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
  const [stations, matrixBuf, lines, rents, se, cl, legacy] = await Promise.all([
    fetch('data/stations.json').then(r => r.json()),
    fetch('data/matrix.bin').then(r => r.arrayBuffer()),
    fetch('data/lines.json').then(r => r.json()),
    fetch('data/rents.json').then(r => r.json()),
    optional('data/listings-streeteasy.json'),
    optional('data/listings-craigslist.json'),
    optional('data/listings.json'), // pre-source-split filename
  ]);
  state.stations = stations;
  const dv = new DataView(matrixBuf);
  state.n = dv.getUint32(0, true);
  state.matrix = new Uint8Array(matrixBuf, 4);
  if (state.n !== stations.length) throw new Error('matrix/stations mismatch');
  if (se) state.sources.streeteasy = se;
  if (cl || legacy) state.sources.craigslist = cl || legacy;
  if (se && state.sources.craigslist) state.sources.both = mergeSources(se, state.sources.craigslist);
  const listings = state.sources.both || se || cl || legacy;
  state.listings = listings;

  buildLines(lines);
  buildStations();
  buildRents(rents);

  // station-name search -> set office there
  const dl = document.getElementById('station-list');
  const names = new Map();
  for (const s of stations) {
    const label = `${s.name} (${s.routes.join('·')})`;
    if (!names.has(label)) {
      names.set(label, s);
      const opt = document.createElement('option');
      opt.value = label;
      dl.appendChild(opt);
    }
  }
  const searchEl = document.getElementById('station-search');
  searchEl.addEventListener('change', () => {
    const s = names.get(searchEl.value);
    if (s) {
      setOrigin(L.latLng(s.lat, s.lon), `near ${s.name}`);
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 13));
      searchEl.blur();
    }
  });

  let origin = DEFAULT_ORIGIN;
  const hash = location.hash.match(/^#(-?[\d.]+),(-?[\d.]+)$/);
  const saved = localStorage.getItem('commute-map-origin');
  if (hash) origin = [parseFloat(hash[1]), parseFloat(hash[2])];
  else if (saved) { try { origin = JSON.parse(saved); } catch (e) {} }

  if (listings) {
    document.getElementById('filters').style.display = '';
    for (const el of document.querySelectorAll('.f-amen, #f-br')) {
      el.addEventListener('change', applyFilter);
    }
    if (state.sources.streeteasy && state.sources.craigslist) {
      document.getElementById('src-row').style.display = '';
      document.getElementById('src-streeteasy').addEventListener('click', () => setSource('streeteasy'));
      document.getElementById('src-craigslist').addEventListener('click', () => setSource('craigslist'));
      document.getElementById('src-both').addEventListener('click', () => setSource('both'));
    }
  } else {
    document.getElementById('mode-rent').disabled = true;
    document.getElementById('mode-value').disabled = true;
    document.getElementById('scatter').style.display = 'none';
  }

  setOrigin(L.latLng(origin[0], origin[1]));
  if (listings) {
    const savedSrc = localStorage.getItem('commute-map-source');
    setSource(state.sources[savedSrc] ? savedSrc : state.sources.both ? 'both' : (state.sources.streeteasy ? 'streeteasy' : 'craigslist'));
    setMode('value');
  }
  renderLegend();

  map.on('click', (e) => setOrigin(e.latlng));

  // small screens: panel starts compact (title + mode + legend); tap title for the rest
  const panel = document.getElementById('panel');
  if (matchMedia('(max-width: 600px)').matches) panel.classList.add('compact');
  document.querySelector('.panel-title').addEventListener('click', () => {
    if (matchMedia('(max-width: 600px)').matches) panel.classList.toggle('compact');
  });

  map.on('mousemove', (e) => {
    const t = timeAt(e.latlng);
    const rv = rentAt(e.latlng);
    const parts = [];
    if (t != null) parts.push(`≈ ${Math.round(t)} min`);
    if (rv != null) parts.push(`${fmtK(rv)} median nearby`);
    document.getElementById('cursor-time').textContent = parts.join(' · ') || ' ';
  });

  document.getElementById('mode-commute').addEventListener('click', () => setMode('commute'));
  document.getElementById('mode-rent').addEventListener('click', () => setMode('rent'));
  document.getElementById('mode-value').addEventListener('click', () => setMode('value'));

  document.getElementById('toggle-rents').addEventListener('change', (e) => {
    e.target.checked ? state.rentLayer.addTo(map) : map.removeLayer(state.rentLayer);
  });
  document.getElementById('toggle-lines').addEventListener('change', (e) => {
    if (e.target.checked) { state.lineLayer.addTo(map); state.stationLayer.addTo(map); }
    else { map.removeLayer(state.lineLayer); map.removeLayer(state.stationLayer); }
  });
  document.getElementById('toggle-iso').addEventListener('change', (e) => {
    e.target.checked ? state.isoOverlay.addTo(map) : map.removeLayer(state.isoOverlay);
  });
  document.getElementById('scatter-head').addEventListener('click', () => {
    const sc = document.getElementById('scatter');
    sc.classList.toggle('collapsed');
    if (!sc.classList.contains('collapsed')) renderScatter();
  });
}

init().catch((e) => {
  document.getElementById('cursor-time').textContent = 'failed to load data: ' + e.message;
  console.error(e);
});
