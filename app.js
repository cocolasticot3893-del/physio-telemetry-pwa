/**
 * PhysioPulse Telemetry — Contrôleur UI PWA 100 % Statique (ES Module)
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
  generateInitialSynthesis,
  sendChatMessage
} from "./gemini_client.js";

const REPORT_CACHE_KEY = "physiopulse_last_report_v3";
const COLOR_SCHEME_KEY = "color-scheme";

const state = {
  vault: loadVault(),
  bundle: null,
  activeTab: "summary",
  conversationHistory: [],
  busy: false
};

const $ = (id) => document.getElementById(id);

/* ==========================================================================
   Utilitaires d'échappement, formatage & rendu Markdown sûr
   ========================================================================== */
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
    /* Quota / navigation privée */
  }
}

function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Ignoré */
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
  if (val === null || val === undefined || val === "" || Number.isNaN(val)) return "—";
  if (typeof val === "number") {
    const out = digits !== null ? val.toFixed(digits) : Number.isInteger(val) ? String(val) : val.toFixed(2);
    return suffix ? `${out} ${suffix}`.trim() : out;
  }
  return suffix ? `${val} ${suffix}`.trim() : String(val);
}

function fmtSigned(val, suffix = "", digits = 2) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
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
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };

  const closeTable = () => {
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
    }
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

    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${applyInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
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
   1. Thème Clair/Sombre (2 états) & Statut Réseau / SW
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
   2. UI Coffre-Fort Centralisé (vault.js)
   ========================================================================== */
function syncVaultFormInputs() {
  const v = state.vault;
  if ($("vault-intervals-id")) $("vault-intervals-id").value = v.INTERVALS_ATHLETE_ID || "";
  if ($("vault-intervals-key")) $("vault-intervals-key").value = v.INTERVALS_API_KEY || "";
  if ($("vault-gemini-key")) $("vault-gemini-key").value = v.GEMINI_API_KEY || "";

  const modelSel = $("vault-llm-model");
  if (modelSel) {
    const modelVal = v.LLM_MODEL || "gemini-3.5-flash";
    if (!Array.from(modelSel.options).some((opt) => opt.value === modelVal)) {
      const opt = document.createElement("option");
      opt.value = modelVal;
      opt.textContent = modelVal;
      modelSel.appendChild(opt);
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
    textInt.textContent = intervalsOk ? "Intervals OK" : "Intervals Manquant";
  }

  const badgeGem = $("vault-badge-gemini");
  const textGem = $("vault-badge-gemini-text");
  if (badgeGem && textGem) {
    badgeGem.classList.toggle("is-ok", geminiOk);
    badgeGem.classList.toggle("is-missing", !geminiOk);
    textGem.textContent = geminiOk ? "Gemini OK" : "Gemini Manquant";
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
    setVaultDrawerOpen(true, "Coffre-fort enregistré (GLOBAL_ATHLETE_VAULT_V1 + clés plates).", false);
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
      setVaultDrawerOpen(true, `Coffre JSON importé (${file.name}).`, false);
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
      setVaultDrawerOpen(true, "Saisissez GEMINI_API_KEY pour charger les modèles de votre compte.", true);
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const models = await fetchAvailableGeminiModels(key);
      if (models.length === 0) {
        setVaultDrawerOpen(true, "Aucun modèle compatible generateContent trouvé.", true);
        return;
      }
      const currentVal = modelSel.value || state.vault.LLM_MODEL || "gemini-3.5-flash";
      modelSel.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.displayName && m.displayName !== m.id ? `${m.id} — ${m.displayName}` : m.id;
        modelSel.appendChild(opt);
      }
      if (Array.from(modelSel.options).some((o) => o.value === currentVal)) {
        modelSel.value = currentVal;
      }
      setVaultDrawerOpen(true, `${models.length} modèles Gemini chargés depuis votre compte.`, false);
    } catch (err) {
      setVaultDrawerOpen(true, `Impossible de lister les modèles : ${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  window.addEventListener("storage", () => {
    state.vault = loadVault();
    syncVaultFormInputs();
    updateVaultIndicators();
  });
}

/* ==========================================================================
   3. Accordéon & Tableaux Responsives
   ========================================================================== */
function initAccordion() {
  const accordion = $("tech-accordion");
  const toggleAllBtn = $("toggle-all-btn");
  if (!accordion || !toggleAllBtn) return;

  const syncButtonState = () => {
    const items = accordion.querySelectorAll(":scope > details");
    const allOpen = items.length > 0 && Array.prototype.every.call(items, (d) => d.open);
    toggleAllBtn.setAttribute("aria-expanded", String(allOpen));
  };

  const toggleAll = (sourceBtn) => {
    const expand = sourceBtn.getAttribute("aria-expanded") !== "true";
    for (const details of accordion.querySelectorAll(":scope > details")) {
      details.open = expand;
    }
    syncButtonState();
  };

  document.addEventListener(
    "command",
    (event) => {
      if (event.command !== "--toggle-all" || event.target !== accordion) return;
      toggleAll(event.source || toggleAllBtn);
    },
    { capture: true }
  );

  if (!Object.hasOwn(HTMLButtonElement.prototype, "commandForElement")) {
    toggleAllBtn.addEventListener("click", () => toggleAll(toggleAllBtn));
  }

  document.addEventListener(
    "toggle",
    (event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.matches("#tech-accordion > details")) {
        syncButtonState();
      }
    },
    { capture: true }
  );

  syncButtonState();
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
   4. Progression & Pipelines (1-Click Intervals.icu + Gemini / CSV local)
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
      parts: [{ text: `Contexte mathématique 1 Hz de la journée :\n${JSON.stringify(payload)}` }]
    },
    {
      role: "model",
      parts: [{ text: "Contexte JSON mathématique chargé." }]
    }
  ];
}

async function finalizeBundleAndGemini(rawDay, vault) {
  setPipelineStep(2, "active");
  const sessionReports = (rawDay.activities || []).map((act) =>
    analyzeActivity(act, { cp: vault.CP_WATTS, wPrime: vault.W_PRIME_J })
  );
  if (sessionReports.length === 0) {
    throw new Error("Aucune séance exploitable trouvée pour cette journée.");
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
  if (vault.GEMINI_API_KEY) {
    try {
      const gemRes = await generateInitialSynthesis({
        dailyBundle,
        geminiApiKey: vault.GEMINI_API_KEY,
        model: vault.LLM_MODEL
      });
      synthesis = gemRes.synthesis;
      state.conversationHistory = gemRes.conversationHistory;
      setPipelineStep(3, "done");
    } catch (err) {
      geminiError = err.message || "Erreur Gemini inconnue.";
      state.conversationHistory = buildFallbackSeedHistory(dailyBundle);
      setPipelineStep(3, "error");
    }
  } else {
    geminiError = "GEMINI_API_KEY absente : synthèse locale affichée.";
    state.conversationHistory = buildFallbackSeedHistory(dailyBundle);
    setPipelineStep(3, "error");
  }

  state.bundle = {
    ...dailyBundle,
    gemini_synthesis: synthesis,
    gemini_error: geminiError
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
    setVaultDrawerOpen(
      true,
      `Clés requises avant l'analyse 1-Click : renseignez ${missing.join(", ")} puis cliquez sur « Enregistrer dans le coffre-fort ».`,
      true
    );
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
          ? `Aucune activité trouvée sur Intervals.icu pour le ${targetDate}.`
          : "Aucune activité active trouvée sur les 30 derniers jours."
      );
    }
    setPipelineStep(1, "done");

    await finalizeBundleAndGemini(rawDay, v);
  } catch (err) {
    setPipelineStep(1, "error");
    showStatusAlert(err.message || "Échec du pipeline 1-Click.", true);
  } finally {
    state.busy = false;
    $("btn-analyze-1click").disabled = false;
  }
}

