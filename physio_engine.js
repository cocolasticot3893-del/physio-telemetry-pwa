/**
 * Moteur d'analyse physiologique et télémétrique 1 Hz (ES2022 pur, zéro dépendance).
 * Compatible navigateur (PWA / Web Worker) et Node.js (ESM).
 */

/* ============================================================================
 * Utilitaires numériques, statistiques & formatage
 * ========================================================================== */

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function toNumOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function positiveFinite(v) {
  const n = toNumOrNull(v);
  return n !== null && n > 0 ? n : null;
}

function meanArray(arr) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (isFiniteNum(v)) {
      sum += v;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function minArray(arr) {
  let m = Infinity;
  let found = false;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (isFiniteNum(v)) {
      if (v < m) m = v;
      found = true;
    }
  }
  return found ? m : null;
}

function maxArray(arr) {
  let m = -Infinity;
  let found = false;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (isFiniteNum(v)) {
      if (v > m) m = v;
      found = true;
    }
  }
  return found ? m : null;
}

function medianArray(arr) {
  const valid = [];
  for (let i = 0; i < arr.length; i += 1) {
    if (isFiniteNum(arr[i])) valid.push(arr[i]);
  }
  const n = valid.length;
  if (n === 0) return null;
  valid.sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function firstValid(arr, start = 0, end = arr.length, minExclusive = -Infinity) {
  for (let i = start; i < end; i += 1) {
    const v = arr[i];
    if (isFiniteNum(v) && v > minExclusive) return v;
  }
  return null;
}

function lastValid(arr, start = 0, end = arr.length, minExclusive = -Infinity) {
  for (let i = end - 1; i >= start; i -= 1) {
    const v = arr[i];
    if (isFiniteNum(v) && v > minExclusive) return v;
  }
  return null;
}

export function formatSecondsHms(totalSec) {
  if (!isFiniteNum(totalSec) || totalSec < 0) return "00:00:00";
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/* ============================================================================
 * Fonctions mathématiques : P-value Student-t exacte (Beta incomplète régularisée)
 * ========================================================================== */

function logGamma(z) {
  // Approximation de Lanczos (précision ~15 décimales)
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zm1 = z - 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i += 1) {
    x += p[i] / (zm1 + i);
  }
  const t = zm1 + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zm1 + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const MAX_ITER = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

function correlationPValue(r, df) {
  if (!isFiniteNum(r) || df <= 0) return null;
  const absR = Math.abs(r);
  if (absR >= 1 - 1e-12) return 0;
  const t2 = (df * r * r) / (1 - r * r);
  const x = df / (df + t2);
  const p = regularizedIncompleteBeta(df / 2, 0.5, x);
  return Math.min(1, Math.max(0, p));
}

/* ============================================================================
 * Corrélations Pearson, Spearman (gestion des ex-aequo) et Partielle
 * ========================================================================== */

function pearsonCorr(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom <= 1e-15) return null;
  return Math.max(-1, Math.min(1, num / denom));
}

function averageRanks(values) {
  const n = values.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i += 1) idx[i] = i;
  idx.sort((a, b) => values[a] - values[b]);

  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && values[idx[j]] === values[idx[i]]) {
      j += 1;
    }
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) {
      ranks[idx[k]] = avgRank;
    }
    i = j;
  }
  return ranks;
}

function computePairStats(xs, ys) {
  const n = xs.length;
  if (n < 3) {
    return { n, pearson_r: null, pearson_p: null, spearman_rho: null, spearman_p: null };
  }
  const r = pearsonCorr(xs, ys);
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const rho = pearsonCorr(rx, ry);
  return {
    n,
    pearson_r: r,
    pearson_p: r !== null ? correlationPValue(r, n - 2) : null,
    spearman_rho: rho,
    spearman_p: rho !== null ? correlationPValue(rho, n - 2) : null
  };
}

function computePartialCorrelation(xs, ys, zs) {
  const n = xs.length;
  if (n < 4) {
    return { n, r_partial: null, p_value: null, r_xy: null, r_xz: null, r_yz: null };
  }
  const rXY = pearsonCorr(xs, ys);
  const rXZ = pearsonCorr(xs, zs);
  const rYZ = pearsonCorr(ys, zs);
  if (rXY === null || rXZ === null || rYZ === null) {
    return { n, r_partial: null, p_value: null, r_xy: rXY, r_xz: rXZ, r_yz: rYZ };
  }
  const denomSq = (1 - rXZ * rXZ) * (1 - rYZ * rYZ);
  if (denomSq <= 1e-15) {
    return { n, r_partial: null, p_value: null, r_xy: rXY, r_xz: rXZ, r_yz: rYZ };
  }
  const rPartial = Math.max(-1, Math.min(1, (rXY - rXZ * rYZ) / Math.sqrt(denomSq)));
  return {
    n,
    r_partial: rPartial,
    p_value: correlationPValue(rPartial, n - 3),
    r_xy: rXY,
    r_xz: rXZ,
    r_yz: rYZ
  };
}

/* ============================================================================
 * 1. Normalisation des streams & Parseur CSV 1 Hz
 * ========================================================================== */

function extractStreamMap(rawStreams) {
  const map = new Map();
  if (!rawStreams) return map;

  if (Array.isArray(rawStreams)) {
    for (const item of rawStreams) {
      if (!item || typeof item !== "object") continue;
      const key = String(item.type ?? item.name ?? item.key ?? "").trim().toLowerCase();
      const data = Array.isArray(item.data) ? item.data : Array.isArray(item.values) ? item.values : null;
      if (key && data) map.set(key, data);
    }
    return map;
  }

  if (typeof rawStreams === "object") {
    for (const [rawKey, val] of Object.entries(rawStreams)) {
      const key = String(rawKey).trim().toLowerCase();
      if (Array.isArray(val)) {
        map.set(key, val);
      } else if (val && typeof val === "object" && Array.isArray(val.data)) {
        map.set(key, val.data);
      }
    }
  }
  return map;
}

function pickFirstStream(streamMap, aliases) {
  let fallback = null;
  for (const alias of aliases) {
    const arr = streamMap.get(alias);
    if (!Array.isArray(arr) || arr.length === 0) continue;
    if (fallback === null) fallback = arr;
    for (let i = 0; i < arr.length; i += 1) {
      if (toNumOrNull(arr[i]) !== null) {
        return arr;
      }
    }
  }
  return fallback;
}

function alignStream(rawArr, length) {
  const out = new Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = rawArr && i < rawArr.length ? toNumOrNull(rawArr[i]) : null;
  }
  return out;
}

/**
 * Normalise une activité (dict ou liste de streams Intervals.icu) en tableaux alignés de longueur N.
 */
export function normalizeActivityStreams({ meta = {}, intervals = null, streams = {} } = {}) {
  const streamMap = extractStreamMap(streams);
  const resolvedIntervals = Array.isArray(intervals)
    ? intervals
    : Array.isArray(meta?.icu_intervals)
      ? meta.icu_intervals
      : [];

  let N = 0;
  for (const arr of streamMap.values()) {
    if (Array.isArray(arr) && arr.length > N) N = arr.length;
  }

  const rawTime = pickFirstStream(streamMap, ["time", "secs", "seconds", "timestamp", "elapsed_time"]);
  const time = new Array(N);
  for (let i = 0; i < N; i += 1) {
    const t = rawTime && i < rawTime.length ? toNumOrNull(rawTime[i]) : null;
    if (t !== null) {
      time[i] = t;
    } else {
      time[i] = i === 0 ? 0 : time[i - 1] + 1;
    }
  }

  const watts = alignStream(pickFirstStream(streamMap, ["watts", "power", "power_w", "watts_calc"]), N);
  const heartrate = alignStream(pickFirstStream(streamMap, ["heartrate", "hr", "hr_bpm", "heart_rate", "ecg_hr"]), N);
  const cadence = alignStream(pickFirstStream(streamMap, ["cadence", "cad", "rpm", "cadence_rpm"]), N);
  const altitude = alignStream(pickFirstStream(streamMap, ["altitude", "fixed_altitude", "alt", "altitude_m", "elevation"]), N);
  const distance = alignStream(pickFirstStream(streamMap, ["distance", "dist", "distance_m"]), N);

  let speedMsRaw = pickFirstStream(streamMap, ["velocity_smooth", "speed_ms", "speed"]);
  let speedFromKmh = false;
  if (!speedMsRaw) {
    const kmhRaw = pickFirstStream(streamMap, ["speed_kmh", "kmh"]);
    if (kmhRaw) {
      speedMsRaw = kmhRaw;
      speedFromKmh = true;
    }
  }
  const speed_ms = alignStream(speedMsRaw, N);
  if (speedFromKmh) {
    for (let i = 0; i < N; i += 1) {
      if (speed_ms[i] !== null) speed_ms[i] /= 3.6;
    }
  } else if (!speedMsRaw && distance.some((v) => v !== null)) {
    // Repli depuis distance/temps si aucun flux vitesse n'est présent
    speed_ms[0] = 0;
    for (let i = 1; i < N; i += 1) {
      const dt = time[i] - time[i - 1];
      if (dt > 0 && dt <= 5 && distance[i] !== null && distance[i - 1] !== null) {
        const v = (distance[i] - distance[i - 1]) / dt;
        speed_ms[i] = v >= 0 && v <= 45 ? v : null;
      } else {
        speed_ms[i] = null;
      }
    }
  }

  const torque = alignStream(pickFirstStream(streamMap, ["torque"]), N);
  const ve = alignStream(
    pickFirstStream(streamMap, ["tidal_volume_min", "minute_ventilation", "ventilation", "ve", "tyme_minute_volume"]),
    N
  );
  const rf = alignStream(
    pickFirstStream(streamMap, ["respiration", "rf", "breath_rate", "tyme_breath_rate", "bf"]),
    N
  );

  // Conversion automatique cL -> L si médiane des valeurs positives > 10
  const vt_l = alignStream(pickFirstStream(streamMap, ["tidal_volume", "vt", "tyme_tidal_volume", "vt_l"]), N);
  const vtPos = [];
  for (let i = 0; i < N; i += 1) {
    if (vt_l[i] !== null && vt_l[i] > 0) vtPos.push(vt_l[i]);
  }
  const vtMed = medianArray(vtPos);
  if (vtMed !== null && vtMed > 10) {
    for (let i = 0; i < N; i += 1) {
      if (vt_l[i] !== null) vt_l[i] /= 100;
    }
  }

  const dfa_a1 = alignStream(pickFirstStream(streamMap, ["dfa_a1", "alpha1", "dfa_alpha1"]), N);
  const artifacts = alignStream(pickFirstStream(streamMap, ["artifacts", "artifact", "rr_artifacts", "hrv_artifacts"]), N);
  const tcore = alignStream(pickFirstStream(streamMap, ["core_temperature", "ciq_core_temperature", "tcore", "core_temp"]), N);
  const tskin = alignStream(pickFirstStream(streamMap, ["skin_temperature", "ciq_skin_temperature", "tskin", "skin_temp"]), N);
  const hsi = alignStream(pickFirstStream(streamMap, ["heat_strain_index", "hsi"]), N);
  const w_bal = alignStream(pickFirstStream(streamMap, ["w_bal", "w_prime_bal"]), N);

  const aligned = {
    time,
    watts,
    heartrate,
    cadence,
    altitude,
    distance,
    speed_ms,
    torque,
    ve,
    rf,
    vt_l,
    dfa_a1,
    artifacts,
    tcore,
    tskin,
    hsi,
    w_bal
  };

  return {
    meta: meta ?? {},
    intervals: resolvedIntervals,
    N,
    length: N,
    ...aligned,
    streams: aligned
  };
}

