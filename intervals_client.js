/**
 * Client direct Intervals.icu (CORS navigateur, authentification Basic, zéro backend).
 */

const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

function buildAuthHeaders(apiKey) {
  const cleanKey = String(apiKey ?? "").trim();
  if (!cleanKey) {
    throw new Error("Clé API Intervals.icu manquante.");
  }
  return {
    Authorization: "Basic " + btoa("API_KEY:" + cleanKey),
    Accept: "application/json"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(250, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(250, dateMs - Date.now());
  }
  return null;
}

function formatLocalDate(dateObj) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateObj, deltaDays) {
  const copy = new Date(dateObj.getTime());
  copy.setDate(copy.getDate() + deltaDays);
  return copy;
}

function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Défense anti-prompt injection : supprime balises HTML et caractères de contrôle.
 */
export function sanitizeText(v, maxLen = 180) {
  if (v === null || v === undefined) return "";
  const stripped = String(v)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (maxLen > 0 && stripped.length > maxLen) {
    return stripped.slice(0, maxLen).trim();
  }
  return stripped;
}

/**
 * Exécute un GET JSON avec gestion 429 (Retry-After) et 5xx via backoff exponentiel + jitter.
 */
export async function fetchJsonWithBackoff(url, headers, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers
      });

      if (response.ok) {
        return await response.json();
      }

      const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (isRetryable && attempt < maxRetries) {
        const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get("Retry-After")) : null;
        const backoffMs = 1000 * (2 ** attempt);
        const jitterMs = Math.floor(Math.random() * 400);
        await sleep((retryAfterMs ?? backoffMs) + jitterMs);
        continue;
      }

      const bodyText = sanitizeText(await response.text().catch(() => ""), 160);
      const err = new Error(`Intervals.icu HTTP ${response.status}${bodyText ? ` : ${bodyText}` : ""}`);
      err.status = response.status;
      throw err;
    } catch (error) {
      lastError = error;
      const isNetworkError = !(error && typeof error.status === "number");
      if (isNetworkError && attempt < maxRetries) {
        const backoffMs = 1000 * (2 ** attempt);
        const jitterMs = Math.floor(Math.random() * 400);
        await sleep(backoffMs + jitterMs);
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error("Échec de la requête Intervals.icu.");
}

function normalizeStreams(rawStreams) {
  if (!rawStreams) return {};
  if (Array.isArray(rawStreams)) {
    const mapped = {};
    for (const entry of rawStreams) {
      if (entry && typeof entry.type === "string" && Array.isArray(entry.data)) {
        mapped[entry.type] = entry.data;
      }
    }
    return mapped;
  }
  if (typeof rawStreams === "object") {
    return rawStreams;
  }
  return {};
}

function sanitizeActivityMeta(act) {
  const safe = { ...(act || {}) };
  if (safe.name !== undefined) safe.name = sanitizeText(safe.name, 180);
  if (safe.description !== undefined) safe.description = sanitizeText(safe.description, 400);
  if (safe.notes !== undefined) safe.notes = sanitizeText(safe.notes, 400);
  return safe;
}

function extractWellness(raw) {
  if (!raw || typeof raw !== "object") return null;

  const ctl = toFiniteOrNull(raw.ctl);
  const atl = toFiniteOrNull(raw.atl);
  const tsb = ctl !== null && atl !== null ? Number((ctl - atl).toFixed(2)) : toFiniteOrNull(raw.tsb);

  return {
    hrv: toFiniteOrNull(raw.hrv),
    hrvSDNN: toFiniteOrNull(raw.hrvSDNN),
    restingHR: toFiniteOrNull(raw.restingHR),
    sleepSecs: toFiniteOrNull(raw.sleepSecs),
    sleepScore: toFiniteOrNull(raw.sleepScore),
    readiness: toFiniteOrNull(raw.readiness),
    ctl,
    atl,
    tsb,
    rampRate: toFiniteOrNull(raw.rampRate),
    spO2: toFiniteOrNull(raw.spO2),
    vo2max: toFiniteOrNull(raw.vo2max),
    weight: toFiniteOrNull(raw.weight),
    HandgripDroit: toFiniteOrNull(raw.HandgripDroit),
    HandgripGauche: toFiniteOrNull(raw.HandgripGauche),
    PvtMedian: toFiniteOrNull(raw.PvtMedian),
    PvtLapses: toFiniteOrNull(raw.PvtLapses),
    comments: sanitizeText(raw.comments, 280),
    sportInfo: Array.isArray(raw.sportInfo) || (raw.sportInfo && typeof raw.sportInfo === "object") ? raw.sportInfo : null
  };
}

function sortActivitiesChronologically(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a?.start_date_local || a?.start_date || "") || 0;
    const tb = Date.parse(b?.start_date_local || b?.start_date || "") || 0;
    return ta - tb;
  });
}

