/**
 * PhysioPulse Telemetry â€” Controleur UI PWA Mobile-First (ES Module)
 * Orchestre vault.js, intervals_client.js, physio_engine.js et gemini_client.js.
 */

import {
  loadVault,
  saveVault,
  downloadVaultJson,
  importVaultJson
} from "./vault.js";
import { fetchDayBundle } from "./intervals_client.js";
import {
  formatSecondsHms,
  parseCsvTextToActivity,
  analyzeActivity,
  buildDailySummary
} from "./physio_engine.js";
import {
  buildInitialContextPayload,
  fetchAvailableGeminiModels,
  pickBestAvailableModel,
  generateInitialSynthesis,
  sendChatMessage
} from "./gemini_client.js";

const REPORT_CACHE_KEY = "physiopulse_last_report_v4";
const MODELS_CACHE_KEY = "PHYSIOPULSE_CACHED_MODELS_V3";
const AUTO_ANALYZE_KEY = "PHYSIOPULSE_AUTO_ANALYZE_STARTUP";
const COLOR_SCHEME_KEY = "color-scheme";

const state = {
  vault: loadVault(),
  bundle: null,
  activeTab: "summary",
  conversationHistory: [],
  busy: false
};

const $ = (id) => document.getElementById(id);

function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, val) {
  try {
    window.localStorage.setItem(key, val);
  } catch {
    /* Quota / navigation privee */
  }
}

function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Ignore */
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(val, suffix = "", digits = null) {
  if (val === null || val === undefined || val === "" || Number.isNaN(val)) return "â€”";
  if (typeof val === "number") {
    const out = digits !== null ? val.toFixed(digits) : Number.isInteger(val) ? String(val) : val.toFixed(2);
    return suffix ? `${out} ${suffix}`.trim() : out;
  }
  return suffix ? `${val} ${suffix}`.trim() : String(val);
}

function fmtSigned(val, suffix = "", digits = 2) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "â€”";
  const num = Number(val);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(digits)}${suffix ? ` ${suffix}` : ""}`;
}

function applyInlineMarkdown(escapedLine) {
  return escapedLine
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function renderSafeMarkdown(rawText) {
  const escaped = escapeHtml(rawText || "");
  const lines = escaped.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;

  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeLists();
      closeTable();
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      closeLists();
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!inTable) {
        out.push("<table><thead><tr>");
        for (const c of cells) out.push(`<th>${applyInlineMarkdown(c)}</th>`);
        out.push("</tr></thead><tbody>");
        inTable = true;
      } else {
        out.push("<tr>");
        for (const c of cells) out.push(`<td>${applyInlineMarkdown(c)}</td>`);
        out.push("</tr>");
      }
      continue;
    }
    closeTable();

    const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      closeLists();
      out.push(`<p><strong>${applyInlineMarkdown(headingMatch[1])}</strong></p>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*â€¢]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${applyInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${applyInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    out.push(`<p>${applyInlineMarkdown(trimmed)}</p>`);
  }

  closeLists();
  closeTable();
  return `<div class="md-render">${out.join("")}</div>`;
}

/* ==========================================================================
   1. Theme, Reseau & Service Worker
   ========================================================================== */
function initThemeToggle() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const toggleBtn = $("theme-toggle");
  if (!meta || !toggleBtn) return;

  const getSystemTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  const applyMetaFromStorage = () => {
    const stored = safeGet(COLOR_SCHEME_KEY);
    meta.content = stored === "light" || stored === "dark" ? stored : "light dark";
  };

  toggleBtn.addEventListener("click", () => {
    const stored = safeGet(COLOR_SCHEME_KEY);
    const system = getSystemTheme();
    const rendered = stored === "light" || stored === "dark" ? stored : system;
    const target = rendered === "dark" ? "light" : "dark";
    if (target !== system) safeSet(COLOR_SCHEME_KEY, target);
    else safeRemove(COLOR_SCHEME_KEY);
    applyMetaFromStorage();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === COLOR_SCHEME_KEY) applyMetaFromStorage();
  });
}