function splitCsvRow(line, delimiter) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTimeCellSeconds(raw, originEpochSec) {
  const num = toNumOrNull(raw);
  if (num !== null) return { sec: num, origin: originEpochSec };
  const s = String(raw ?? "").trim();
  if (!s) return { sec: null, origin: originEpochSec };

  // Format HH:MM:SS(.sss)
  const hmsMatch = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (hmsMatch) {
    const sec = Number(hmsMatch[1]) * 3600 + Number(hmsMatch[2]) * 60 + Number(hmsMatch[3]);
    return { sec, origin: originEpochSec };
  }

  // Format ISO datetime
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) {
    const epochSec = ms / 1000;
    const base = originEpochSec ?? epochSec;
    return { sec: epochSec - base, origin: base };
  }
  return { sec: null, origin: originEpochSec };
}

/**
 * Parse un fichier CSV 1 Hz local en objet activité normalisé prêt pour analyzeActivity().
 */
export function parseCsvTextToActivity(csvText, fileName = "local.csv") {
  if (typeof csvText !== "string" || !csvText.trim()) {
    return normalizeActivityStreams({ meta: { name: fileName, source: "csv" }, intervals: [], streams: {} });
  }

  const lines = csvText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

  if (lines.length < 2) {
    return normalizeActivityStreams({ meta: { name: fileName, source: "csv" }, intervals: [], streams: {} });
  }

  const headerLine = lines[0];
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semiCount = (headerLine.match(/;/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const delimiter = semiCount > commaCount && semiCount >= tabCount ? ";" : tabCount > commaCount ? "\t" : ",";

  const rawHeaders = splitCsvRow(headerLine, delimiter);
  const headers = rawHeaders.map((h) =>
    h
      .toLowerCase()
      .replace(/\[.*?\]|\(.*?\)/g, "")
      .trim()
      .replace(/[\s\-./]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );

  const columns = {};
  for (const h of headers) {
    if (h && !(h in columns)) columns[h] = [];
  }

  const timeCols = new Set(["time", "secs", "seconds", "timestamp", "elapsed_time"]);
  let originEpoch = null;

  for (let r = 1; r < lines.length; r += 1) {
    const row = splitCsvRow(lines[r], delimiter);
    for (let c = 0; c < headers.length; c += 1) {
      const h = headers[c];
      if (!h) continue;
      const cell = row[c] ?? "";
      if (timeCols.has(h)) {
        const parsed = parseTimeCellSeconds(cell, originEpoch);
        originEpoch = parsed.origin;
        columns[h].push(parsed.sec);
      } else {
        columns[h].push(toNumOrNull(cell));
      }
    }
  }

  const normalized = normalizeActivityStreams({
    meta: { name: fileName, source: "csv" },
    intervals: [],
    streams: columns
  });

  if (normalized.time.length > 0 && normalized.time[0] > 86400) {
    const t0 = normalized.time[0];
    for (let i = 0; i < normalized.time.length; i += 1) {
      normalized.time[i] -= t0;
    }
  }

  return normalized;
}

/* ============================================================================
 * Fenêtres glissantes causales O(N) sur grille temporelle
 * ========================================================================== */

/**
 * Calcule la moyenne glissante causale sur une fenêtre temporelle de `windowSec` secondes :
 * pour chaque indice i, moyenne des valeurs non nulles j <= i avec (time[i] - time[j]) < windowSec,
 * en coupant la fenêtre si un saut d'auto-pause > 10 s est franchi.
 */
function causalRollingMean(values, time, windowSec, { minSamples = 1, requireGapReset = true } = {}) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let start = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i += 1) {
    if (requireGapReset && i > 0 && time[i] - time[i - 1] > 10) {
      start = i;
      sum = 0;
      count = 0;
    }
    const v = values[i];
    if (isFiniteNum(v)) {
      sum += v;
      count += 1;
    }
    while (start < i && time[i] - time[start] >= windowSec) {
      const vs = values[start];
      if (isFiniteNum(vs)) {
        sum -= vs;
        count -= 1;
      }
      start += 1;
    }
    if (count >= minSamples) {
      out[i] = sum / count;
    }
  }
  return out;
}

function computeNormalizedPowerSlice(watts, time, startIdx, endIdx) {
  const len = endIdx - startIdx;
  if (len <= 0) return null;

  const subW = watts.slice(startIdx, endIdx);
  const subT = time.slice(startIdx, endIdx);
  const p30 = causalRollingMean(subW, subT, 30, { minSamples: 1, requireGapReset: true });

  // Méthode Coggan : on privilégie les échantillons >= 30 s ; si bloc < 30 s, repli sur la fenêtre disponible
  const warmThreshold = len >= 30 ? 29 : 0;
  let sumPow4 = 0;
  let count = 0;
  for (let k = warmThreshold; k < len; k += 1) {
    const p = p30[k];
    if (isFiniteNum(p)) {
      const p2 = p * p;
      sumPow4 += p2 * p2;
      count += 1;
    }
  }
  if (count === 0) return null;
  return Math.pow(sumPow4 / count, 0.25);
}

/* ============================================================================
 * Calcul de toutes les métriques d'un segment [startIdx, endIdx)
 * ========================================================================== */

function computeSegmentMetrics(s, startIdx, endIdx, metaInfo) {
  const { time, watts, heartrate, cadence, altitude, distance, speed_ms, torque, ve, rf, vt_l, dfa_a1, artifacts, tcore, tskin, hsi } = s;
  const clampedStart = Math.max(0, startIdx);
  const clampedEnd = Math.min(s.N, endIdx);
  if (clampedEnd <= clampedStart) return null;

  const tStart = time[clampedStart];
  const tLast = time[clampedEnd - 1];
  const elapsed_s = clampedEnd < s.N ? time[clampedEnd] - tStart : Math.max(1, tLast - tStart + 1);

  let duration_s = 0;
  for (let i = clampedStart; i < clampedEnd; i += 1) {
    if (i === clampedStart) {
      duration_s += 1;
    } else {
      const dt = time[i] - time[i - 1];
      if (dt > 0 && dt <= 5) duration_s += dt;
    }
  }

  const alt_start_m = firstValid(altitude, clampedStart, clampedEnd);
  const alt_end_m = lastValid(altitude, clampedStart, clampedEnd);
  const distStart = firstValid(distance, clampedStart, clampedEnd);
  const distEnd = lastValid(distance, clampedStart, clampedEnd);
  const distDelta = distStart !== null && distEnd !== null ? distEnd - distStart : null;
  const grade_pct =
    distDelta !== null && distDelta > 10 && alt_start_m !== null && alt_end_m !== null
      ? ((alt_end_m - alt_start_m) / distDelta) * 100
      : null;

  const speedArr = [];
  const pArr = [];
  const cadArr = [];
  const trqArr = [];
  const hrArr = [];
  const hrStart15 = [];
  const hrEnd15 = [];
  const veArr = [];
  const veEnd30 = [];
  const rfArr = [];
  const rfEnd30 = [];
  const vtArr = [];
  const vtEnd30 = [];
  const rfVtArr = [];
  const a1FiltAll = [];
  const a1Start30 = [];
  const a1End30 = [];
  const artArr = [];
  const tcArr = [];
  const tsArr = [];
  const gradTcTsArr = [];
  const hsiArr = [];

  for (let i = clampedStart; i < clampedEnd; i += 1) {
    const t = time[i];
    const inStart15 = t < tStart + 15;
    const inEnd15 = t > tLast - 15;
    const inStart30 = t < tStart + 30;
    const inEnd30 = t > tLast - 30;

    if (isFiniteNum(speed_ms[i])) speedArr.push(speed_ms[i]);
    if (isFiniteNum(watts[i])) pArr.push(watts[i]);
    if (isFiniteNum(cadence[i]) && cadence[i] > 0) cadArr.push(cadence[i]);

    if (isFiniteNum(torque[i])) {
      trqArr.push(torque[i]);
    } else if (isFiniteNum(watts[i]) && watts[i] > 0 && isFiniteNum(cadence[i]) && cadence[i] > 0) {
      trqArr.push(watts[i] / ((2 * Math.PI * cadence[i]) / 60));
    }

    if (isFiniteNum(heartrate[i]) && heartrate[i] > 0) {
      hrArr.push(heartrate[i]);
      if (inStart15) hrStart15.push(heartrate[i]);
      if (inEnd15) hrEnd15.push(heartrate[i]);
    }

    if (isFiniteNum(ve[i]) && ve[i] > 0) {
      veArr.push(ve[i]);
      if (inEnd30) veEnd30.push(ve[i]);
    }
    if (isFiniteNum(rf[i]) && rf[i] > 0) {
      rfArr.push(rf[i]);
      if (inEnd30) rfEnd30.push(rf[i]);
    }
    if (isFiniteNum(vt_l[i]) && vt_l[i] > 0) {
      vtArr.push(vt_l[i]);
      if (inEnd30) vtEnd30.push(vt_l[i]);
    }
    if (isFiniteNum(rf[i]) && rf[i] > 0 && isFiniteNum(vt_l[i]) && vt_l[i] > 0) {
      rfVtArr.push(rf[i] / vt_l[i]);
    }

    if (isFiniteNum(artifacts[i]) && artifacts[i] >= 0) {
      artArr.push(artifacts[i]);
    }

    const cleanArtifact = artifacts[i] === null || artifacts[i] < 5.0;
    if (isFiniteNum(dfa_a1[i]) && dfa_a1[i] > 0 && cleanArtifact) {
      a1FiltAll.push(dfa_a1[i]);
      if (inStart30) a1Start30.push(dfa_a1[i]);
      if (inEnd30) a1End30.push(dfa_a1[i]);
    }

    if (isFiniteNum(tcore[i]) && tcore[i] > 0) tcArr.push(tcore[i]);
    if (isFiniteNum(tskin[i]) && tskin[i] > 0) tsArr.push(tskin[i]);
    if (isFiniteNum(tcore[i]) && tcore[i] > 0 && isFiniteNum(tskin[i]) && tskin[i] > 0) {
      gradTcTsArr.push(tcore[i] - tskin[i]);
    }
    if (isFiniteNum(hsi[i])) hsiArr.push(hsi[i]);
  }

  const speed_kmh =
    speedArr.length > 0
      ? meanArray(speedArr) * 3.6
      : distDelta !== null && duration_s > 0
        ? (distDelta / duration_s) * 3.6
        : null;

  const p_avg_w = meanArray(pArr);
  const np_w = computeNormalizedPowerSlice(watts, time, clampedStart, clampedEnd);
  const p_max_w = maxArray(pArr);
  const cadence_rpm = meanArray(cadArr);
  const torque_nm = meanArray(trqArr);
  const hr_avg_bpm = meanArray(hrArr);
  const hr_start15_bpm = meanArray(hrStart15);
  const hr_end15_bpm = meanArray(hrEnd15);
  const hr_max_bpm = maxArray(hrArr);
  const ef_w_bpm = p_avg_w !== null && hr_avg_bpm !== null && hr_avg_bpm > 0 ? p_avg_w / hr_avg_bpm : null;

  const ve_avg = meanArray(veArr);
  const ve_end30 = meanArray(veEnd30);
  const ve_max = maxArray(veArr);
  const rf_avg = meanArray(rfArr);
  const rf_end30 = meanArray(rfEnd30);
  const rf_max = maxArray(rfArr);
  const vt_avg_l = meanArray(vtArr);
  const vt_end30_l = meanArray(vtEnd30);
  const ve_per_100w = ve_avg !== null && p_avg_w !== null && p_avg_w > 0 ? ve_avg / (p_avg_w / 100) : null;
  const rf_vt_ratio = rfVtArr.length > 0 ? meanArray(rfVtArr) : rf_avg !== null && vt_avg_l > 0 ? rf_avg / vt_avg_l : null;

  const alpha1_filt = meanArray(a1FiltAll);
  const alpha1_median = medianArray(a1FiltAll);
  const alpha1_start30 = meanArray(a1Start30);
  const alpha1_end30 = meanArray(a1End30);
  const artifacts_pct = meanArray(artArr);

  const tcore_start = tcArr.length > 0 ? tcArr[0] : null;
  const tcore_end = tcArr.length > 0 ? tcArr[tcArr.length - 1] : null;
  const tcore_max = maxArray(tcArr);
  const tskin_avg = meanArray(tsArr);
  const grad_tc_ts_avg = meanArray(gradTcTsArr);
  const hsi_avg = meanArray(hsiArr);
  const hsi_end = hsiArr.length > 0 ? hsiArr[hsiArr.length - 1] : null;
  const hsi_max = maxArray(hsiArr);

  return {
    id: metaInfo.id,
    label: metaInfo.label,
    kind: metaInfo.kind,
    series_id: metaInfo.series_id ?? null,
    start_idx: clampedStart,
    end_idx: clampedEnd,
    duration_s,
    elapsed_s,
    start_hms: formatSecondsHms(tStart),
    end_hms: formatSecondsHms(tLast),
    alt_start_m,
    alt_end_m,
    grade_pct,
    speed_kmh,
    p_avg_w,
    np_w,
    p_max_w,
    cadence_rpm,
    torque_nm,
    hr_avg_bpm,
    hr_start15_bpm,
    hr_end15_bpm,
    hr_max_bpm,
    ef_w_bpm,
    ve_avg,
    ve_end30,
    ve_max,
    rf_avg,
    rf_end30,
    rf_max,
    vt_avg_l,
    vt_end30_l,
    ve_per_100w,
    rf_vt_ratio,
    alpha1_filt,
    alpha1_median,
    alpha1_start30,
    alpha1_end30,
    artifacts_pct,
    tcore_start,
    tcore_end,
    tcore_max,
    tskin_avg,
    grad_tc_ts_avg,
    hsi_avg,
    hsi_end,
    hsi_max
  };
}

/* ============================================================================
 * Extraction / Segmentation des Intervalles & Séries
 * ========================================================================== */

function resolveIntervalIndices(iv, time, N) {
  let sIdx = toNumOrNull(iv.start_index);
  let eIdx = toNumOrNull(iv.end_index);
  if (sIdx === null && isFiniteNum(toNumOrNull(iv.start_time))) {
    const t0 = Number(iv.start_time);
    sIdx = time.findIndex((t) => t >= t0);
    if (sIdx < 0) sIdx = 0;
  }
  if (eIdx === null && isFiniteNum(toNumOrNull(iv.end_time))) {
    const t1 = Number(iv.end_time);
    const found = time.findIndex((t) => t >= t1);
    eIdx = found >= 0 ? found : N;
  }
  if (sIdx === null || eIdx === null) return null;
  sIdx = Math.max(0, Math.min(N, Math.round(sIdx)));
  eIdx = Math.max(0, Math.min(N, Math.round(eIdx)));
  return eIdx > sIdx ? { start_idx: sIdx, end_idx: eIdx } : null;
}

function buildIntervalSegments(s, cp) {
  const { time, watts, N } = s;
  if (N === 0) return { segments: [], segmentation_source: "none" };

  const rawDefs = [];
  let source = "auto_p15s";

  // 1) Priorité aux intervalles structurés icu_intervals
  const icuIntervals = Array.isArray(s.intervals) ? s.intervals : [];
  const parsedWork = [];
  const parsedRec = [];

  for (const iv of icuIntervals) {
    if (!iv || typeof iv !== "object") continue;
    const typeUpper = String(iv.type ?? "").trim().toUpperCase();
    const bounds = resolveIntervalIndices(iv, time, N);
    if (!bounds) continue;
    if (typeUpper === "WORK") {
      parsedWork.push({ ...bounds, label: iv.label || null });
    } else if (typeUpper === "RECOVERY" || typeUpper === "REST") {
      parsedRec.push({ ...bounds, label: iv.label || null });
    }
  }

  if (parsedWork.length > 0) {
    source = "icu_intervals";
    parsedWork.sort((a, b) => a.start_idx - b.start_idx);
    const firstStart = parsedWork[0].start_idx;
    const lastEnd = parsedWork[parsedWork.length - 1].end_idx;

    for (let k = 0; k < parsedWork.length; k += 1) {
      rawDefs.push({
        id: `work_${k + 1}`,
        label: parsedWork[k].label || `Int ${k + 1}`,
        kind: "work",
        start_idx: parsedWork[k].start_idx,
        end_idx: parsedWork[k].end_idx
      });
    }

    // Ajoute les RECOVERY adjacents compris entre les intervalles WORK
    let recCounter = 0;
    for (const rec of parsedRec) {
      if (rec.start_idx >= firstStart && rec.end_idx <= lastEnd) {
        recCounter += 1;
        rawDefs.push({
          id: `trans_${recCounter}`,
          label: rec.label || `Rec ${recCounter}`,
          kind: "transition",
          start_idx: rec.start_idx,
          end_idx: rec.end_idx
        });
      }
    }

    // Comble les transitions implicites entre WORK s'il n'y avait pas de RECOVERY explicite
    for (let k = 0; k < parsedWork.length - 1; k += 1) {
      const gapStart = parsedWork[k].end_idx;
      const gapEnd = parsedWork[k + 1].start_idx;
      if (gapEnd > gapStart) {
        const covered = parsedRec.some((r) => r.start_idx <= gapStart && r.end_idx >= gapEnd);
        if (!covered) {
          recCounter += 1;
          rawDefs.push({
            id: `trans_${recCounter}`,
            label: `Trans ${recCounter}`,
            kind: "transition",
            start_idx: gapStart,
            end_idx: gapEnd
          });
        }
      }
    }

    rawDefs.sort((a, b) => a.start_idx - b.start_idx);
  } else {
    // 2) Segmentation automatique P_15s >= 0.75 * CP pendant >= 60 s
    const p15 = causalRollingMean(watts, time, 15, { minSamples: 1, requireGapReset: true });
    const threshold = 0.75 * cp;
    let inRun = false;
    let runStart = 0;
    const autoWorks = [];

    for (let i = 0; i <= N; i += 1) {
      const above = i < N && p15[i] !== null && p15[i] >= threshold;
      if (above && !inRun) {
        inRun = true;
        runStart = i;
      } else if (!above && inRun) {
        inRun = false;
        const dur = time[i - 1] - time[runStart] + 1;
        if (dur >= 60) {
          autoWorks.push({ start_idx: runStart, end_idx: i });
        }
      }
    }

    for (let k = 0; k < autoWorks.length; k += 1) {
      rawDefs.push({
        id: `work_${k + 1}`,
        label: `Int ${k + 1}`,
        kind: "work",
        start_idx: autoWorks[k].start_idx,
        end_idx: autoWorks[k].end_idx
      });
      if (k < autoWorks.length - 1 && autoWorks[k + 1].start_idx > autoWorks[k].end_idx) {
        rawDefs.push({
          id: `trans_${k + 1}`,
          label: `Trans ${k + 1}`,
          kind: "transition",
          start_idx: autoWorks[k].end_idx,
          end_idx: autoWorks[k + 1].start_idx
        });
      }
    }
  }

  const segments = [];
  for (const def of rawDefs) {
    const seg = computeSegmentMetrics(s, def.start_idx, def.end_idx, def);
    if (seg) segments.push(seg);
  }

  return { segments, segmentation_source: source };
}

function activeSecondsBetween(s, startIdx, endIdx) {
  const { time, watts, speed_ms, cadence, distance } = s;
  let active = 0;
  for (let i = Math.max(1, startIdx + 1); i < endIdx; i += 1) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 5) continue;
    const movedDist = distance[i] !== null && distance[i - 1] !== null && distance[i] > distance[i - 1] + 0.1;
    const moving =
      (speed_ms[i] !== null && speed_ms[i] > 0.5) ||
      movedDist ||
      (watts[i] !== null && watts[i] > 0) ||
      (cadence[i] !== null && cadence[i] > 0) ||
      (speed_ms[i] === null && distance[i] === null && watts[i] === null);
    if (moving) active += dt;
  }
  return active;
}