async function runLocalCsvPipeline(file) {
  if (state.busy) return;
  state.vault = loadVault();
  const v = state.vault;

  state.busy = true;
  showStatusAlert("");
  resetPipeline(true);
  setPipelineStep(1, "done");

  try {
    const csvText = await file.text();
    const rawAct = parseCsvTextToActivity(csvText, file.name);
    const today = new Date().toISOString().slice(0, 10);
    await finalizeBundleAndGemini(
      { date: today, wellness: null, activities: [rawAct] },
      v
    );
    setVaultDrawerOpen(false);
  } catch (err) {
    setPipelineStep(2, "error");
    setVaultDrawerOpen(true, `Erreur import CSV : ${err.message}`, true);
  } finally {
    state.busy = false;
  }
}

/* ==========================================================================
   5. Rendu Ordre 1 : Verdict Gemini/Local, Wellness, 6 KPIs
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
    { id: "summary", label: `Synthèse Journée (${sessions.length})` },
    ...sessions.map((s, idx) => ({
      id: `session-${idx}`,
      label: `Séance ${idx + 1} · ${s.meta?.name || `Activité ${idx + 1}`}`
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
  $("day-sessions-count").textContent = `${sessions.length} séances`;

  const stats = [
    ["Durée totale", formatSecondsHms(ds.moving_time_s)],
    ["Distance", fmt(ds.distance_km, "km", 1)],
    ["Dénivelé +", fmt(ds.elevation_gain_m, "m", 0)],
    ["TSS cumulé", fmt(ds.tss, "", 0)],
    ["NP pondérée", fmt(ds.np_weighted_w, "W", 0)],
    ["Tcore max jour", fmt(ds.tcore_max_day, "°C", 2)]
  ];

  $("day-consolidated-metrics").innerHTML = stats
    .map(([l, v]) => `<div class="mini-stat"><span class="mini-stat-label">${escapeHtml(l)}</span><span class="mini-stat-val">${escapeHtml(v)}</span></div>`)
    .join("");

  const evo = $("day-consolidated-evolution");
  if (ds.inter_session_drift) {
    const d = ds.inter_session_drift;
    evo.hidden = false;
    evo.textContent = `${d.from_session} → ${d.to_session} : Δα₁ ${fmtSigned(d.delta_alpha1, "", 2)} | ΔEF ${fmtSigned(d.delta_ef_pct ?? d.delta_ef_np_pct, "%", 1)} | ΔTcore max ${fmtSigned(d.delta_tcore_max_c, "°C", 2)}`;
  } else {
    evo.hidden = true;
  }
}

function buildLocalMetricsFallback(session) {
  const g = session?.global || {};
  const rPart = session?.correlations?.partial?.tcore_alpha1_given_p60s?.r_partial ?? null;
  const th = session?.thresholds || {};
  const incCount = (session?.incidents?.auto_pause_incidents?.length || 0) + (session?.incidents?.tachypnea_peaks?.length || 0);

  const strengths = [];
  const breaking = [];
  if (g.normalized_power_w) strengths.push(`NP ${fmt(g.normalized_power_w, "W", 0)} (IF ${fmt(g.intensity_factor, "", 2)}), travail ${fmt(g.work_kj, "kJ", 0)}.`);
  if (g.aerobic_decoupling_pa_hr_pct !== null && g.aerobic_decoupling_pa_hr_pct !== undefined) {
    if (g.aerobic_decoupling_pa_hr_pct <= 5) strengths.push(`Couplage cardiovasculaire Pa:Hr stable (${g.aerobic_decoupling_pa_hr_pct.toFixed(1)} %).`);
    else breaking.push(`Dérive Pa:Hr marquée (${g.aerobic_decoupling_pa_hr_pct.toFixed(1)} %).`);
  }
  if ((g.tcore_max ?? 0) >= 38.1) breaking.push(`Contrainte thermique élevée : Tcore max ${fmt(g.tcore_max, "°C", 2)} (HSI max ${fmt(g.hsi_max, "", 1)}).`);
  if (incCount > 0) breaking.push(`${incCount} incident(s) / pic(s) de tachypnée détecté(s) sur les flux 1 Hz.`);
  if (strengths.length === 0) strengths.push("Télémétrie 1 Hz analysée localement sans anomalie critique.");
  if (breaking.length === 0) breaking.push("Aucune rupture majeure détectée par les seuils locaux.");

  return {
    verdict: `Résumé mathématique local — ${session?.meta?.name || "Séance 1 Hz"}`,
    daily_synthesis: `NP ${fmt(g.normalized_power_w, "W", 0)} • FC moy ${fmt(g.avg_hr_bpm, "bpm", 0)} • Ve moy ${fmt(g.ve_mean, "L/min", 1)} • Tcore max ${fmt(g.tcore_max, "°C", 2)} • r(Tcore, α₁ | P60s) = ${fmt(rPart, "", 3)}.`,
    strengths,
    breaking_points: breaking,
    priority_axes: [
      { title: "Thermorégulation", metric_basis: `Tcore max ${fmt(g.tcore_max, "°C", 2)}`, action: "Refroidissement actif et hydratation 700-900 mg/L Na." },
      { title: "Dérive Cardiovasculaire", metric_basis: `Pa:Hr ${fmt(g.aerobic_decoupling_pa_hr_pct, "%", 1)}`, action: "Contrôler l'intensité sous SV₁ lors des transitions chaudes." },
      { title: "Ventilation TymeWear", metric_basis: `Ve moy ${fmt(g.ve_mean, "L/min", 1)}`, action: "Maintenir le volume courant Vt et limiter Rf > 55/min." },
      { title: "Seuils Thermiques SV₁/SV₂", metric_basis: `Biais thermique moyen ${fmtSigned(th?.thermal_bias_w?.mean_bias_w, "W", 0)}`, action: "Ajuster la puissance cible à la baisse au-delà de 38.1 °C." }
    ],
    technical_notes: `Artéfacts ECG moyens : ${fmt(g.artifacts_mean_pct, "%", 2)} (validité DFA α₁ : ${fmt(g.alpha1_valid_pct, "%", 1)}).`
  };
}

function renderVerdict(session, bundle) {
  const banner = $("executive-verdict");
  const errorBox = $("gemini-error-box");
  const gem = bundle?.gemini_synthesis;
  const fallback = buildLocalMetricsFallback(session);
  const v = gem || fallback;

  if (bundle?.gemini_error) {
    errorBox.hidden = false;
    errorBox.textContent = `Erreur Gemini : ${bundle.gemini_error} — Synthèse calculée localement affichée ci-dessous.`;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  const g = session?.global || {};
  const tone = (g.tcore_max ?? 0) > 38.5 || (g.aerobic_decoupling_pa_hr_pct ?? 0) > 8 ? "warn" : "ok";
  banner.className = `verdict-banner is-${tone}`;
  const badge = $("verdict-badge");
  badge.className = `badge badge-${gem ? "info" : tone}`;
  badge.textContent = gem ? "SYNTHÈSE GEMINI" : "RÉSUMÉ LOCAL";

  $("verdict-title").textContent = v.verdict || session?.meta?.name || "Verdict Exécutif";
  $("verdict-summary").textContent = v.daily_synthesis || "—";
  $("verdict-root-cause").textContent = "";

  const strengths = Array.isArray(v.strengths) ? v.strengths : [];
  const breaks = Array.isArray(v.breaking_points) ? v.breaking_points : [];
  $("strengths-list").innerHTML = strengths.length
    ? strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>Aucun point fort rapporté.</li>";
  $("breaking-points-list").innerHTML = breaks.length
    ? breaks.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>Aucun point de rupture rapporté.</li>";

  const axes = Array.isArray(v.priority_axes) ? v.priority_axes.slice(0, 4) : [];
  $("priorities-list").innerHTML = axes.length
    ? axes
        .map((ax) => {
          const title = ax?.title || "Axe prioritaire";
          const action = ax?.action || "";
          const basis = ax?.metric_basis ? `<span class="priority-target">Base : ${escapeHtml(ax.metric_basis)}</span>` : "";
          return `<li><strong>${escapeHtml(title)}</strong>${action ? ` — ${escapeHtml(action)}` : ""}${basis}</li>`;
        })
        .join("")
    : "<li>Aucun axe prioritaire disponible.</li>";

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
  const pvt = raw.PvtMedian != null ? `${fmt(raw.PvtMedian, "ms", 0)} (${fmt(raw.PvtLapses, "lapses", 0)})` : null;

  const items = [
    ["HRV RMSSD", fmt(w.hrv_rmssd, "ms", 0)],
    ["FC repos", fmt(w.resting_hr, "bpm", 0)],
    ["CTL / ATL / TSB", `${fmt(w.ctl, "", 0)} / ${fmt(w.atl, "", 0)} / ${fmt(w.tsb, "", 0)}`],
    ["Sommeil", w.sleep_secs ? formatSecondsHms(w.sleep_secs) : fmt(w.sleep_score, "/100", 0)],
    ["Readiness", fmt(w.readiness, "/100", 0)],
    ["Handgrip (D/G)", handgrip],
    ["PVT", pvt]
  ].filter(([, val]) => val && val !== "—" && val !== "— / — / —");

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
  const rPart = session.correlations?.partial?.tcore_alpha1_given_p60s?.r_partial ?? null;

  const cards = [
    {
      label: "1. Volume & D+",
      badge: session.meta?.type || "Ride",
      tone: "info",
      main: `${formatSecondsHms(g.moving_time_s)} · ${fmt(g.distance_km, "km", 1)}`,
      sub: `D+ ${fmt(g.elevation_gain_m, "m", 0)} • TSS ${fmt(g.tss, "", 0)} • ${fmt(g.work_kj, "kJ", 0)}`
    },
    {
      label: "2. Puissance / NP / W'bal",
      badge: g.intensity_factor ? `IF ${g.intensity_factor.toFixed(2)}` : "W'",
      tone: (g.w_prime_min_pct ?? 100) < 25 ? "warn" : "ok",
      main: `${fmt(g.avg_power_w, "W", 0)} / NP ${fmt(g.normalized_power_w, "W", 0)}`,
      sub: `W'bal min : ${fmt(g.w_prime_min_pct, "%", 1)} (${fmt(g.w_prime_bal_min_j, "J", 0)})`
    },
    {
      label: "3. Cardiaque ECG / Pa:Hr",
      badge: g.aerobic_decoupling_pa_hr_pct != null ? `Pa:Hr ${fmtSigned(g.aerobic_decoupling_pa_hr_pct, "%", 1)}` : "ECG",
      tone: (g.aerobic_decoupling_pa_hr_pct ?? 0) > 6 ? "warn" : "ok",
      main: `${fmt(g.avg_hr_bpm, "bpm", 0)} (max ${fmt(g.max_hr_bpm, "", 0)})`,
      sub: `EF(NP) ${fmt(g.ef_np, "W/bpm", 2)} • Cad ${fmt(g.avg_cadence_rpm, "rpm", 0)}`
    },
    {
      label: "4. Ventilation TymeWear",
      badge: "Ve / Rf / Vt",
      tone: "info",
      main: `Ve ${fmt(g.ve_mean, "L/min", 1)} (max ${fmt(g.ve_max, "", 0)})`,
      sub: `Rf ${fmt(g.rf_mean, "/min", 1)} • Vt ${fmt(g.vt_mean_l, "L", 2)} • Ve/100W ${fmt(g.ve_per_100w_mean, "", 1)}`
    },
    {
      label: "5. Thermorégulation CORE",
      badge: (g.tcore_max ?? 0) > 38.1 ? "Hyperthermie" : "Normo",
      tone: (g.tcore_max ?? 0) > 38.5 ? "crit" : (g.tcore_max ?? 0) > 38.1 ? "warn" : "ok",
      main: `Tcore max ${fmt(g.tcore_max, "°C", 2)}`,
      sub: `Moy ${fmt(g.tcore_mean, "°C", 2)} • Tskin max ${fmt(g.tskin_max, "°C", 1)} • HSI max ${fmt(g.hsi_max, "", 1)}`
    },
    {
      label: "6. DFA α₁ & r(Tcore, α₁ | P60s)",
      badge: `Art ${fmt(g.artifacts_mean_pct, "%", 1)}`,
      tone: rPart !== null && rPart < -0.25 ? "warn" : "info",
      main: `α₁ moy ${fmt(g.alpha1_filtered_mean, "", 2)}`,
      sub: `r(Tcore, α₁ | P60s) = ${fmt(rPart, "", 3)}`
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

/* ==========================================================================
   6. Rendu Ordre 2 : Accordéons Techniques Détaillés
   ========================================================================== */