function initNetworkAndSw() {
  const pill = $("network-status");
  const text = $("network-status-text");

  const updateOnline = () => {
    const online = navigator.onLine;
    if (pill) pill.classList.toggle("is-offline", !online);
    if (text) text.textContent = online ? "En ligne" : "Hors-ligne";
  };

  updateOnline();
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

/* ==========================================================================
   2. Coffre-Fort & Auto-Sync Dynamique des Modeles Gemini
   ========================================================================== */
function renderModelOptions(selectEl, modelsList, selectedId) {
  if (!selectEl || !Array.isArray(modelsList) || modelsList.length === 0) return;
  selectEl.innerHTML = "";
  for (const m of modelsList) {
    const id = String(typeof m === "string" ? m : m?.id || "").replace(/^models\//, "");
    if (!id) continue;
    const label = typeof m === "string" ? id : m.displayName && m.displayName !== id ? `${id} â€” ${m.displayName}` : id;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }
  if (selectedId && Array.from(selectEl.options).some((o) => o.value === selectedId)) {
    selectEl.value = selectedId;
  }
}

function syncVaultFormInputs() {
  const v = state.vault;
  if ($("vault-intervals-id")) $("vault-intervals-id").value = v.INTERVALS_ATHLETE_ID || "";
  if ($("vault-intervals-key")) $("vault-intervals-key").value = v.INTERVALS_API_KEY || "";
  if ($("vault-gemini-key")) $("vault-gemini-key").value = v.GEMINI_API_KEY || "";

  const modelSel = $("vault-llm-model");
  if (modelSel) {
    const modelVal = v.LLM_MODEL || "gemini-4-hydrogen";
    if (!Array.from(modelSel.options).some((opt) => opt.value === modelVal)) {
      const opt = document.createElement("option");
      opt.value = modelVal;
      opt.textContent = modelVal;
      modelSel.prepend(opt);
    }
    modelSel.value = modelVal;
  }

  if ($("vault-cp")) $("vault-cp").value = String(v.CP_WATTS ?? 400);
  if ($("vault-w-prime")) $("vault-w-prime").value = String(v.W_PRIME_J ?? 25000);
}

function updateVaultIndicators() {
  const v = state.vault;
  const intervalsOk = Boolean(v.INTERVALS_ATHLETE_ID && v.INTERVALS_API_KEY);
  const geminiOk = Boolean(v.GEMINI_API_KEY);

  const badgeInt = $("vault-badge-intervals");
  const textInt = $("vault-badge-intervals-text");
  if (badgeInt && textInt) {
    badgeInt.classList.toggle("is-ok", intervalsOk);
    badgeInt.classList.toggle("is-missing", !intervalsOk);
    textInt.textContent = intervalsOk ? "Intervals OK" : "Intervals";
  }

  const badgeGem = $("vault-badge-gemini");
  const textGem = $("vault-badge-gemini-text");
  if (badgeGem && textGem) {
    badgeGem.classList.toggle("is-ok", geminiOk);
    badgeGem.classList.toggle("is-missing", !geminiOk);
    textGem.textContent = geminiOk ? "Gemini OK" : "Gemini";
  }
}

function setVaultDrawerOpen(open, alertMsg = "", isError = false) {
  const drawer = $("vault-drawer");
  const btn = $("btn-vault-toggle");
  const alertBox = $("vault-alert");
  if (!drawer) return;

  drawer.hidden = !open;
  if (btn) btn.setAttribute("aria-expanded", String(open));

  if (alertBox) {
    if (alertMsg) {
      alertBox.hidden = false;
      alertBox.textContent = alertMsg;
      alertBox.classList.toggle("is-error", isError);
      alertBox.classList.toggle("is-ok", !isError);
    } else {
      alertBox.hidden = true;
    }
  }

  if (open) drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function resolveAndSyncModelsAtStartup() {
  const selectEl = $("vault-llm-model");
  state.vault = loadVault();
  const apiKey = (state.vault.GEMINI_API_KEY || "").trim();

  let cachedModels = [];
  try {
    cachedModels = JSON.parse(safeGet(MODELS_CACHE_KEY) || "[]");
  } catch {
    cachedModels = [];
  }

  let chosenModel = pickBestAvailableModel(cachedModels, state.vault.LLM_MODEL);
  if (cachedModels.length > 0 && selectEl) {
    renderModelOptions(selectEl, cachedModels, chosenModel);
  }

  if (apiKey && navigator.onLine) {
    try {
      const liveModels = await fetchAvailableGeminiModels(apiKey);
      if (liveModels.length > 0) {
        safeSet(MODELS_CACHE_KEY, JSON.stringify(liveModels));
        chosenModel = pickBestAvailableModel(liveModels, state.vault.LLM_MODEL);
        if (selectEl) renderModelOptions(selectEl, liveModels, chosenModel);
      }
    } catch {
      /* Conserve le modele en cache si hors-ligne ou erreur transitoire */
    }
  }

  if (chosenModel && chosenModel !== state.vault.LLM_MODEL) {
    state.vault = saveVault({ LLM_MODEL: chosenModel });
  }
  syncVaultFormInputs();
  return state.vault.LLM_MODEL;
}

function initVaultUI() {
  state.vault = loadVault();
  syncVaultFormInputs();
  updateVaultIndicators();

  $("btn-vault-toggle")?.addEventListener("click", () => {
    setVaultDrawerOpen(Boolean($("vault-drawer")?.hidden));
  });
  $("btn-vault-close")?.addEventListener("click", () => setVaultDrawerOpen(false));
  $("vault-badge-intervals")?.addEventListener("click", () => setVaultDrawerOpen(true));
  $("vault-badge-gemini")?.addEventListener("click", () => setVaultDrawerOpen(true));

  document.addEventListener("click", (event) => {
    const btn = event.target.closest(".toggle-secret-btn");
    if (!btn) return;
    const input = $(btn.getAttribute("data-target"));
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    btn.textContent = show ? "Masquer" : "Afficher";
  });

  $("vault-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.vault = saveVault({
      INTERVALS_ATHLETE_ID: $("vault-intervals-id")?.value,
      INTERVALS_API_KEY: $("vault-intervals-key")?.value,
      GEMINI_API_KEY: $("vault-gemini-key")?.value,
      LLM_MODEL: $("vault-llm-model")?.value,
      CP_WATTS: Number($("vault-cp")?.value) || 400,
      W_PRIME_J: Number($("vault-w-prime")?.value) || 25000
    });
    syncVaultFormInputs();
    updateVaultIndicators();
    setVaultDrawerOpen(true, `Coffre enregistre (modele actif : ${state.vault.LLM_MODEL}).`, false);
  });

  $("btn-vault-export")?.addEventListener("click", () => {
    state.vault = saveVault({
      INTERVALS_ATHLETE_ID: $("vault-intervals-id")?.value,
      INTERVALS_API_KEY: $("vault-intervals-key")?.value,
      GEMINI_API_KEY: $("vault-gemini-key")?.value,
      LLM_MODEL: $("vault-llm-model")?.value,
      CP_WATTS: Number($("vault-cp")?.value) || 400,
      W_PRIME_J: Number($("vault-w-prime")?.value) || 25000
    });
    downloadVaultJson();
  });

  const importInput = $("vault-import-file");
  $("btn-vault-import")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      state.vault = importVaultJson(await file.text());
      syncVaultFormInputs();
      updateVaultIndicators();
      setVaultDrawerOpen(true, `Coffre JSON importe (${file.name}).`, false);
    } catch (err) {
      setVaultDrawerOpen(true, `Import JSON invalide : ${err.message}`, true);
    } finally {
      importInput.value = "";
    }
  });

  const csvInput = $("local-csv-file");
  const csvBtn = $("btn-analyze-csv");
  csvInput?.addEventListener("change", () => {
    if (csvBtn) csvBtn.disabled = !csvInput.files?.length;
  });
  csvBtn?.addEventListener("click", () => {
    const file = csvInput?.files?.[0];
    if (file) runLocalCsvPipeline(file);
  });

  $("refresh-models-btn")?.addEventListener("click", async () => {
    const key = ($("vault-gemini-key")?.value || state.vault.GEMINI_API_KEY || "").trim();
    const btn = $("refresh-models-btn");
    const modelSel = $("vault-llm-model");
    if (!key || !modelSel) {
      setVaultDrawerOpen(true, "Renseignez GEMINI_API_KEY pour actualiser les modeles.", true);
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const models = await fetchAvailableGeminiModels(key);
      if (models.length === 0) {
        setVaultDrawerOpen(true, "Aucun modele compatible generateContent trouve.", true);
        return;
      }
      safeSet(MODELS_CACHE_KEY, JSON.stringify(models));
      const chosen = pickBestAvailableModel(models, modelSel.value || state.vault.LLM_MODEL);
      renderModelOptions(modelSel, models, chosen);
      state.vault = saveVault({ LLM_MODEL: chosen });
      setVaultDrawerOpen(true, `${models.length} modeles charges (selection : ${chosen}).`, false);
    } catch (err) {
      setVaultDrawerOpen(true, `Erreur modeles Gemini : ${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  const autoChk = $("auto-analyze-startup");
  if (autoChk) {
    autoChk.checked = safeGet(AUTO_ANALYZE_KEY) === "1";
    autoChk.addEventListener("change", () => {
      safeSet(AUTO_ANALYZE_KEY, autoChk.checked ? "1" : "0");
    });
  }
}

/* ==========================================================================
   3. Accordeons & Tableaux Responsives
   ========================================================================== */
function initAccordion() {
  const accordion = $("tech-accordion");
  const toggleAllBtn = $("toggle-all-btn");
  if (!accordion || !toggleAllBtn) return;

  const syncState = () => {
    const items = accordion.querySelectorAll(":scope > details");
    const allOpen = items.length > 0 && Array.from(items).every((d) => d.open);
    toggleAllBtn.setAttribute("aria-expanded", String(allOpen));
  };

  toggleAllBtn.addEventListener("click", () => {
    const expand = toggleAllBtn.getAttribute("aria-expanded") !== "true";
    for (const d of accordion.querySelectorAll(":scope > details")) {
      d.open = expand;
    }
    syncState();
  });

  accordion.addEventListener("toggle", syncState, true);
  syncState();
}

function initTableControls() {
  document.addEventListener("click", (event) => {
    const btn = event.target.closest(".toggle-wide-btn");
    if (!btn) return;
    const wrapper = $(btn.getAttribute("data-target"));
    if (!wrapper) return;
    const isWide = wrapper.classList.toggle("force-wide");
    btn.setAttribute("aria-pressed", String(isWide));
    btn.textContent = isWide ? "Vue cartes mobile" : "Vue tableau large";
  });
}

/* ==========================================================================
   4. Pipelines 1-Click & CSV
   ========================================================================== */
function setPipelineStep(stepNumber, stepState) {
  const progress = $("pipeline-progress");
  if (progress) progress.hidden = false;
  $(`step-${stepNumber}`)?.setAttribute("data-state", stepState);
}

function resetPipeline(visible) {
  const progress = $("pipeline-progress");
  if (progress) progress.hidden = !visible;
  for (const idx of [1, 2, 3]) {
    $(`step-${idx}`)?.setAttribute("data-state", "pending");
  }
}

function showStatusAlert(message, isError = false) {
  const box = $("status-alert");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
  box.classList.toggle("is-error", isError);
}

function buildFallbackSeedHistory(dailyBundle) {
  const payload = buildInitialContextPayload(dailyBundle);
  return [
    {
      role: "user",
      parts: [{ text: `Donnees essentielles de la journee :\n${JSON.stringify(payload)}` }]
    },
    {
      role: "model",
      parts: [{ text: "Contexte physiologique charge. Pret pour vos questions." }]
    }
  ];
}

async function finalizeBundleAndGemini(rawDay, vault) {
  setPipelineStep(2, "active");
  const sessionReports = (rawDay.activities || []).map((act) =>
    analyzeActivity(act, { cp: vault.CP_WATTS, wPrime: vault.W_PRIME_J })
  );
  if (sessionReports.length === 0) {
    throw new Error("Aucune seance exploitable trouvee pour cette journee.");
  }
  const daySummary = buildDailySummary(rawDay.date, sessionReports, rawDay.wellness);
  const dailyBundle = {
    date: rawDay.date,
    wellness: daySummary.wellness,
    day_summary: daySummary,
    sessions: sessionReports
  };
  setPipelineStep(2, "done");

  setPipelineStep(3, "active");
  let synthesis = null;
  let geminiError = "";
  let usedModel = vault.LLM_MODEL || "gemini-4-hydrogen";

  if (vault.GEMINI_API_KEY) {
    try {
      const gemRes = await generateInitialSynthesis({
        dailyBundle,
        geminiApiKey: vault.GEMINI_API_KEY,
        model: usedModel
      });
      synthesis = gemRes.synthesis;
      usedModel = gemRes.usedModel || usedModel;
      if (usedModel !== state.vault.LLM_MODEL) {
        state.vault = saveVault({ LLM_MODEL: usedModel });
        syncVaultFormInputs();
      }
      state.conversationHistory = gemRes.conversationHistory;
      setPipelineStep(3, "done");
    } catch (err) {
      geminiError = err.message || "Erreur Gemini inconnue.";
      state.conversationHistory = buildFallbackSeedHistory(dailyBundle);
      setPipelineStep(3, "error");
    }
  } else {
    geminiError = "GEMINI_API_KEY absente : synthese locale affichee.";
    state.conversationHistory = buildFallbackSeedHistory(dailyBundle);
    setPipelineStep(3, "error");
  }

  state.bundle = {
    ...dailyBundle,
    gemini_synthesis: synthesis,
    gemini_error: geminiError,
    gemini_model_used: usedModel
  };
  state.activeTab = sessionReports.length > 1 ? "summary" : "session-0";
  safeSet(REPORT_CACHE_KEY, JSON.stringify(state.bundle));
  renderAll();
}

async function runFullPipeline() {
  if (state.busy) return;
  state.vault = loadVault();
  const v = state.vault;

  const missing = [];
  if (!v.INTERVALS_ATHLETE_ID) missing.push("INTERVALS_ATHLETE_ID");
  if (!v.INTERVALS_API_KEY) missing.push("INTERVALS_API_KEY");
  if (!v.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  if (missing.length > 0) {
    setVaultDrawerOpen(true, `Cles requises : ${missing.join(", ")}.`, true);
    return;
  }

  state.busy = true;
  $("btn-analyze-1click").disabled = true;
  showStatusAlert("");
  resetPipeline(true);

  try {
    setPipelineStep(1, "active");
    const targetDate = $("input-target-date")?.value?.trim() || "";
    const rawDay = await fetchDayBundle({
      athleteId: v.INTERVALS_ATHLETE_ID,
      apiKey: v.INTERVALS_API_KEY,
      targetDate
    });
    if (!rawDay.activities || rawDay.activities.length === 0) {
      throw new Error(
        targetDate
          ? `Aucune activite sur Intervals.icu pour le ${targetDate}.`
          : "Aucune activite trouvee sur les 30 derniers jours."
      );
    }
    setPipelineStep(1, "done");
    await finalizeBundleAndGemini(rawDay, v);
  } catch (err) {
    setPipelineStep(1, "error");
    showStatusAlert(err.message || "Echec du pipeline 1-Click.", true);
  } finally {
    state.busy = false;
    $("btn-analyze-1click").disabled = false;
  }
}

async function runLocalCsvPipeline(file) {
  if (state.busy) return;
  state.vault = loadVault();
  state.busy = true;
  showStatusAlert("");
  resetPipeline(true);
  setPipelineStep(1, "done");

  try {
    const csvText = await file.text();
    const rawAct = parseCsvTextToActivity(csvText, file.name);
    const today = new Date().toISOString().slice(0, 10);
    await finalizeBundleAndGemini({ date: today, wellness: null, activities: [rawAct] }, state.vault);
    setVaultDrawerOpen(false);
  } catch (err) {
    setPipelineStep(2, "error");
    setVaultDrawerOpen(true, `Erreur import CSV : ${err.message}`, true);
  } finally {
    state.busy = false;
  }
}

/* ==========================================================================
   5. Rendu Bilan, Wellness, 6 KPIs & Accordeons Essentiels
   ========================================================================== */
function getActiveSessionIndex(bundle) {
  const sessions = bundle?.sessions || [];
  if (sessions.length === 0) return 0;
  if (state.activeTab.startsWith("session-")) {
    const idx = Number(state.activeTab.replace("session-", ""));
    if (Number.isInteger(idx) && idx >= 0 && idx < sessions.length) return idx;
  }
  return 0;
}

function renderTabs(bundle) {
  const bar = $("session-tabs-bar");
  const list = $("session-tabs-list");
  if (!bar || !list) return;

  const sessions = bundle?.sessions || [];
  if (sessions.length <= 1) {
    bar.hidden = true;
    list.innerHTML = "";
    return;
  }

  bar.hidden = false;
  const tabs = [
    { id: "summary", label: `Journee (${sessions.length})` },
    ...sessions.map((s, idx) => ({
      id: `session-${idx}`,
      label: `S${idx + 1} Â· ${s.meta?.name || `Activite ${idx + 1}`}`
    }))
  ];

  list.innerHTML = tabs
    .map(
      (t) =>
        `<button type="button" class="tab-btn" role="tab" aria-selected="${state.activeTab === t.id}" data-tab-id="${escapeHtml(t.id)}">${escapeHtml(t.label)}</button>`
    )
    .join("");

  list.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.getAttribute("data-tab-id") || "summary";
      renderAll();
    });
  });
}

function renderConsolidatedCard(bundle) {
  const card = $("day-consolidated-card");
  if (!card) return;
  const ds = bundle?.day_summary;
  const sessions = bundle?.sessions || [];
  if (!ds || sessions.length < 2) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $("day-sessions-count").textContent = `${sessions.length} seances`;

  const stats = [
    ["Duree", formatSecondsHms(ds.moving_time_s)],
    ["Distance", fmt(ds.distance_km, "km", 1)],
    ["D+", fmt(ds.elevation_gain_m, "m", 0)],
    ["TSS", fmt(ds.tss, "", 0)],
    ["NP pond.", fmt(ds.np_weighted_w, "W", 0)],
    ["Tcore max", fmt(ds.tcore_max_day, "Â°C", 2)]
  ];

  $("day-consolidated-metrics").innerHTML = stats
    .map(([l, v]) => `<div class="mini-stat"><span class="mini-stat-label">${escapeHtml(l)}</span><span class="mini-stat-val">${escapeHtml(v)}</span></div>`)
    .join("");

  const evo = $("day-consolidated-evolution");
  if (ds.inter_session_drift) {
    const d = ds.inter_session_drift;
    evo.hidden = false;
    evo.textContent = `${d.from_session} -> ${d.to_session} : Î”Î±â‚ ${fmtSigned(d.delta_alpha1, "", 2)} | Î”EF ${fmtSigned(d.delta_ef_pct ?? d.delta_ef_np_pct, "%", 1)} | Î”Tcore ${fmtSigned(d.delta_tcore_max_c, "Â°C", 2)}`;
  } else {
    evo.hidden = true;
  }
}

function buildLocalMetricsFallback(session) {
  const g = session?.global || {};
  const strengths = [];
  const breaking = [];

  if (g.normalized_power_w) strengths.push(`NP ${fmt(g.normalized_power_w, "W", 0)} (IF ${fmt(g.intensity_factor, "", 2)}), ${fmt(g.work_kj, "kJ", 0)}.`);
  if (g.aerobic_decoupling_pa_hr_pct != null) {
    if (g.aerobic_decoupling_pa_hr_pct <= 5) strengths.push(`Decouplage Pa:Hr maitrise (${g.aerobic_decoupling_pa_hr_pct.toFixed(1)} %).`);
    else breaking.push(`Derive cardiovasculaire Pa:Hr marquee (${g.aerobic_decoupling_pa_hr_pct.toFixed(1)} %).`);
  }
  if ((g.tcore_max ?? 0) >= 38.1) breaking.push(`Contrainte thermique : Tcore max ${fmt(g.tcore_max, "Â°C", 2)} (HSI max ${fmt(g.hsi_max, "", 1)}).`);
  if (strengths.length === 0) strengths.push("Donnees 1 Hz calculees localement sans anomalie critique.");
  if (breaking.length === 0) breaking.push("Aucune rupture majeure detectee sur les seuils locaux.");

  return {
    verdict: `Synthese locale â€” ${session?.meta?.name || "Seance"}`,
    daily_synthesis: `NP ${fmt(g.normalized_power_w, "W", 0)} â€¢ FC moy ${fmt(g.avg_hr_bpm, "bpm", 0)} â€¢ Pa:Hr ${fmtSigned(g.aerobic_decoupling_pa_hr_pct, "%", 1)} â€¢ Ve ${fmt(g.ve_mean, "L/min", 1)} â€¢ Tcore max ${fmt(g.tcore_max, "Â°C", 2)}.`,
    strengths,
    breaking_points: breaking,
    priority_axes: [
      { title: "Charge & Recuperation", metric_basis: `TSS ${fmt(g.tss, "", 0)} / Pa:Hr ${fmtSigned(g.aerobic_decoupling_pa_hr_pct, "%", 1)}`, action: "Ajuster le volume/intensite de demain selon HRV/Handgrip/PVT du matin." },
      { title: "Thermoregulation", metric_basis: `Tcore max ${fmt(g.tcore_max, "Â°C", 2)}`, action: "Refroidissement actif et sodium 700-900 mg/L si chaleur." }
    ],
    technical_notes: `Artefacts ECG : ${fmt(g.artifacts_mean_pct, "%", 1)} (validite DFA Î±â‚ : ${fmt(g.alpha1_valid_pct, "%", 1)}).`
  };
}

function renderVerdict(session, bundle) {
  const banner = $("executive-verdict");
  const errorBox = $("gemini-error-box");
  const gem = bundle?.gemini_synthesis;
  const v = gem || buildLocalMetricsFallback(session);

  if (bundle?.gemini_error) {
    errorBox.hidden = false;
    errorBox.textContent = `Gemini indisponible (${bundle.gemini_error}) â€” Resume mathematique local affiche.`;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  const g = session?.global || {};
  const tone = (g.tcore_max ?? 0) > 38.5 || (g.aerobic_decoupling_pa_hr_pct ?? 0) > 8 ? "warn" : "ok";
  banner.className = `verdict-banner is-${tone}`;

  const badge = $("verdict-badge");
  badge.className = `badge badge-${gem ? "info" : tone}`;
  badge.textContent = gem ? `GEMINI (${bundle.gemini_model_used || state.vault.LLM_MODEL})` : "RESUME LOCAL";

  $("verdict-title").textContent = v.verdict || session?.meta?.name || "Verdict";
  $("verdict-summary").textContent = v.daily_synthesis || "â€”";

  const strengths = Array.isArray(v.strengths) ? v.strengths : [];
  const breaks = Array.isArray(v.breaking_points) ? v.breaking_points : [];
  $("strengths-list").innerHTML = strengths.length
    ? strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>Aucun point fort specifique.</li>";
  $("breaking-points-list").innerHTML = breaks.length
    ? breaks.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>Aucun point de rupture detecte.</li>";

  const axes = Array.isArray(v.priority_axes) ? v.priority_axes.slice(0, 4) : [];
  $("priorities-list").innerHTML = axes.length
    ? axes
        .map((ax) => {
          const title = ax?.title || "Axe";
          const action = ax?.action || "";
          const basis = ax?.metric_basis ? `<span class="priority-target">Base : ${escapeHtml(ax.metric_basis)}</span>` : "";
          return `<li><strong>${escapeHtml(title)}</strong>${action ? ` â€” ${escapeHtml(action)}` : ""}${basis}</li>`;
        })
        .join("")
    : "<li>Aucun axe prioritaire.</li>";

  const notesEl = $("verdict-tech-notes");
  if (v.technical_notes) {
    notesEl.hidden = false;
    notesEl.innerHTML = `<strong>Notes techniques :</strong> ${escapeHtml(v.technical_notes)}`;
  } else {
    notesEl.hidden = true;
  }
}

function renderWellness(bundle) {
  const card = $("wellness-banner");
  const grid = $("wellness-grid");
  const w = bundle?.wellness;
  if (!card || !grid || !w) {
    if (card) card.hidden = true;
    return;
  }

  const raw = w.raw || {};
  const handgrip =
    raw.HandgripDroit != null || raw.HandgripGauche != null
      ? `${fmt(raw.HandgripDroit, "", 1)} / ${fmt(raw.HandgripGauche, "kg", 1)}`
      : null;
  const pvt = raw.PvtMedian != null ? `${fmt(raw.PvtMedian, "ms", 0)} (${fmt(raw.PvtLapses, "l", 0)})` : null;

  const items = [
    ["HRV RMSSD", fmt(w.hrv_rmssd, "ms", 0)],
    ["FC repos", fmt(w.resting_hr, "bpm", 0)],
    ["CTL/ATL/TSB", `${fmt(w.ctl, "", 0)} / ${fmt(w.atl, "", 0)} / ${fmt(w.tsb, "", 0)}`],
    ["Sommeil", w.sleep_secs ? formatSecondsHms(w.sleep_secs) : fmt(w.sleep_score, "/100", 0)],
    ["Readiness", fmt(w.readiness, "/100", 0)],
    ["Handgrip D/G", handgrip],
    ["PVT", pvt]
  ].filter(([, val]) => val && val !== "â€”" && val !== "â€” / â€” / â€”");

  if (items.length === 0) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $("wellness-date-badge").textContent = bundle.date || "";
  grid.innerHTML = items
    .map(([l, val]) => `<div class="mini-stat"><span class="mini-stat-label">${escapeHtml(l)}</span><span class="mini-stat-val">${escapeHtml(val)}</span></div>`)
    .join("");
}

function renderKpiGrid(session) {
  const grid = $("kpi-grid");
  if (!grid || !session) return;
  const g = session.global || {};

  const cards = [
    {
      label: "Volume & Charge",
      badge: session.meta?.type || "Ride",
      tone: "info",
      main: `${formatSecondsHms(g.moving_time_s)} Â· ${fmt(g.distance_km, "km", 1)}`,
      sub: `D+ ${fmt(g.elevation_gain_m, "m", 0)} â€¢ TSS ${fmt(g.tss, "", 0)} â€¢ ${fmt(g.work_kj, "kJ", 0)}`
    },
    {
      label: "Puissance & W'bal",
      badge: g.intensity_factor ? `IF ${g.intensity_factor.toFixed(2)}` : "W'",
      tone: (g.w_prime_min_pct ?? 100) < 25 ? "warn" : "ok",
      main: `${fmt(g.avg_power_w, "W", 0)} / NP ${fmt(g.normalized_power_w, "W", 0)}`,
      sub: `W'bal min : ${fmt(g.w_prime_min_pct, "%", 1)} â€¢ Cad ${fmt(g.avg_cadence_rpm, "rpm", 0)}`
    },
    {
      label: "Cardiaque ECG & Pa:Hr",
      badge: g.aerobic_decoupling_pa_hr_pct != null ? `Pa:Hr ${fmtSigned(g.aerobic_decoupling_pa_hr_pct, "%", 1)}` : "ECG",
      tone: (g.aerobic_decoupling_pa_hr_pct ?? 0) > 6 ? "warn" : "ok",
      main: `${fmt(g.avg_hr_bpm, "bpm", 0)} (max ${fmt(g.max_hr_bpm, "", 0)})`,
      sub: `EF(NP) ${fmt(g.ef_np, "W/bpm", 2)}`
    },
    {
      label: "Ventilation TymeWear",
      badge: "Ve / Rf / Vt",
      tone: "info",
      main: `Ve ${fmt(g.ve_mean, "L/min", 1)} (max ${fmt(g.ve_max, "", 0)})`,
      sub: `Rf ${fmt(g.rf_mean, "/min", 1)} â€¢ Vt ${fmt(g.vt_mean_l, "L", 2)} â€¢ Ve/100W ${fmt(g.ve_per_100w_mean, "", 1)}`
    },
    {
      label: "Thermoregulation CORE",
      badge: (g.tcore_max ?? 0) > 38.1 ? "Chaleur" : "Normo",
      tone: (g.tcore_max ?? 0) > 38.5 ? "crit" : (g.tcore_max ?? 0) > 38.1 ? "warn" : "ok",
      main: `Tcore max ${fmt(g.tcore_max, "Â°C", 2)}`,
      sub: `Moy ${fmt(g.tcore_mean, "Â°C", 2)} â€¢ HSI max ${fmt(g.hsi_max, "", 1)}`
    },
    {
      label: "DFA Î±â‚ (ECG)",
      badge: `Art ${fmt(g.artifacts_mean_pct, "%", 1)}`,
      tone: (g.artifacts_mean_pct ?? 0) > 5 ? "warn" : "info",
      main: `Î±â‚ moy ${fmt(g.alpha1_filtered_mean, "", 2)}`,
      sub: `Validite signal : ${fmt(g.alpha1_valid_pct, "%", 1)}`
    }
  ];

  grid.innerHTML = cards
    .map(
      (c) => `
      <article class="kpi-card">
        <div class="kpi-head">
          <span>${escapeHtml(c.label)}</span>
          <span class="badge badge-${c.tone}">${escapeHtml(c.badge)}</span>
        </div>
        <div class="kpi-main">${escapeHtml(c.main)}</div>
        <div class="kpi-sub">${escapeHtml(c.sub)}</div>
      </article>`
    )
    .join("");
}

function populateResponsiveTable(tableId, columns, rows) {
  const table = $(tableId);
  if (!table) return;
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr>`;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><th scope="row">â€”</th><td colspan="${Math.max(1, columns.length - 1)}">Aucune donnee.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map((cell, idx) =>
            idx === 0
              ? `<th scope="row">${escapeHtml(fmt(cell))}</th>`
              : `<td data-label="${escapeHtml(columns[idx] || "")}">${escapeHtml(fmt(cell))}</td>`
          )
          .join("")}</tr>`
    )
    .join("");
}