function safeDiff(a, b) {
  return isFiniteNum(a) && isFiniteNum(b) ? a - b : null;
}

function safePctDiff(nextVal, prevVal) {
  if (!isFiniteNum(nextVal) || !isFiniteNum(prevVal) || Math.abs(prevVal) <= 1e-12) return null;
  return ((nextVal - prevVal) / prevVal) * 100;
}

function groupSeriesAndComputeDrift(s, segments) {
  const workSegs = segments.filter((seg) => seg.kind === "work");
  if (workSegs.length === 0) return [];

  const seriesList = [];
  let currentSeriesIdx = 1;
  let currentGroup = [workSegs[0]];
  workSegs[0].series_id = `Série ${currentSeriesIdx}`;

  for (let k = 1; k < workSegs.length; k += 1) {
    const prev = workSegs[k - 1];
    const curr = workSegs[k];
    const activeGap = activeSecondsBetween(s, prev.end_idx, curr.start_idx);
    if (activeGap < 600) {
      curr.series_id = `Série ${currentSeriesIdx}`;
      currentGroup.push(curr);
    } else {
      seriesList.push({ series_id: `Série ${currentSeriesIdx}`, intervals: currentGroup });
      currentSeriesIdx += 1;
      curr.series_id = `Série ${currentSeriesIdx}`;
      currentGroup = [curr];
    }
  }
  seriesList.push({ series_id: `Série ${currentSeriesIdx}`, intervals: currentGroup });

  // Rattache les transitions comprises entre deux WORK de la même série
  for (const seg of segments) {
    if (seg.kind !== "transition") continue;
    const prevWork = [...workSegs].reverse().find((w) => w.end_idx <= seg.start_idx);
    const nextWork = workSegs.find((w) => w.start_idx >= seg.end_idx);
    if (prevWork && nextWork && prevWork.series_id === nextWork.series_id) {
      seg.series_id = prevWork.series_id;
    }
  }

  return seriesList.map((grp) => {
    const ivs = grp.intervals;
    const first = ivs[0];
    const last = ivs[ivs.length - 1];
    const drift =
      ivs.length >= 2
        ? {
            from_id: first.id,
            to_id: last.id,
            from_label: first.label,
            to_label: last.label,
            delta_power_w: safeDiff(last.p_avg_w, first.p_avg_w),
            delta_cadence_rpm: safeDiff(last.cadence_rpm, first.cadence_rpm),
            delta_torque_nm: safeDiff(last.torque_nm, first.torque_nm),
            delta_hr_bpm: safeDiff(last.hr_avg_bpm, first.hr_avg_bpm),
            delta_ef_pct: safePctDiff(last.ef_w_bpm, first.ef_w_bpm),
            delta_ve_l_min: safeDiff(last.ve_avg, first.ve_avg),
            delta_ve_per_100w_pct: safePctDiff(last.ve_per_100w, first.ve_per_100w),
            delta_rf_vt_ratio: safeDiff(last.rf_vt_ratio, first.rf_vt_ratio),
            delta_alpha1: safeDiff(last.alpha1_filt, first.alpha1_filt),
            delta_tcore_c: safeDiff(last.tcore_end, first.tcore_end),
            series_tcore_rise_c: safeDiff(last.tcore_end, first.tcore_start),
            delta_hsi: safeDiff(last.hsi_avg, first.hsi_avg),
            delta_hsi_max: safeDiff(last.hsi_max, first.hsi_max)
          }
        : null;

    return {
      series_id: grp.series_id,
      interval_count: ivs.length,
      interval_ids: ivs.map((x) => x.id),
      interval_labels: ivs.map((x) => x.label),
      drift_1_to_n: drift
    };
  });
}