function renderAnomalies(session) {
  const box = $("anomalies-container");
  if (!box) return;
  const autoPauses = session?.incidents?.auto_pause_incidents || [];
  const tachPeaks = session?.incidents?.tachypnea_peaks || [];

  if (autoPauses.length === 0 && tachPeaks.length === 0) {
    box.innerHTML = "<p>Aucun incident d'auto-pause en montée ni pic de tachypnée hyperthermique détecté.</p>";
    return;
  }

  const pauseHtml = autoPauses
    .map((inc) => {
      const pre = inc.pre_incident || {};
      const brk = inc.braking || {};
      const ap = inc.auto_pause || {};
      const post = inc.post_resume || {};
      return `
      <article class="cascade-step">
        <div class="cascade-step-head">
          <strong>Auto-Pause ${escapeHtml(ap.time_before_hms || "")} → ${escapeHtml(ap.time_after_hms || "")} (${escapeHtml(inc.trigger || "")})</strong>
          <div class="cascade-badges">
            <span class="badge badge-warn">ΔTcore ${escapeHtml(fmtSigned(ap.delta_tcore, "°C", 2))}</span>
            <span class="badge badge-warn">ΔHSI ${escapeHtml(fmtSigned(ap.delta_hsi, "", 2))}</span>
            <span class="badge badge-info">ΔFC ${escapeHtml(fmtSigned(ap.delta_hr, "bpm", 0))}</span>
          </div>
        </div>
        <div class="cascade-stages">
          <div class="cascade-stage"><strong>1. Pré-incident</strong>P=${escapeHtml(fmt(pre.p_avg_w, "W", 0))} · FC=${escapeHtml(fmt(pre.hr_avg, "bpm", 0))} · Rf=${escapeHtml(fmt(pre.rf_avg, "/m", 0))} · α₁=${escapeHtml(fmt(pre.alpha1_filt, "", 2))}</div>
          <div class="cascade-stage"><strong>2. Freinage</strong>Durée ${escapeHtml(fmt(brk.duration_s, "s", 0))} · P=${escapeHtml(fmt(brk.p_avg_w, "W", 0))} · Ve/100W=${escapeHtml(fmt(brk.ve_per_100w, "", 1))}</div>
          <div class="cascade-stage"><strong>3. Auto-pause</strong>Gap ${escapeHtml(fmt(ap.gap_s, "s", 0))} · Tcore ${escapeHtml(fmt(ap.tcore_before, "", 2))}→${escapeHtml(fmt(ap.tcore_after, "°C", 2))} · FC ${escapeHtml(fmt(ap.hr_before, "", 0))}→${escapeHtml(fmt(ap.hr_after, "bpm", 0))}</div>
          <div class="cascade-stage"><strong>4. Reprise</strong>P=${escapeHtml(fmt(post.p_avg_w, "W", 0))} · HSI max=${escapeHtml(fmt(post.hsi_max, "", 1))} · α₁=${escapeHtml(fmt(post.alpha1_start30, "", 2))}→${escapeHtml(fmt(post.alpha1_end30, "", 2))}</div>
        </div>
      </article>`;
    })
    .join("");

  const tachHtml = tachPeaks
    .map(
      (tp) => `
      <article class="cascade-step">
        <div class="cascade-step-head">
          <strong>Pic Tachypnée Hyperthermique (${escapeHtml(tp.start_hms)} → ${escapeHtml(tp.end_hms)})</strong>
          <div class="cascade-badges">
            <span class="badge badge-crit">Rf max ${escapeHtml(fmt(tp.rf_max, "/min", 0))}</span>
            <span class="badge badge-crit">Ve max ${escapeHtml(fmt(tp.ve_max, "L/m", 0))}</span>
            <span class="badge badge-warn">Tcore ${escapeHtml(fmt(tp.tcore_max, "°C", 2))}</span>
          </div>
        </div>
        <p>Durée ${escapeHtml(fmt(tp.duration_s, "s", 0))} • P moy ${escapeHtml(fmt(tp.p_avg_w, "W", 0))} • FC max ${escapeHtml(fmt(tp.hr_max, "bpm", 0))} • α₁ min ${escapeHtml(fmt(tp.alpha1_min, "", 2))}</p>
      </article>`
    )
    .join("");

  box.innerHTML = pauseHtml + tachHtml;
}