function renderIntervalsAndDrifts(session) {
  const cross = session?.cross_analysis || {};
  const drv = cross.start_vs_end_drift || {};
  const cad = cross.cadence_comparison || {};
  const par = cross.thermal_paradox || {};

  const panels = [];
  if (drv.found) {
    panels.push(`<article class="sub-panel"><h3>Derive Debut â†’ Fin</h3><p>${escapeHtml(drv.early_interval.label)} â†’ ${escapeHtml(drv.late_interval.label)} : Î”EF ${escapeHtml(fmtSigned(drv.deltas?.delta_ef_pct, "%", 1))}, Î”FC ${escapeHtml(fmtSigned(drv.deltas?.delta_hr_bpm, "bpm", 0))}, Î”Tcore ${escapeHtml(fmtSigned(drv.deltas?.delta_tcore_c, "Â°C", 2))}, Î”Î±â‚ ${escapeHtml(fmtSigned(drv.deltas?.delta_alpha1, "", 2))}.</p></article>`);
  }
  if (cad.found) {
    panels.push(`<article class="sub-panel"><h3>Effet Cadence</h3><p>${escapeHtml(fmt(cad.low_cad_interval.cadence_rpm, "rpm", 0))} vs ${escapeHtml(fmt(cad.high_cad_interval.cadence_rpm, "rpm", 0))} : Î”FC ${escapeHtml(fmtSigned(cad.deltas?.delta_hr_bpm, "bpm", 0))}, Î”EF ${escapeHtml(fmtSigned(cad.deltas?.delta_ef_pct, "%", 1))}, Î”Î±â‚ ${escapeHtml(fmtSigned(cad.deltas?.delta_alpha1, "", 2))}.</p></article>`);
  }
  if (par.found) {
    panels.push(`<article class="sub-panel"><h3>Impact Thermique</h3><p>Bloc chaud vs refroidi : Î”P ${escapeHtml(fmtSigned(par.deltas?.delta_p_w, "W", 0))}, Î”Tcore ${escapeHtml(fmtSigned(par.deltas?.delta_tcore_c, "Â°C", 2))}, Î”Î±â‚ ${escapeHtml(fmtSigned(par.deltas?.delta_alpha1, "", 2))}.</p></article>`);
  }
  $("triptych-container").innerHTML = panels.length
    ? panels.join("")
    : `<article class="sub-panel"><h3>Derives Croisees</h3><p>Pas de paire comparable sur cette seance (effort continu ou bloc unique).</p></article>`;

  const series = (session?.series || []).filter((grp) => grp.drift_1_to_n);
  const driftRows = series.map((grp) => {
    const d = grp.drift_1_to_n;
    return [
      `${grp.series_id} (${d.from_label}â†’${d.to_label})`,
      `${grp.interval_count} blocs`,
      fmtSigned(d.delta_power_w, "W", 0),
      fmtSigned(d.delta_hr_bpm, "bpm", 0),
      fmtSigned(d.delta_ef_pct, "%", 1),
      fmtSigned(d.delta_tcore_c, "Â°C", 2),
      fmtSigned(d.delta_alpha1, "", 2)
    ];
  });
  populateResponsiveTable("table-drift", ["Serie", "Blocs", "Î”P", "Î”FC", "Î”EF %", "Î”Tcore", "Î”Î±â‚"], driftRows);

  const workSegs = (session?.intervals || []).filter((s) => s.kind === "work");
  const workRows = workSegs.map((s) => [
    `${s.label}${s.series_id ? ` (${s.series_id})` : ""}`,
    formatSecondsHms(s.duration_s),
    fmt(s.p_avg_w, "W", 0),
    fmt(s.np_w, "W", 0),
    fmt(s.hr_avg_bpm, "bpm", 0),
    fmt(s.ef_w_bpm, "", 2),
    fmt(s.cadence_rpm, "rpm", 0),
    fmt(s.ve_avg, "L/m", 1),
    fmt(s.alpha1_filt, "", 2),
    fmt(s.tcore_end, "Â°C", 2)
  ]);
  populateResponsiveTable("table-work", ["Bloc", "Duree", "P moy", "NP", "FC", "EF", "Cad", "Ve", "Î±â‚", "Tcore"], workRows);
}