/* ============================================================================
 * Détection des incidents d'auto-pause en montée & pics de tachypnée
 * ========================================================================== */

function sliceFilteredAlpha1Mean(dfa_a1, artifacts, startIdx, endIdx) {
  const arr = [];
  for (let i = startIdx; i < endIdx; i += 1) {
    const clean = artifacts[i] === null || artifacts[i] < 5.0;
    if (isFiniteNum(dfa_a1[i]) && dfa_a1[i] > 0 && clean) arr.push(dfa_a1[i]);
  }
  return meanArray(arr);
}

function detectIncidentsAndTachypnea(s, cp, p60s) {
  const { time, watts, heartrate, ve, rf, dfa_a1, artifacts, tcore, tskin, hsi, N } = s;
  const incidents = [];

  for (let i = 1; i < N; i += 1) {
    const dt = time[i] - time[i - 1];
    if (dt < 15) continue;

    // Évalue les 180 s précédant le saut
    const tBefore = time[i - 1];
    let prev180Start = i - 1;
    while (prev180Start > 0 && tBefore - time[prev180Start - 1] <= 180) {
      prev180Start -= 1;
    }

    const prevPowers = [];
    let maxP60Prev = -Infinity;
    for (let j = prev180Start; j < i; j += 1) {
      if (isFiniteNum(watts[j])) prevPowers.push(watts[j]);
      if (isFiniteNum(p60s[j]) && p60s[j] > maxP60Prev) maxP60Prev = p60s[j];
    }
    const meanPrev180 = meanArray(prevPowers);
    const sustainedEffort =
      (meanPrev180 !== null && meanPrev180 >= 0.62 * cp) ||
      (Number.isFinite(maxP60Prev) && maxP60Prev >= 0.65 * cp);
    const thermalSpike =
      isFiniteNum(tcore[i]) && isFiniteNum(tcore[i - 1]) && tcore[i] - tcore[i - 1] >= 0.04;

    if (!sustainedEffort && !thermalSpike) continue;

    // Remonte la phase de freinage/décélération (P < 0.55 * CP) avant idx = i - 1
    let brakeStart = i;
    for (let k = i - 1; k >= 0; k -= 1) {
      if (tBefore - time[k] > 120) break;
      const p = watts[k] ?? 0;
      if (p < 0.55 * cp) {
        brakeStart = k;
      } else {
        break;
      }
    }

    // Phase 1 : Pré-incident (180 s avant brakeStart)
    const preEnd = brakeStart;
    const tRefPre = preEnd > 0 ? time[preEnd - 1] : tBefore;
    let preStart = preEnd;
    while (preStart > 0 && tRefPre - time[preStart - 1] <= 180) {
      preStart -= 1;
    }
    const preDuration = preEnd > preStart ? time[preEnd - 1] - time[preStart] + 1 : 0;
    const preIncident = {
      start_idx: preStart,
      end_idx: preEnd,
      duration_s: preDuration,
      p_avg_w: meanArray(watts.slice(preStart, preEnd)),
      hr_avg: meanArray(heartrate.slice(preStart, preEnd).filter((v) => v > 0)),
      rf_avg: meanArray(rf.slice(preStart, preEnd).filter((v) => v > 0)),
      ve_avg: meanArray(ve.slice(preStart, preEnd).filter((v) => v > 0)),
      alpha1_filt: sliceFilteredAlpha1Mean(dfa_a1, artifacts, preStart, preEnd),
      tcore_end: lastValid(tcore, preStart, preEnd)
    };

    // Phase 2 : Freinage [brakeStart, i)
    const brakeDur = brakeStart < i ? time[i - 1] - time[brakeStart] + 1 : 0;
    const brakeP = meanArray(watts.slice(brakeStart, i));
    const brakeVe = meanArray(ve.slice(brakeStart, i).filter((v) => v > 0));
    const braking = {
      start_idx: brakeStart,
      end_idx: i,
      duration_s: brakeDur,
      p_avg_w: brakeP,
      hr_avg: meanArray(heartrate.slice(brakeStart, i).filter((v) => v > 0)),
      rf_avg: meanArray(rf.slice(brakeStart, i).filter((v) => v > 0)),
      alpha1_filt: sliceFilteredAlpha1Mean(dfa_a1, artifacts, brakeStart, i),
      ve_per_100w: brakeVe !== null && brakeP !== null && brakeP > 10 ? brakeVe / (brakeP / 100) : null
    };

    // Phase 3 : Auto-pause (saut i-1 -> i)
    const auto_pause = {
      idx_before: i - 1,
      idx_after: i,
      time_before_hms: formatSecondsHms(time[i - 1]),
      time_after_hms: formatSecondsHms(time[i]),
      gap_s: dt,
      tcore_before: tcore[i - 1],
      tcore_after: tcore[i],
      delta_tcore: safeDiff(tcore[i], tcore[i - 1]),
      tskin_before: tskin[i - 1],
      tskin_after: tskin[i],
      hsi_before: hsi[i - 1],
      hsi_after: hsi[i],
      delta_hsi: safeDiff(hsi[i], hsi[i - 1]),
      hr_before: heartrate[i - 1],
      hr_after: heartrate[i],
      delta_hr: safeDiff(heartrate[i], heartrate[i - 1])
    };

    // Phase 4 : Reprise post-incident (jusqu'à +180 s, arrêt si autre gap >= 15 s)
    let postEnd = i + 1;
    while (postEnd < N && time[postEnd] - time[i] <= 180 && time[postEnd] - time[postEnd - 1] < 15) {
      postEnd += 1;
    }
    let postStart30End = i;
    while (postStart30End < postEnd && time[postStart30End] < time[i] + 30) {
      postStart30End += 1;
    }
    const postLastTime = time[postEnd - 1];
    let postEnd30Start = postEnd - 1;
    while (postEnd30Start > i && postLastTime - time[postEnd30Start - 1] < 30) {
      postEnd30Start -= 1;
    }

    const post_resume = {
      start_idx: i,
      end_idx: postEnd,
      duration_s: postLastTime - time[i] + 1,
      p_avg_w: meanArray(watts.slice(i, postEnd)),
      tcore_end: lastValid(tcore, i, postEnd),
      tskin_max: maxArray(tskin.slice(i, postEnd)),
      hsi_max: maxArray(hsi.slice(i, postEnd)),
      alpha1_start30: sliceFilteredAlpha1Mean(dfa_a1, artifacts, i, postStart30End),
      alpha1_end30: sliceFilteredAlpha1Mean(dfa_a1, artifacts, postEnd30Start, postEnd)
    };

    incidents.push({
      id: `incident_${incidents.length + 1}`,
      trigger: sustainedEffort && thermalSpike ? "sustained_climb+thermal_spike" : sustainedEffort ? "sustained_climb" : "thermal_spike",
      pre_incident: preIncident,
      braking,
      auto_pause,
      post_resume
    });
  }

  // Détection des épisodes de tachypnée hyperthermique (tcore >= 37.8 °C et rf >= 60 ou ve >= 155)
  const tachypnea_peaks = [];
  let inTach = false;
  let tachStart = 0;
  let lastTachIdx = 0;

  const flushTach = (startIdx, endIdx) => {
    const rfVals = [];
    const veVals = [];
    const tcVals = [];
    const pVals = [];
    const hrVals = [];
    const a1Vals = [];
    for (let k = startIdx; k <= endIdx; k += 1) {
      if (isFiniteNum(rf[k])) rfVals.push(rf[k]);
      if (isFiniteNum(ve[k])) veVals.push(ve[k]);
      if (isFiniteNum(tcore[k])) tcVals.push(tcore[k]);
      if (isFiniteNum(watts[k])) pVals.push(watts[k]);
      if (isFiniteNum(heartrate[k]) && heartrate[k] > 0) hrVals.push(heartrate[k]);
      const clean = artifacts[k] === null || artifacts[k] < 5.0;
      if (isFiniteNum(dfa_a1[k]) && dfa_a1[k] > 0 && clean) a1Vals.push(dfa_a1[k]);
    }
    tachypnea_peaks.push({
      start_idx: startIdx,
      end_idx: endIdx + 1,
      start_hms: formatSecondsHms(time[startIdx]),
      end_hms: formatSecondsHms(time[endIdx]),
      duration_s: time[endIdx] - time[startIdx] + 1,
      rf_max: maxArray(rfVals),
      ve_max: maxArray(veVals),
      tcore_max: maxArray(tcVals),
      p_avg_w: meanArray(pVals),
      hr_max: maxArray(hrVals),
      alpha1_min: minArray(a1Vals)
    });
  };

  for (let i = 0; i < N; i += 1) {
    const hot = isFiniteNum(tcore[i]) && tcore[i] >= 37.8;
    const tach = hot && ((isFiniteNum(rf[i]) && rf[i] >= 60) || (isFiniteNum(ve[i]) && ve[i] >= 155));
    if (tach) {
      if (!inTach) {
        inTach = true;
        tachStart = i;
      }
      lastTachIdx = i;
    } else if (inTach && time[i] - time[lastTachIdx] > 10) {
      flushTach(tachStart, lastTachIdx);
      inTach = false;
    }
  }
  if (inTach) {
    flushTach(tachStart, lastTachIdx);
  }

  return { auto_pause_incidents: incidents, tachypnea_peaks };
}