function renderSeriesAndTriptych(session) {
  const series = session?.series || [];
  const driftRows = series.map((grp) => {
    const d = grp.drift_1_to_n;
    if (!d) {
      return [grp.series_id, `${grp.interval_count} int.`, "—", "—", "—", "—", "—", "—"];
    }
    return [
      `${grp.series_id} (${d.from_label}→${d.to_label})`,
      `${grp.interval_count} int.`,
      fmtSigned(d.delta_power_w, "W", 0),
      fmtSigned(d.delta_cadence_rpm, "rpm", 0),
      fmtSigned(d.delta_hr_bpm, "bpm", 0),
      fmtSigned(d.delta_ef_pct, "%", 1),
      fmtSigned(d.delta_tcore_c, "°C", 2),
      fmtSigned(d.delta_alpha1, "", 2)
    ];
  });

  populateResponsiveTable(
    "table-drift",
    {
      columns: ["Série (1 → N)", "Blocs", "ΔP", "ΔCadence", "ΔFC", "ΔEF %", "ΔTcore", "ΔDFA α₁"],
      rows: driftRows
    },
    ["Série (1 → N)", "Blocs", "ΔP", "ΔCadence", "ΔFC", "ΔEF %", "ΔTcore", "ΔDFA α₁"]
  );

  const cross = session?.cross_analysis || {};
  const cad = cross.cadence_comparison || {};
  const par = cross.thermal_paradox || {};
  const drv = cross.start_vs_end_drift || {};

  const cadTxt = cad.found
    ? `${cad.low_cad_interval.label} (${fmt(cad.low_cad_interval.cadence_rpm, "rpm", 0)}) vs ${cad.high_cad_interval.label} (${fmt(cad.high_cad_interval.cadence_rpm, "rpm", 0)}) : ΔFC ${fmtSigned(cad.deltas?.delta_hr_bpm, "bpm", 0)}, ΔEF ${fmtSigned(cad.deltas?.delta_ef_pct, "%", 1)}, Δα₁ ${fmtSigned(cad.deltas?.delta_alpha1, "", 2)}.`
    : "Aucune paire à puissance équivalente (ΔP < 25 W) et ΔCad ≥ 15 rpm.";

  const parTxt = par.found
    ? `${par.hot_low_interval.label} (chaud, ${fmt(par.hot_low_interval.p_avg_w, "W", 0)}) vs ${par.cooled_high_interval.label} (refroidi, ${fmt(par.cooled_high_interval.p_avg_w, "W", 0)}) : ΔP ${fmtSigned(par.deltas?.delta_p_w, "W", 0)}, ΔTcore ${fmtSigned(par.deltas?.delta_tcore_c, "°C", 2)}, Δα₁ ${fmtSigned(par.deltas?.delta_alpha1, "", 2)}.`
    : "Aucun paradoxe thermique caractérisé sur cette séance.";

  const drvTxt = drv.found
    ? `${drv.early_interval.label} → ${drv.late_interval.label} : ΔEF ${fmtSigned(drv.deltas?.delta_ef_pct, "%", 1)}, ΔFC ${fmtSigned(drv.deltas?.delta_hr_bpm, "bpm", 0)}, ΔTcore ${fmtSigned(drv.deltas?.delta_tcore_c, "°C", 2)}, Δα₁ ${fmtSigned(drv.deltas?.delta_alpha1, "", 2)}.`
    : "Pas de paire début vs fin à puissance comparable (ΔP < 30 W).";

  const box = $("triptych-container");
  if (box) {
    box.innerHTML = `
      <article class="sub-panel"><h3>Comparaison Cadence</h3><p>${escapeHtml(cadTxt)}</p></article>
      <article class="sub-panel"><h3>Paradoxe Thermique</h3><p>${escapeHtml(parTxt)}</p></article>
      <article class="sub-panel"><h3>Dérive Début vs Fin</h3><p>${escapeHtml(drvTxt)}</p></article>`;
  }
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
      <h3>Normothermie (Tcore &lt; 37.8 °C)</h3>
      <dl class="threshold-kv">
        <dt>SV₁ (α₁ ∈ [0.70, 0.80])</dt><dd>${escapeHtml(fmt(normo.sv1?.watts, "W", 0))} · ${escapeHtml(fmt(normo.sv1?.hr, "bpm", 0))}</dd>
        <dt>SV₂ (α₁ ∈ [0.45, 0.55])</dt><dd>${escapeHtml(fmt(normo.sv2?.watts, "W", 0))} · ${escapeHtml(fmt(normo.sv2?.hr, "bpm", 0))}</dd>
        <dt>Échantillons 1 Hz</dt><dd>${escapeHtml(fmt(normo.sample_count, "s", 0))}</dd>
      </dl>
    </article>
    <article class="sub-panel">
      <h3>Hyperthermie (Tcore &gt; 38.1 °C)</h3>
      <dl class="threshold-kv">
        <dt>SV₁ thermique</dt><dd>${escapeHtml(fmt(hyper.sv1?.watts, "W", 0))} · ${escapeHtml(fmt(hyper.sv1?.hr, "bpm", 0))}</dd>
        <dt>SV₂ thermique</dt><dd>${escapeHtml(fmt(hyper.sv2?.watts, "W", 0))} · ${escapeHtml(fmt(hyper.sv2?.hr, "bpm", 0))}</dd>
        <dt>Biais thermique SV₁ / SV₂</dt><dd>${escapeHtml(fmtSigned(bias.sv1_w_diff, "W", 0))} / ${escapeHtml(fmtSigned(bias.sv2_w_diff, "W", 0))}</dd>
      </dl>
    </article>`;
}

function populateResponsiveTable(tableId, tableData, fallbackColumns) {
  const table = $(tableId);
  if (!table) return;
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return;

  const cols = Array.isArray(tableData?.columns) && tableData.columns.length > 0 ? tableData.columns : fallbackColumns;
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];

  for (let i = 1; i < cols.length && i < 12; i += 1) {
    table.style.setProperty(`--label-${i + 1}`, `"${String(cols[i]).replaceAll('"', '\\"')}"`);
  }

  thead.innerHTML = `<tr>${cols.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr>`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="${Math.max(1, cols.length - 1)}">Aucune donnée disponible.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((cells) => `<tr>${cells.map((cell, idx) => (idx === 0 ? `<th scope="row">${escapeHtml(fmt(cell))}</th>` : `<td>${escapeHtml(fmt(cell))}</td>`)).join("")}</tr>`)
    .join("");
}

function renderIntervalTables(session) {
  const segments = session?.intervals || [];
  const colsA = ["Segment", "Durée", "P moy", "NP", "Cadence", "Couple", "Vitesse", "Pente", "FC moy", "EF (W/bpm)"];
  const rowsA = segments.map((s) => [
    `${s.label}${s.series_id ? ` (${s.series_id})` : ""}`,
    formatSecondsHms(s.duration_s),
    fmt(s.p_avg_w, "W", 0),
    fmt(s.np_w, "W", 0),
    fmt(s.cadence_rpm, "rpm", 0),
    fmt(s.torque_nm, "Nm", 1),
    fmt(s.speed_kmh, "km/h", 1),
    fmtSigned(s.grade_pct, "%", 1),
    fmt(s.hr_avg_bpm, "bpm", 0),
    fmt(s.ef_w_bpm, "", 2)
  ]);
  populateResponsiveTable("table-a", { columns: colsA, rows: rowsA }, colsA);

  const colsB = ["Segment", "Ve", "Rf", "Vt", "Ve/100W", "DFA α₁", "Artéfacts", "Tcore fin", "Tskin", "HSI max"];
  const rowsB = segments.map((s) => [
    s.label,
    fmt(s.ve_avg, "L/m", 1),
    fmt(s.rf_avg, "/m", 1),
    fmt(s.vt_avg_l, "L", 2),
    fmt(s.ve_per_100w, "", 1),
    fmt(s.alpha1_filt, "", 2),
    fmt(s.artifacts_pct, "%", 1),
    fmt(s.tcore_end, "°C", 2),
    fmt(s.tskin_avg, "°C", 1),
    fmt(s.hsi_max, "", 1)
  ]);
  populateResponsiveTable("table-b", { columns: colsB, rows: rowsB }, colsB);
}

function renderAll() {
  const bundle = state.bundle;
  const empty = $("empty-state");
  const root = $("report-root");
  const fab = $("fab-ask");

  if (!bundle || !bundle.sessions || bundle.sessions.length === 0) {
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
  $("report-meta-badge").textContent = `${bundle.date || ""} • ${session?.meta?.name || `Séance ${idx + 1}`}`;

  renderConsolidatedCard(bundle);
  renderVerdict(session, bundle);
  renderWellness(bundle);
  renderKpiGrid(session);
  renderAnomalies(session);
  renderSeriesAndTriptych(session);
  renderThresholds(session);
  renderIntervalTables(session);
}

/* ==========================================================================
   7. Chat Multi-Tours Gemini (gemini_client.js)
   ========================================================================== */
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
    setVaultDrawerOpen(true, "Renseignez GEMINI_API_KEY dans le coffre-fort pour discuter avec Gemini.", true);
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

  try {
    const res = await sendChatMessage({
      conversationHistory: state.conversationHistory,
      question: q,
      geminiApiKey: state.vault.GEMINI_API_KEY,
      model: state.vault.LLM_MODEL
    });
    state.conversationHistory = res.conversationHistory;
    appendChatMessage("assistant", res.answer);
  } catch (err) {
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

  document.querySelectorAll(".chip-btn").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.getAttribute("data-question");
      if (q) handleChatSubmit(q);
    });
  });

  $("fab-ask")?.addEventListener("click", () => {
    $("chat-section")?.scrollIntoView({ behavior: "smooth" });
    $("chat-input")?.focus();
  });
}

/* ==========================================================================
   8. Initialisation
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
    /* Cache invalide ignoré */
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initNetworkAndSw();
  initVaultUI();
  initAccordion();
  initTableControls();
  initChat();

  $("btn-analyze-1click")?.addEventListener("click", runFullPipeline);
  restoreCachedReport();
});