function renderThresholds(session) {
  const box = $("thresholds-container");
  if (!box) return;
  const th = session?.thresholds || {};
  const normo = th.normothermic || {};
  const hyper = th.hyperthermic || {};
  const bias = th.thermal_bias_w || {};

  box.innerHTML = `
    <article class="sub-panel">
      <h3>Normothermie (Tcore &lt; 37.8 Â°C)</h3>
      <dl class="threshold-kv">
        <dt>SVâ‚ (Î±â‚ 0.75)</dt><dd>${escapeHtml(fmt(normo.sv1?.watts, "W", 0))} Â· ${escapeHtml(fmt(normo.sv1?.hr, "bpm", 0))}</dd>
        <dt>SVâ‚‚ (Î±â‚ 0.50)</dt><dd>${escapeHtml(fmt(normo.sv2?.watts, "W", 0))} Â· ${escapeHtml(fmt(normo.sv2?.hr, "bpm", 0))}</dd>
      </dl>
    </article>
    <article class="sub-panel">
      <h3>Hyperthermie (Tcore &gt; 38.1 Â°C)</h3>
      <dl class="threshold-kv">
        <dt>SVâ‚ chaud</dt><dd>${escapeHtml(fmt(hyper.sv1?.watts, "W", 0))} Â· ${escapeHtml(fmt(hyper.sv1?.hr, "bpm", 0))}</dd>
        <dt>SVâ‚‚ chaud</dt><dd>${escapeHtml(fmt(hyper.sv2?.watts, "W", 0))} Â· ${escapeHtml(fmt(hyper.sv2?.hr, "bpm", 0))}</dd>
        <dt>Biais thermique</dt><dd>${escapeHtml(fmtSigned(bias.sv1_w_diff, "W", 0))} / ${escapeHtml(fmtSigned(bias.sv2_w_diff, "W", 0))}</dd>
      </dl>
    </article>`;
}