/* ============================================================================
 * Localisation des seuils SV1 / SV2 (Normothermie vs Hyperthermie)
 * ========================================================================== */

function computeThresholdBand(s, indices, a1Min, a1Max) {
  const { watts, heartrate, ve, rf, vt_l, dfa_a1 } = s;
  const wArr = [];
  const hrArr = [];
  const veArr = [];
  const rfVtArr = [];

  for (const i of indices) {
    const a1 = dfa_a1[i];
    if (a1 < a1Min || a1 > a1Max) continue;
    if (isFiniteNum(watts[i])) wArr.push(watts[i]);
    if (isFiniteNum(heartrate[i]) && heartrate[i] > 0) hrArr.push(heartrate[i]);
    if (isFiniteNum(ve[i]) && ve[i] > 0) veArr.push(ve[i]);
    if (isFiniteNum(rf[i]) && rf[i] > 0 && isFiniteNum(vt_l[i]) && vt_l[i] > 0) {
      rfVtArr.push(rf[i] / vt_l[i]);
    }
  }

  return {
    n: wArr.length,
    watts: medianArray(wArr),
    hr: medianArray(hrArr),
    ve: medianArray(veArr),
    rf_vt: medianArray(rfVtArr)
  };
}

function computeThresholds(s) {
  const { watts, dfa_a1, artifacts, tcore, N } = s;
  const normoIdx = [];
  const hyperIdx = [];
  const allActiveIdx = [];

  for (let i = 0; i < N; i += 1) {
    const clean = artifacts[i] === null || artifacts[i] < 5.0;
    if (!isFiniteNum(watts[i]) || watts[i] <= 80 || !isFiniteNum(dfa_a1[i]) || dfa_a1[i] <= 0 || !clean) {
      continue;
    }
    allActiveIdx.push(i);
    if (isFiniteNum(tcore[i])) {
      if (tcore[i] < 37.8) normoIdx.push(i);
      else if (tcore[i] > 38.1) hyperIdx.push(i);
    }
  }

  const normothermic = {
    tcore_range: "< 37.8 °C",
    sample_count: normoIdx.length,
    sv1: computeThresholdBand(s, normoIdx, 0.7, 0.8),
    sv2: computeThresholdBand(s, normoIdx, 0.45, 0.55)
  };

  const hyperthermic = {
    tcore_range: "> 38.1 °C",
    sample_count: hyperIdx.length,
    sv1: computeThresholdBand(s, hyperIdx, 0.7, 0.8),
    sv2: computeThresholdBand(s, hyperIdx, 0.45, 0.55)
  };

  const overall = {
    tcore_range: "Toutes T_core",
    sample_count: allActiveIdx.length,
    sv1: computeThresholdBand(s, allActiveIdx, 0.7, 0.8),
    sv2: computeThresholdBand(s, allActiveIdx, 0.45, 0.55)
  };

  const sv1BiasW =
    normothermic.sv1.watts !== null && hyperthermic.sv1.watts !== null
      ? hyperthermic.sv1.watts - normothermic.sv1.watts
      : null;
  const sv2BiasW =
    normothermic.sv2.watts !== null && hyperthermic.sv2.watts !== null
      ? hyperthermic.sv2.watts - normothermic.sv2.watts
      : null;
  const biases = [sv1BiasW, sv2BiasW].filter(isFiniteNum);

  return {
    normothermic,
    hyperthermic,
    overall,
    thermal_bias_w: {
      sv1_w_diff: sv1BiasW,
      sv2_w_diff: sv2BiasW,
      sv1_loss_w: sv1BiasW !== null ? -sv1BiasW : null,
      sv2_loss_w: sv2BiasW !== null ? -sv2BiasW : null,
      mean_bias_w: biases.length > 0 ? meanArray(biases) : null
    }
  };
}

/* ============================================================================
 * Analyse croisée automatique (cadence, paradoxe thermique, dérive début/fin)
 * ========================================================================== */

function briefSeg(seg) {
  return {
    id: seg.id,
    label: seg.label,
    p_avg_w: seg.p_avg_w,
    cadence_rpm: seg.cadence_rpm,
    torque_nm: seg.torque_nm,
    hr_avg_bpm: seg.hr_avg_bpm,
    ef_w_bpm: seg.ef_w_bpm,
    alpha1_filt: seg.alpha1_filt,
    ve_avg: seg.ve_avg,
    ve_per_100w: seg.ve_per_100w,
    rf_avg: seg.rf_avg,
    tcore_end: seg.tcore_end,
    tcore_max: seg.tcore_max,
    hsi_avg: seg.hsi_avg,
    hsi_max: seg.hsi_max
  };
}