/**
 * Récupère toutes les séances d'une journée (ou de la dernière journée active sur 30 jours),
 * avec détails, intervalles, streams complets (sans filtre `types`) et métriques wellness.
 */
export async function fetchDayBundle({ athleteId, apiKey, targetDate = "" }) {
  const headers = buildAuthHeaders(apiKey);
  const aid = encodeURIComponent(String(athleteId || "0").trim() || "0");
  const cleanTarget = String(targetDate || "").trim();

  const now = new Date();
  const today = formatLocalDate(now);
  let resolvedDate = cleanTarget || today;
  let dayActivities = [];

  if (cleanTarget) {
    const dayUrl = `${INTERVALS_BASE_URL}/athlete/${aid}/activities?oldest=${encodeURIComponent(cleanTarget)}&newest=${encodeURIComponent(cleanTarget)}`;
    const list = await fetchJsonWithBackoff(dayUrl, headers);
    if (Array.isArray(list) && list.length > 0) {
      dayActivities = sortActivitiesChronologically(list);
    }
  }

  if (dayActivities.length === 0) {
    const minus30d = formatLocalDate(addDays(now, -30));
    const rangeUrl = `${INTERVALS_BASE_URL}/athlete/${aid}/activities?oldest=${encodeURIComponent(minus30d)}&newest=${encodeURIComponent(today)}`;
    const recentList = await fetchJsonWithBackoff(rangeUrl, headers);

    if (Array.isArray(recentList) && recentList.length > 0) {
      const validWithDate = recentList.filter(
        (act) => act && typeof act.start_date_local === "string" && act.start_date_local.length >= 10
      );

      if (validWithDate.length > 0) {
        let latestDate = validWithDate[0].start_date_local.slice(0, 10);
        for (const act of validWithDate) {
          const d = act.start_date_local.slice(0, 10);
          if (d > latestDate) latestDate = d;
        }
        resolvedDate = latestDate;
        dayActivities = sortActivitiesChronologically(
          validWithDate.filter((act) => act.start_date_local.slice(0, 10) === latestDate)
        );
      }
    }
  }

  const wellnessUrl = `${INTERVALS_BASE_URL}/athlete/${aid}/wellness/${encodeURIComponent(resolvedDate)}`;
  const wellnessPromise = fetchJsonWithBackoff(wellnessUrl, headers).catch((err) => {
    if (err && err.status === 404) return null;
    throw err;
  });

  const activitiesPromise = Promise.all(
    dayActivities.map(async (act) => {
      const actId = encodeURIComponent(String(act.id));
      const detailUrl = `${INTERVALS_BASE_URL}/activity/${actId}?intervals=true`;
      // Appel sans paramètre `types` pour éviter HTTP 422 et obtenir tous les canaux disponibles
      const streamsUrl = `${INTERVALS_BASE_URL}/activity/${actId}/streams`;

      const [detail, rawStreams] = await Promise.all([
        fetchJsonWithBackoff(detailUrl, headers),
        fetchJsonWithBackoff(streamsUrl, headers)
      ]);

      const intervals = Array.isArray(detail?.icu_intervals)
        ? detail.icu_intervals
        : Array.isArray(detail?.intervals)
        ? detail.intervals
        : [];

      const mergedMeta = sanitizeActivityMeta({
        ...act,
        ...detail
      });
      delete mergedMeta.icu_intervals;

      return {
        meta: mergedMeta,
        intervals,
        streams: normalizeStreams(rawStreams)
      };
    })
  );

  const [rawWellness, activities] = await Promise.all([wellnessPromise, activitiesPromise]);

  return {
    date: resolvedDate,
    wellness: extractWellness(rawWellness),
    activities
  };
}