function renderAnomalies(session) {
  const box = $("anomalies-container");
  if (!box) return;
  const pauses = session?.incidents?.auto_pause_incidents || [];
  const tach = session?.incidents?.tachypnea_peaks || [];

  if (pauses.length === 0 && tach.length === 0) {
    box.innerHTML = "<p>Aucun incident d'auto-pause ni pic de tachypnee hyperthermique detecte.</p>";
    return;
  }

  const pauseHtml = pauses
    .map((inc) => {
      const ap = inc.auto_pause || {};
      return `
      <article class="cascade-step">
        <div class="cascade-step-head">
          <strong>Auto-Pause ${escapeHtml(ap.time_before_hms || "")} (gap ${escapeHtml(fmt(ap.gap_s, "s", 0))})</strong>
          <div class="cascade-badges">
            <span class="badge badge-warn">Î”Tcore ${escapeHtml(fmtSigned(ap.delta_tcore, "Â°C", 2))}</span>
            <span class="badge badge-info">Î”FC ${escapeHtml(fmtSigned(ap.delta_hr, "bpm", 0))}</span>
          </div>
        </div>
      </article>`;
    })
    .join("");

  const tachHtml = tach
    .map(
      (tp) => `
      <article class="cascade-step">
        <div class="cascade-step-head">
          <strong>Pic Tachypnee (${escapeHtml(tp.start_hms)} Â· ${escapeHtml(fmt(tp.duration_s, "s", 0))})</strong>
          <div class="cascade-badges">
            <span class="badge badge-crit">Rf ${escapeHtml(fmt(tp.rf_max, "/min", 0))}</span>
            <span class="badge badge-warn">Tcore ${escapeHtml(fmt(tp.tcore_max, "Â°C", 2))}</span>
          </div>
        </div>
      </article>`
    )
    .join("");

  box.innerHTML = pauseHtml + tachHtml;
}