function computeCrossAnalysis(segments) {
  const works = segments.filter((seg) => seg.kind === "work" && isFiniteNum(seg.p_avg_w));

  // 1. Comparaison de cadence : ΔP < 25 W et ΔCad >= 15 rpm
  let bestCadPair = null;
  let bestCadScore = -Infinity;
  for (let i = 0; i < works.length; i += 1) {
    for (let j = i + 1; j < works.length; j += 1) {
      const a = works[i];
      const b = works[j];
      if (!isFiniteNum(a.cadence_rpm) || !isFiniteNum(b.cadence_rpm)) continue;
      const dP = Math.abs(a.p_avg_w - b.p_avg_w);
      const dCad = Math.abs(a.cadence_rpm - b.cadence_rpm);
      if (dP < 25 && dCad >= 15) {
        const score = dCad - 0.5 * dP;
        if (score > bestCadScore) {
          bestCadScore = score;
          bestCadPair = a.cadence_rpm <= b.cadence_rpm ? [a, b] : [b, a];
        }
      }
    }
  }

  const cadence_comparison = bestCadPair
    ? (() => {
        const [lowCad, highCad] = bestCadPair;
        return {
          found: true,
          low_cad_interval: briefSeg(lowCad),
          high_cad_interval: briefSeg(highCad),
          deltas: {
            delta_p_w: safeDiff(highCad.p_avg_w, lowCad.p_avg_w),
            delta_cadence_rpm: safeDiff(highCad.cadence_rpm, lowCad.cadence_rpm),
            delta_torque_nm: safeDiff(highCad.torque_nm, lowCad.torque_nm),
            delta_hr_bpm: safeDiff(highCad.hr_avg_bpm, lowCad.hr_avg_bpm),
            delta_ef_pct: safePctDiff(highCad.ef_w_bpm, lowCad.ef_w_bpm),
            delta_alpha1: safeDiff(highCad.alpha1_filt, lowCad.alpha1_filt),
            delta_ve_l_min: safeDiff(highCad.ve_avg, lowCad.ve_avg)
          }
        };
      })()
    : { found: false };

  // 2. Paradoxe thermique : bloc chaud basse puissance vs bloc refroidi puissance supérieure
  let bestParadox = null;
  let bestParadoxScore = -Infinity;
  for (let i = 0; i < works.length; i += 1) {
    for (let j = 0; j < works.length; j += 1) {
      if (i === j) continue;
      const hot = works[i];
      const cool = works[j];
      const pGain = cool.p_avg_w - hot.p_avg_w;
      if (pGain <= 15) continue;

      const tcHot = hot.tcore_end ?? hot.tcore_max;
      const tcCool = cool.tcore_end ?? cool.tcore_max;
      const tDrop = tcHot !== null && tcCool !== null ? tcHot - tcCool : null;
      const hsiDrop = hot.hsi_avg !== null && cool.hsi_avg !== null ? hot.hsi_avg - cool.hsi_avg : null;

      const isHotter = (tDrop !== null && tDrop >= 0.1) || (hsiDrop !== null && hsiDrop >= 0.4);
      if (!isHotter) continue;

      const score = pGain + (tDrop ?? 0) * 60 + (hsiDrop ?? 0) * 15;
      if (score > bestParadoxScore) {
        bestParadoxScore = score;
        bestParadox = [hot, cool];
      }
    }
  }

  const thermal_paradox = bestParadox
    ? (() => {
        const [hot, cool] = bestParadox;
        return {
          found: true,
          hot_low_interval: briefSeg(hot),
          cooled_high_interval: briefSeg(cool),
          deltas: {
            delta_p_w: safeDiff(cool.p_avg_w, hot.p_avg_w),
            delta_tcore_c: safeDiff(cool.tcore_end ?? cool.tcore_max, hot.tcore_end ?? hot.tcore_max),
            delta_hsi: safeDiff(cool.hsi_avg, hot.hsi_avg),
            delta_hr_bpm: safeDiff(cool.hr_avg_bpm, hot.hr_avg_bpm),
            delta_ef_pct: safePctDiff(cool.ef_w_bpm, hot.ef_w_bpm),
            delta_alpha1: safeDiff(cool.alpha1_filt, hot.alpha1_filt),
            delta_ve_per_100w_pct: safePctDiff(cool.ve_per_100w, hot.ve_per_100w)
          }
        };
      })()
    : { found: false };

  // 3. Dérive début vs fin à puissance comparable (ΔP < 30 W)
  let bestDriftPair = null;
  let bestSpanScore = -Infinity;
  const mid = Math.floor(works.length / 2);
  for (let i = 0; i < Math.max(1, mid); i += 1) {
    for (let j = Math.max(i + 1, mid); j < works.length; j += 1) {
      const early = works[i];
      const late = works[j];
      const dP = Math.abs(late.p_avg_w - early.p_avg_w);
      if (dP < 30) {
        const score = (j - i) * 10 - dP;
        if (score > bestSpanScore) {
          bestSpanScore = score;
          bestDriftPair = [early, late];
        }
      }
    }
  }

  const start_vs_end_drift = bestDriftPair
    ? (() => {
        const [early, late] = bestDriftPair;
        return {
          found: true,
          early_interval: briefSeg(early),
          late_interval: briefSeg(late),
          deltas: {
            delta_p_w: safeDiff(late.p_avg_w, early.p_avg_w),
            delta_hr_bpm: safeDiff(late.hr_avg_bpm, early.hr_avg_bpm),
            delta_ef_pct: safePctDiff(late.ef_w_bpm, early.ef_w_bpm),
            delta_alpha1: safeDiff(late.alpha1_filt, early.alpha1_filt),
            delta_ve_per_100w_pct: safePctDiff(late.ve_per_100w, early.ve_per_100w),
            delta_tcore_c: safeDiff(late.tcore_end, early.tcore_end),
            delta_hsi: safeDiff(late.hsi_avg, early.hsi_avg)
          }
        };
      })()
    : { found: false };

  return {
    cadence_comparison,
    thermal_paradox,
    start_vs_end_drift
  };
}

/* ============================================================================
 * 2. Pipeline principal d'analyse 1 Hz : analyzeActivity
 * ========================================================================== */

/**
 * Analyse physiologique complète à 1 Hz d'une activité brute ou déjà normalisée.
 */
