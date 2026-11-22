/**
 * Coffre-fort local unifie (GitHub Pages / meme origine).
 * Synchronise GLOBAL_ATHLETE_VAULT_V1 et les 4 cles plates localStorage.
 */

export const VAULT_KEY = "GLOBAL_ATHLETE_VAULT_V1";

export const FLAT_KEYS = Object.freeze([
  "INTERVALS_ATHLETE_ID",
  "INTERVALS_API_KEY",
  "GEMINI_API_KEY",
  "LLM_MODEL"
]);

export const DEFAULT_VAULT = Object.freeze({
  INTERVALS_ATHLETE_ID: "0",
  INTERVALS_API_KEY: "",
  GEMINI_API_KEY: "",
  LLM_MODEL: "gemini-4-hydrogen",
  CP_WATTS: 400,
  W_PRIME_J: 25000,
  updatedAt: null
});

const DEPRECATED_MODELS = new Set(["gemini-2.5-flash", "gemini-1.5-flash", "gemini-1.5-pro"]);

function safeGetItem(key) {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(key, value);
    }
  } catch {
    /* Quota / navigation privee */
  }
}

function parsePositiveNumber(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function cleanString(val, fallback = "") {
  if (val === null || val === undefined) return fallback;
  return String(val).replace(/[\r\n\t]+/g, "").trim();
}

function isNonEmpty(val) {
  return typeof val === "string" && val.trim().length > 0;
}

function normalizeModelId(val) {
  const cleaned = cleanString(val, DEFAULT_VAULT.LLM_MODEL).replace(/^models\//, "");
  if (!cleaned || DEPRECATED_MODELS.has(cleaned)) {
    return DEFAULT_VAULT.LLM_MODEL;
  }
  return cleaned;
}

function normalizeVaultObject(raw = {}) {
  const athleteId = cleanString(raw.INTERVALS_ATHLETE_ID, DEFAULT_VAULT.INTERVALS_ATHLETE_ID);
  return {
    INTERVALS_ATHLETE_ID: athleteId || DEFAULT_VAULT.INTERVALS_ATHLETE_ID,
    INTERVALS_API_KEY: cleanString(raw.INTERVALS_API_KEY, DEFAULT_VAULT.INTERVALS_API_KEY),
    GEMINI_API_KEY: cleanString(raw.GEMINI_API_KEY, DEFAULT_VAULT.GEMINI_API_KEY),
    LLM_MODEL: normalizeModelId(raw.LLM_MODEL),
    CP_WATTS: parsePositiveNumber(raw.CP_WATTS, DEFAULT_VAULT.CP_WATTS),
    W_PRIME_J: parsePositiveNumber(raw.W_PRIME_J, DEFAULT_VAULT.W_PRIME_J),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

function writeAllStorageKeys(vault) {
  safeSetItem(VAULT_KEY, JSON.stringify(vault));
  for (const key of FLAT_KEYS) {
    safeSetItem(key, String(vault[key] ?? ""));
  }
}

export function loadVault() {
  let unifiedRaw = null;
  let unifiedValid = false;

  const rawJson = safeGetItem(VAULT_KEY);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        unifiedRaw = parsed;
        unifiedValid = true;
      }
    } catch {
      unifiedRaw = null;
    }
  }

  const unified = normalizeVaultObject(unifiedRaw || {});
  const flatValues = {};
  for (const key of FLAT_KEYS) {
    flatValues[key] = cleanString(safeGetItem(key), "");
  }

  const unifiedIsEmptyOrOlder = !unifiedValid || !unified.updatedAt;
  const merged = { ...unified };

  for (const key of FLAT_KEYS) {
    const flatVal = flatValues[key];
    if (!isNonEmpty(flatVal)) continue;

    const unifiedVal = cleanString(merged[key], "");
    const isDefaultAthleteId = key === "INTERVALS_ATHLETE_ID" && unifiedVal === "0";
    const isDefaultModel = key === "LLM_MODEL" && unifiedVal === DEFAULT_VAULT.LLM_MODEL;

    if (!isNonEmpty(unifiedVal) || isDefaultAthleteId || (unifiedIsEmptyOrOlder && (!isNonEmpty(unifiedVal) || isDefaultModel))) {
      merged[key] = flatVal;
    }
  }

  const finalVault = normalizeVaultObject(merged);
  if (!finalVault.updatedAt) {
    finalVault.updatedAt = new Date().toISOString();
  }

  writeAllStorageKeys(finalVault);
  return finalVault;
}

export function saveVault(values = {}) {
  const current = loadVault();
  const next = normalizeVaultObject({
    ...current,
    ...(values && typeof values === "object" ? values : {}),
    updatedAt: new Date().toISOString()
  });

  writeAllStorageKeys(next);
  return next;
}

export function exportVaultJson() {
  return JSON.stringify(loadVault(), null, 2);
}

export function downloadVaultJson() {
  const json = exportVaultJson();
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "global-athlete-vault.json";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function importVaultJson(jsonText) {
  if (typeof jsonText !== "string" || !jsonText.trim()) {
    throw new Error("Contenu JSON du coffre vide.");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("JSON invalide lors de l'import du coffre.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Le fichier importe doit contenir un objet JSON.");
  }

  const source =
    parsed[VAULT_KEY] && typeof parsed[VAULT_KEY] === "object" && !Array.isArray(parsed[VAULT_KEY])
      ? parsed[VAULT_KEY]
      : parsed;

  const allowedKeys = [...FLAT_KEYS, "CP_WATTS", "W_PRIME_J"];
  const hasKnownKey = allowedKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (!hasKnownKey) {
    throw new Error("Aucune cle reconnue du coffre athlete dans le JSON importe.");
  }

  const patch = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      patch[key] = source[key];
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "CP_WATTS")) {
    const cp = Number(patch.CP_WATTS);
    if (!Number.isFinite(cp) || cp <= 0) {
      throw new Error("CP_WATTS invalide (nombre strictement positif requis).");
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "W_PRIME_J")) {
    const wPrime = Number(patch.W_PRIME_J);
    if (!Number.isFinite(wPrime) || wPrime <= 0) {
      throw new Error("W_PRIME_J invalide (nombre strictement positif requis).");
    }
  }

  return saveVault(patch);
}