/* ==========================================================================
   6. Suggestions Ciblees & Chat Multi-Tours
   ========================================================================== */
function buildContextualChipsFromBundle(bundle, session) {
  const gemChips = bundle?.gemini_synthesis?.suggested_questions;
  if (Array.isArray(gemChips) && gemChips.length >= 2) {
    return gemChips.slice(0, 4);
  }

  const chips = [];
  const g = session?.global || {};
  const w = bundle?.wellness || {};
  const series = (session?.series || []).filter((s) => s.drift_1_to_n);
  const works = (session?.intervals || []).filter((s) => s.kind === "work");

  if (series.length > 0) {
    const s0 = series[0];
    chips.push(`Explique la derive sur ${s0.series_id} (${s0.interval_count} blocs)`);
  } else if (works.length >= 2) {
    chips.push(`Compare mes ${works.length} blocs (P, FC, EF, derive)`);
  } else if (g.normalized_power_w) {
    chips.push(`Analyse l'endurance : NP ${Math.round(g.normalized_power_w)} W, Pa:Hr ${fmtSigned(g.aerobic_decoupling_pa_hr_pct, "%", 1)}`);
  }

  if (g.tcore_max && g.tcore_max >= 38.0) {
    chips.push(`Impact de Tcore ${g.tcore_max.toFixed(2)} Â°C sur mes seuils SV1/SV2`);
  } else if (g.ve_per_100w_mean) {
    chips.push(`Rendement ventilatoire (Ve/100W = ${g.ve_per_100w_mean.toFixed(1)}) et cadence`);
  }

  if (w.tsb != null && w.tsb < -20) {
    chips.push(`Comment calibrer demain avec TSB a ${Math.round(w.tsb)} ?`);
  } else if (g.tss) {
    chips.push(`Quelle seance demain apres ${Math.round(g.tss)} TSS ?`);
  }

  if (g.work_kj) {
    chips.push(`Protocole glucides/proteines sans viande pour ${Math.round(g.work_kj)} kJ`);
  } else {
    chips.push("Recharge glucides/proteines sans viande ce soir");
  }

  return chips.slice(0, 4);
}