export function analyzeActivity(rawActivity, options = {}) {
  const s =
    rawActivity && Array.isArray(rawActivity.time) && Array.isArray(rawActivity.watts) && rawActivity.streams
      ? rawActivity
      : normalizeActivityStreams(rawActivity ?? {});

  const meta = s.meta ?? {};
  const cp =
    positiveFinite(options?.cp) ??
    positiveFinite(meta.icu_pm_cp) ??
    positiveFinite(meta.icu_ftp) ??
    400;
  const wPrime =
    positiveFinite(options?.wPrime) ??
    positiveFinite(options?.w_prime) ??
    positiveFinite(meta.icu_pm_w_prime) ??
    positiveFinite(meta.icu_w_prime) ??
    25000;

  const {
    time,
    watts,
    heartrate,
    cadence,
    altitude,
    distance,
    speed_ms,
    torque,
    ve,
    rf,
    vt_l,
    dfa_a1,
    artifacts,
    tcore,
    tskin,
    hsi,
    w_bal,
    N
  } = s;

  if (N === 0) {
    return {
      meta,
      parameters: { cp, wPrime },
      sample_count: 0,
      segmentation_source: "none",
      global: { moving_time_s: 0, elapsed_time_s: 0, paused_s: 0 },
      correlations: { pairs: {}, partial: {} },
      intervals: [],
      series: [],
      incidents: { auto_pause_incidents: [], tachypnea_peaks: [] },
      thresholds: computeThresholds(s),
      cross_analysis: { cadence_comparison: { found: false }, thermal_paradox: { found: false }, start_vs_end_drift: { found: false } }
    };
  }

  // --- Temps actif / écoulé / pauses & dénivelé / travail mécanique ---
  const elapsed_time_s = N > 1 ? Math.max(0, time[N - 1] - time[0]) : 0;
  let moving_time_s = 0;
  let workJ = 0;
  let distance_m_integrated = 0;

  // Hystérésis altitude 0.5 m
  let elevation_gain_m = 0;
  let altAnchor = firstValid(altitude, 0, N);
  if (altAnchor !== null) {
    for (let i = 0; i < N; i += 1) {
      const alt = altitude[i];
      if (!isFiniteNum(alt)) continue;
      if (alt - altAnchor >= 0.5) {
        elevation_gain_m += alt - altAnchor;
        altAnchor = alt;
      } else if (altAnchor - alt >= 0.5) {
        altAnchor = alt;
      }
    }
  } else {
    elevation_gain_m = null;
  }

  for (let i = 0; i < N; i += 1) {
    const dt = i === 0 ? 0 : time[i] - time[i - 1];
    const movedDist = i > 0 && distance[i] !== null && distance[i - 1] !== null && distance[i] > distance[i - 1] + 0.1;
    const isMoving =
      (speed_ms[i] !== null && speed_ms[i] > 0.5) ||
      movedDist ||
      (watts[i] !== null && watts[i] > 0) ||
      (cadence[i] !== null && cadence[i] > 0) ||
      (speed_ms[i] === null && distance[i] === null && watts[i] === null);

    if (i > 0 && dt > 0 && dt <= 5) {
      if (isMoving) moving_time_s += dt;
      if (isFiniteNum(watts[i]) && watts[i] > 0) workJ += watts[i] * dt;
      if (isFiniteNum(speed_ms[i]) && speed_ms[i] > 0) distance_m_integrated += speed_ms[i] * dt;
    } else if (i === 0 && isFiniteNum(watts[0]) && watts[0] > 0) {
      workJ += watts[0];
    }
  }

  const paused_s = Math.max(0, elapsed_time_s - moving_time_s);
  const distFirst = firstValid(distance, 0, N);
  const distLast = lastValid(distance, 0, N);
  const distance_km =
    distFirst !== null && distLast !== null && distLast >= distFirst
      ? (distLast - distFirst) / 1000
      : distance_m_integrated > 0
        ? distance_m_integrated / 1000
        : null;
  const work_kj = watts.some(isFiniteNum) ? workJ / 1000 : null;

  // --- Puissance, NP, VI, IF, TSS ---
  const validWatts = watts.filter(isFiniteNum);
  const avg_power_w = meanArray(validWatts);
  const normalized_power_w = computeNormalizedPowerSlice(watts, time, 0, N);
  const variability_index =
    normalized_power_w !== null && avg_power_w !== null && avg_power_w > 0 ? normalized_power_w / avg_power_w : null;
  const intensity_factor = normalized_power_w !== null && cp > 0 ? normalized_power_w / cp : null;
  const tss =
    normalized_power_w !== null && intensity_factor !== null && moving_time_s > 0
      ? ((moving_time_s * normalized_power_w * intensity_factor) / (cp * 3600)) * 100
      : null;

  // --- Cardiaque & Découplage Pa:Hr ---
  const validHr = heartrate.filter((v) => isFiniteNum(v) && v > 0);
  const avg_hr_bpm = meanArray(validHr);
  const max_hr_bpm = maxArray(validHr);
  const ef_np = normalized_power_w !== null && avg_hr_bpm !== null && avg_hr_bpm > 0 ? normalized_power_w / avg_hr_bpm : null;
  const ef_avg = avg_power_w !== null && avg_hr_bpm !== null && avg_hr_bpm > 0 ? avg_power_w / avg_hr_bpm : null;

  const activePHrIndices = [];
  for (let i = 0; i < N; i += 1) {
    if (isFiniteNum(watts[i]) && watts[i] > 0 && isFiniteNum(heartrate[i]) && heartrate[i] > 0) {
      activePHrIndices.push(i);
    }
  }
  let aerobic_decoupling_pa_hr_pct = null;
  if (activePHrIndices.length >= 4) {
    const mid = Math.floor(activePHrIndices.length / 2);
    let p1 = 0;
    let h1 = 0;
    let p2 = 0;
    let h2 = 0;
    for (let k = 0; k < mid; k += 1) {
      const idx = activePHrIndices[k];
      p1 += watts[idx];
      h1 += heartrate[idx];
    }
    for (let k = mid; k < activePHrIndices.length; k += 1) {
      const idx = activePHrIndices[k];
      p2 += watts[idx];
      h2 += heartrate[idx];
    }
    const ef1 = h1 > 0 ? p1 / h1 : null;
    const ef2 = h2 > 0 ? p2 / h2 : null;
    if (ef1 !== null && ef2 !== null && ef1 > 0) {
      aerobic_decoupling_pa_hr_pct = ((ef1 - ef2) / ef1) * 100;
    }
  }

  // --- Cadence & Couple ---
  const validCad = cadence.filter((v) => isFiniteNum(v) && v > 0);
  const avg_cadence_rpm = meanArray(validCad);
  const trqSamples = [];
  for (let i = 0; i < N; i += 1) {
    if (isFiniteNum(torque[i])) {
      trqSamples.push(torque[i]);
    } else if (isFiniteNum(watts[i]) && watts[i] > 0 && isFiniteNum(cadence[i]) && cadence[i] > 0) {
      trqSamples.push(watts[i] / ((2 * Math.PI * cadence[i]) / 60));
    }
  }
  const avg_torque_nm = meanArray(trqSamples);

  // --- Modèle W'bal de Skiba 1 Hz avec prise en compte de dt ---
  let wBal = wPrime;
  let wPrimeMinSkiba = wPrime;
  const hasWatts = validWatts.length > 0;
  if (hasWatts) {
    for (let i = 0; i < N; i += 1) {
      const p = isFiniteNum(watts[i]) ? watts[i] : 0;
      const rawDt = i === 0 ? 1 : time[i] - time[i - 1];
      if (rawDt <= 0) continue;

      if (rawDt > 5) {
        // Pendant un saut d'auto-pause > 5 s, l'athlète récupère à P = 0 sur (rawDt - 1) s puis applique l'échantillon i
        const pauseDt = rawDt - 1;
        wBal = wPrime - (wPrime - wBal) * Math.exp((-cp * pauseDt) / wPrime);
        const stepDt = 1;
        if (p > cp) {
          wBal -= (p - cp) * stepDt;
        } else {
          wBal = wPrime - (wPrime - wBal) * Math.exp((-(cp - p) * stepDt) / wPrime);
        }
      } else {
        const dt = Math.max(1, rawDt);
        if (p > cp) {
          wBal -= (p - cp) * dt;
        } else {
          wBal = wPrime - (wPrime - wBal) * Math.exp((-(cp - p) * dt) / wPrime);
        }
      }
      if (wBal < wPrimeMinSkiba) wPrimeMinSkiba = wBal;
    }
  }
  const wBalStreamMin = minArray(w_bal);
  const w_prime_bal_min_j = hasWatts ? wPrimeMinSkiba : wBalStreamMin;
  const w_prime_max_depletion_pct =
    w_prime_bal_min_j !== null && wPrime > 0 ? ((wPrime - w_prime_bal_min_j) / wPrime) * 100 : null;
  const w_prime_min_pct = w_prime_bal_min_j !== null && wPrime > 0 ? (w_prime_bal_min_j / wPrime) * 100 : null;

  // --- Ventilation TymeWear ---
  const validVe = ve.filter((v) => isFiniteNum(v) && v > 0);
  const validRf = rf.filter((v) => isFiniteNum(v) && v > 0);
  const validVt = vt_l.filter((v) => isFiniteNum(v) && v > 0);
  const ve_mean = meanArray(validVe);
  const ve_max = maxArray(validVe);
  const rf_mean = meanArray(validRf);
  const rf_max = maxArray(validRf);
  const vt_mean_l = meanArray(validVt);

  const veActive = [];
  const pActiveForVe = [];
  const rfVtSamples = [];
  for (let i = 0; i < N; i += 1) {
    if (isFiniteNum(ve[i]) && ve[i] > 0 && isFiniteNum(watts[i]) && watts[i] > 50) {
      veActive.push(ve[i]);
      pActiveForVe.push(watts[i]);
    }
    if (isFiniteNum(rf[i]) && rf[i] > 0 && isFiniteNum(vt_l[i]) && vt_l[i] > 0) {
      rfVtSamples.push(rf[i] / vt_l[i]);
    }
  }
  const veMeanAct = meanArray(veActive);
  const pMeanAct = meanArray(pActiveForVe);
  const ve_per_100w_mean =
    veMeanAct !== null && pMeanAct !== null && pMeanAct > 0 ? veMeanAct / (pMeanAct / 100) : null;
  const rf_vt_ratio_mean = meanArray(rfVtSamples);

  // --- Fractal & Artefacts ---
  const a1Filtered = [];
  let nonNullAlpha1 = 0;
  const validArtifacts = [];
  for (let i = 0; i < N; i += 1) {
    if (isFiniteNum(artifacts[i]) && artifacts[i] >= 0) validArtifacts.push(artifacts[i]);
    if (isFiniteNum(dfa_a1[i]) && dfa_a1[i] > 0) {
      nonNullAlpha1 += 1;
      if (artifacts[i] === null || artifacts[i] < 5.0) {
        a1Filtered.push(dfa_a1[i]);
      }
    }
  }
  const alpha1_filtered_mean = meanArray(a1Filtered);
  const artifacts_mean_pct = meanArray(validArtifacts);
  const alpha1_valid_pct = nonNullAlpha1 > 0 ? (a1Filtered.length / nonNullAlpha1) * 100 : null;
  const alpha1_coverage_pct = N > 0 ? (a1Filtered.length / N) * 100 : null;

  // --- Thermorégulation CORE ---
  const validTc = tcore.filter((v) => isFiniteNum(v) && v > 0);
  const validTs = tskin.filter((v) => isFiniteNum(v) && v > 0);
  const validHsi = hsi.filter(isFiniteNum);
  const tcore_start = validTc.length > 0 ? validTc[0] : null;
  const tcore_end = validTc.length > 0 ? validTc[validTc.length - 1] : null;
  const tcore_min = minArray(validTc);
  const tcore_mean = meanArray(validTc);
  const tcore_max = maxArray(validTc);
  const tskin_min = minArray(validTs);
  const tskin_mean = meanArray(validTs);
  const tskin_max = maxArray(validTs);
  const hsi_mean = meanArray(validHsi);
  const hsi_max = maxArray(validHsi);

  // --- Corrélations & Corrélation Partielle à P60s contrôlée ---
  const p60s = causalRollingMean(watts, time, 60, { minSamples: 1, requireGapReset: true });
  const corrPairs = {
    p60s_alpha1: { x: [], y: [] },
    hr_alpha1: { x: [], y: [] },
    tcore_alpha1: { x: [], y: [] },
    hsi_alpha1: { x: [], y: [] }
  };
  const partialTcore = { x: [], y: [], z: [] };
  const partialHsi = { x: [], y: [], z: [] };

  for (let i = 0; i < N; i += 1) {
    const clean = artifacts[i] === null || artifacts[i] < 5.0;
    if (!isFiniteNum(watts[i]) || watts[i] <= 50 || !isFiniteNum(dfa_a1[i]) || dfa_a1[i] <= 0 || !clean) {
      continue;
    }
    const a1 = dfa_a1[i];
    const p60 = p60s[i];
    if (isFiniteNum(p60)) {
      corrPairs.p60s_alpha1.x.push(p60);
      corrPairs.p60s_alpha1.y.push(a1);
    }
    if (isFiniteNum(heartrate[i]) && heartrate[i] > 0) {
      corrPairs.hr_alpha1.x.push(heartrate[i]);
      corrPairs.hr_alpha1.y.push(a1);
    }
    if (isFiniteNum(tcore[i]) && tcore[i] > 0) {
      corrPairs.tcore_alpha1.x.push(tcore[i]);
      corrPairs.tcore_alpha1.y.push(a1);
      if (isFiniteNum(p60)) {
        partialTcore.x.push(tcore[i]);
        partialTcore.y.push(a1);
        partialTcore.z.push(p60);
      }
    }
    if (isFiniteNum(hsi[i])) {
      corrPairs.hsi_alpha1.x.push(hsi[i]);
      corrPairs.hsi_alpha1.y.push(a1);
      if (isFiniteNum(p60)) {
        partialHsi.x.push(hsi[i]);
        partialHsi.y.push(a1);
        partialHsi.z.push(p60);
      }
    }
  }

  const correlations = {
    filter_criteria: "P > 50 W, alpha1 > 0, artifacts < 5%",
    pairs: {
      p60s_alpha1: computePairStats(corrPairs.p60s_alpha1.x, corrPairs.p60s_alpha1.y),
      hr_alpha1: computePairStats(corrPairs.hr_alpha1.x, corrPairs.hr_alpha1.y),
      tcore_alpha1: computePairStats(corrPairs.tcore_alpha1.x, corrPairs.tcore_alpha1.y),
      hsi_alpha1: computePairStats(corrPairs.hsi_alpha1.x, corrPairs.hsi_alpha1.y)
    },
    partial: {
      tcore_alpha1_given_p60s: computePartialCorrelation(partialTcore.x, partialTcore.y, partialTcore.z),
      hsi_alpha1_given_p60s: computePartialCorrelation(partialHsi.x, partialHsi.y, partialHsi.z)
    }
  };

  // --- Intervalles, Séries, Incidents, Seuils & Analyse Croisée ---
  const { segments, segmentation_source } = buildIntervalSegments(s, cp);
  const series = groupSeriesAndComputeDrift(s, segments);
  const incidents = detectIncidentsAndTachypnea(s, cp, p60s);
  const thresholds = computeThresholds(s);
  const cross_analysis = computeCrossAnalysis(segments);

  return {
    meta,
    parameters: { cp, wPrime },
    sample_count: N,
    segmentation_source,
    global: {
      moving_time_s,
      elapsed_time_s,
      paused_s,
      distance_km,
      elevation_gain_m,
      work_kj,
      avg_power_w,
      normalized_power_w,
      variability_index,
      intensity_factor,
      tss,
      avg_hr_bpm,
      max_hr_bpm,
      ef_np,
      ef_avg,
      aerobic_decoupling_pa_hr_pct,
      avg_cadence_rpm,
      avg_torque_nm,
      w_prime_bal_min_j,
      w_prime_bal_skiba_min_j: hasWatts ? wPrimeMinSkiba : null,
      w_prime_bal_stream_min_j: wBalStreamMin,
      w_prime_max_depletion_pct,
      w_prime_min_pct,
      ve_mean,
      ve_max,
      rf_mean,
      rf_max,
      vt_mean_l,
      ve_per_100w_mean,
      rf_vt_ratio_mean,
      alpha1_filtered_mean,
      artifacts_mean_pct,
      alpha1_valid_pct,
      alpha1_coverage_pct,
      tcore_start,
      tcore_end,
      tcore_min,
      tcore_mean,
      tcore_max,
      tskin_min,
      tskin_mean,
      tskin_max,
      hsi_mean,
      hsi_max
    },
    correlations,
    intervals: segments,
    series,
    incidents,
    thresholds,
    cross_analysis
  };
}