function renderDynamicChips(bundle, session) {
  const container = $("quick-chips");
  if (!container) return;
  const chips = buildContextualChipsFromBundle(bundle, session);
  container.innerHTML = "";

  for (const q of chips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    btn.textContent = q;
    btn.addEventListener("click", () => handleChatSubmit(q));
    container.appendChild(btn);
  }
}

function appendChatMessage(role, rawText) {
  const log = $("chat-messages");
  if (!log) return;
  const div = document.createElement("div");
  div.className = `chat-msg ${role === "user" ? "chat-msg-user" : "chat-msg-assistant"}`;
  if (role === "user") div.textContent = rawText;
  else div.innerHTML = renderSafeMarkdown(rawText);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function handleChatSubmit(questionText) {
  const q = String(questionText || "").trim();
  if (!q) return;
  state.vault = loadVault();

  if (!state.vault.GEMINI_API_KEY) {
    setVaultDrawerOpen(true, "Renseignez GEMINI_API_KEY pour utiliser le chat.", true);
    return;
  }

  if (state.conversationHistory.length === 0 && state.bundle) {
    state.conversationHistory = buildFallbackSeedHistory(state.bundle);
  }

  appendChatMessage("user", q);
  const submitBtn = $("chat-submit");
  const input = $("chat-input");
  if (submitBtn) submitBtn.disabled = true;
  if (input) input.value = "";

  if (state.conversationHistory.length > 0 && state.conversationHistory[state.conversationHistory.length - 1].role === "user") {
    state.conversationHistory.push({ role: "model", parts: [{ text: "Bien recu." }] });
  }

  const logEl = $("chat-messages");
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "chat-msg chat-msg-assistant";
  loadingDiv.innerHTML = "<em>â³ Analyse Gemini en cours...</em>";
  if (logEl) {
    logEl.appendChild(loadingDiv);
    logEl.scrollTop = logEl.scrollHeight;
  }

  try {
    const res = await sendChatMessage({
      conversationHistory: state.conversationHistory,
      question: q,
      geminiApiKey: state.vault.GEMINI_API_KEY,
      model: state.vault.LLM_MODEL || "gemini-4-hydrogen"
    });
    loadingDiv.remove();
    if (res.usedModel && res.usedModel !== state.vault.LLM_MODEL) {
      state.vault = saveVault({ LLM_MODEL: res.usedModel });
      syncVaultFormInputs();
    }
    state.conversationHistory = res.conversationHistory;
    appendChatMessage("assistant", res.answer);
  } catch (err) {
    loadingDiv.remove();
    appendChatMessage("assistant", `**Erreur Gemini :** ${err.message}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function initChat() {
  $("chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleChatSubmit($("chat-input")?.value);
  });

  $("fab-ask")?.addEventListener("click", () => {
    $("chat-section")?.scrollIntoView({ behavior: "smooth" });
    $("chat-input")?.focus();
  });
}

function renderAll() {
  const bundle = state.bundle;
  const empty = $("empty-state");
  const root = $("report-root");
  const fab = $("fab-ask");

  if (!bundle || !Array.isArray(bundle.sessions) || bundle.sessions.length === 0) {
    if (empty) empty.hidden = false;
    if (root) root.hidden = true;
    if (fab) fab.hidden = true;
    return;
  }

  if (empty) empty.hidden = true;
  if (root) root.hidden = false;
  if (fab) fab.hidden = false;

  renderTabs(bundle);
  const idx = getActiveSessionIndex(bundle);
  const session = bundle.sessions[idx];
  $("report-meta-badge").textContent = `${bundle.date || ""} â€¢ ${session?.meta?.name || `Seance ${idx + 1}`}`;

  renderConsolidatedCard(bundle);
  renderVerdict(session, bundle);
  renderWellness(bundle);
  renderKpiGrid(session);
  renderIntervalsAndDrifts(session);
  renderThresholds(session);
  renderAnomalies(session);
  renderDynamicChips(bundle, session);
}

/* ==========================================================================
   7. Initialisation Unique au Demarrage
   ========================================================================== */
function restoreCachedReport() {
  const raw = safeGet(REPORT_CACHE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
      state.bundle = parsed;
      state.activeTab = parsed.sessions.length > 1 ? "summary" : "session-0";
      state.conversationHistory = buildFallbackSeedHistory(parsed);
      renderAll();
    }
  } catch {
    /* Cache invalide ignore */
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initThemeToggle();
  initNetworkAndSw();
  initVaultUI();
  initAccordion();
  initTableControls();
  initChat();

  $("btn-analyze-1click")?.addEventListener("click", runFullPipeline);
  restoreCachedReport();

  await resolveAndSyncModelsAtStartup();

  if (safeGet(AUTO_ANALYZE_KEY) === "1" && state.vault.INTERVALS_API_KEY && state.vault.GEMINI_API_KEY) {
    runFullPipeline();
  }
});