/* ============================================================================
 * 3. Synthèse Journalière Consolidée : buildDailySummary
 * ========================================================================== */

/**
 * Consolide l'ensemble des séances d'une journée + les métriques de récupération (wellness).
 */
export function buildDailySummary(dateStr, sessionReports = [], wellness = null) {
  const reports = Array.isArray(sessionReports) ? sessionReports.filter(Boolean) : [];

  let moving_time_s = 0;
  let elapsed_time_s = 0;
  let distance_km = 0;
  let hasDistance = false;
  let elevation_gain_m = 0;
  let hasElevation = false;
  let work_kj = 0;
  let hasWork = false;
  let tss = 0;
  let hasTss = false;

  let npNum = 0;
  let npDen = 0;
  let pAvgNum = 0;
  let pAvgDen = 0;
  let hrNum = 0;
  let hrDen = 0;

  let tcoreMaxDay = -Infinity;
  let hsiMaxDay = -Infinity;
  const alpha1_by_session = [];

  for (let idx = 0; idx < reports.length; idx += 1) {
    const rep = reports[idx];
    const g = rep.global ?? rep;
    const m = rep.meta ?? {};

    const dur = toNumOrNull(g.moving_time_s) ?? 0;
    const elap = toNumOrNull(g.elapsed_time_s) ?? dur;
    moving_time_s += dur;
    elapsed_time_s += elap;

    if (isFiniteNum(g.distance_km)) {
      distance_km += g.distance_km;
      hasDistance = true;
    }
    if (isFiniteNum(g.elevation_gain_m)) {
      elevation_gain_m += g.elevation_gain_m;
      hasElevation = true;
    }
    if (isFiniteNum(g.work_kj)) {
      work_kj += g.work_kj;
      hasWork = true;
    }
    if (isFiniteNum(g.tss)) {
      tss += g.tss;
      hasTss = true;
    }

    if (dur > 0 && isFiniteNum(g.normalized_power_w) && g.normalized_power_w > 0) {
      const p2 = g.normalized_power_w * g.normalized_power_w;
      npNum += dur * p2 * p2;
      npDen += dur;
    }
    if (dur > 0 && isFiniteNum(g.avg_power_w)) {
      pAvgNum += dur * g.avg_power_w;
      pAvgDen += dur;
    }
    if (dur > 0 && isFiniteNum(g.avg_hr_bpm) && g.avg_hr_bpm > 0) {
      hrNum += dur * g.avg_hr_bpm;
      hrDen += dur;
    }

    if (isFiniteNum(g.tcore_max) && g.tcore_max > tcoreMaxDay) tcoreMaxDay = g.tcore_max;
    if (isFiniteNum(g.hsi_max) && g.hsi_max > hsiMaxDay) hsiMaxDay = g.hsi_max;

    alpha1_by_session.push({
      session_index: idx,
      session_label: `S${idx + 1}`,
      id: m.id ?? rep.id ?? `session_${idx + 1}`,
      name: m.name ?? rep.name ?? `Séance ${idx + 1}`,
      moving_time_s: dur,
      np_w: toNumOrNull(g.normalized_power_w),
      avg_power_w: toNumOrNull(g.avg_power_w),
      avg_hr_bpm: toNumOrNull(g.avg_hr_bpm),
      ef_np: toNumOrNull(g.ef_np),
      alpha1_filtered_mean: toNumOrNull(g.alpha1_filtered_mean),
      tcore_max: toNumOrNull(g.tcore_max),
      hsi_max: toNumOrNull(g.hsi_max)
    });
  }

  const np_weighted_w = npDen > 0 ? Math.pow(npNum / npDen, 0.25) : null;
  const avg_power_weighted_w = pAvgDen > 0 ? pAvgNum / pAvgDen : null;
  const avg_hr_weighted_bpm = hrDen > 0 ? hrNum / hrDen : null;
  const tcore_max_day = Number.isFinite(tcoreMaxDay) ? tcoreMaxDay : null;
  const hsi_max_day = Number.isFinite(hsiMaxDay) ? hsiMaxDay : null;

  // Dérive inter-séances S1 -> Sn
  let inter_session_drift = null;
  if (alpha1_by_session.length >= 2) {
    const s1 = alpha1_by_session[0];
    const sn = alpha1_by_session[alpha1_by_session.length - 1];
    const deltaEfNpPct = safePctDiff(sn.ef_np, s1.ef_np);
    inter_session_drift = {
      from_session: s1.session_label,
      to_session: sn.session_label,
      delta_alpha1: safeDiff(sn.alpha1_filtered_mean, s1.alpha1_filtered_mean),
      delta_alpha1_pct: safePctDiff(sn.alpha1_filtered_mean, s1.alpha1_filtered_mean),
      delta_ef_np_pct: deltaEfNpPct,
      delta_ef_pct: deltaEfNpPct,
      delta_hr_bpm: safeDiff(sn.avg_hr_bpm, s1.avg_hr_bpm),
      delta_tcore_max_c: safeDiff(sn.tcore_max, s1.tcore_max),
      delta_hsi_max: safeDiff(sn.hsi_max, s1.hsi_max),
      transitions: alpha1_by_session.slice(1).map((curr, idx) => {
        const prev = alpha1_by_session[idx];
        const trDeltaEfNpPct = safePctDiff(curr.ef_np, prev.ef_np);
        return {
          from: prev.session_label,
          to: curr.session_label,
          delta_alpha1: safeDiff(curr.alpha1_filtered_mean, prev.alpha1_filtered_mean),
          delta_ef_np_pct: trDeltaEfNpPct,
          delta_ef_pct: trDeltaEfNpPct,
          delta_tcore_max_c: safeDiff(curr.tcore_max, prev.tcore_max)
        };
      })
    };
  }

  const normalizedWellness = wellness
    ? {
        ctl: toNumOrNull(wellness.ctl),
        atl: toNumOrNull(wellness.atl),
        tsb:
          toNumOrNull(wellness.tsb) ??
          (isFiniteNum(toNumOrNull(wellness.ctl)) && isFiniteNum(toNumOrNull(wellness.atl))
            ? Number(wellness.ctl) - Number(wellness.atl)
            : null),
        ramp_rate: toNumOrNull(wellness.rampRate ?? wellness.ramp_rate),
        resting_hr: toNumOrNull(wellness.restingHR ?? wellness.resting_hr),
        hrv_rmssd: toNumOrNull(wellness.hrv ?? wellness.hrv_rmssd),
        hrv_sdnn: toNumOrNull(wellness.hrvSDNN ?? wellness.hrv_sdnn),
        sleep_secs: toNumOrNull(wellness.sleepSecs ?? wellness.sleep_secs),
        sleep_score: toNumOrNull(wellness.sleepScore ?? wellness.sleep_score),
        readiness: toNumOrNull(wellness.readiness),
        weight_kg: toNumOrNull(wellness.weight ?? wellness.weight_kg),
        spo2: toNumOrNull(wellness.spO2 ?? wellness.spo2),
        vo2max: toNumOrNull(wellness.vo2max),
        raw: wellness
      }
    : null;

  return {
    date: dateStr,
    session_count: reports.length,
    moving_time_s,
    elapsed_time_s,
    distance_km: hasDistance ? distance_km : null,
    elevation_gain_m: hasElevation ? elevation_gain_m : null,
    work_kj: hasWork ? work_kj : null,
    tss: hasTss ? tss : null,
    np_weighted_w,
    avg_power_weighted_w,
    avg_hr_weighted_bpm,
    tcore_max_day,
    hsi_max_day,
    alpha1_by_session,
    inter_session_drift,
    wellness: normalizedWellness
  };
}
