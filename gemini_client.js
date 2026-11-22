/**
 * Client direct Gemini API (v1beta generateContent) â€” Resiliant mobile, sans alert() bloquant.
 * Cible prioritaire : gemini-4-hydrogen avec adaptation automatique si le catalogue de modeles evolue.
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 45000;

export const PREFERRED_MODEL_ORDER = Object.freeze([
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest"
]);

export const SYSTEM_PROMPT = `Tu es un physiologiste de l'exercice et data scientist du sport (approche First Principles).

OBJECTIF :
Produire une analyse claire, utile et actionnable de la journee a partir des maths essentielles (moyennes globales, intervalles de travail, derives intra-serie 1 -> N et debut/fin, decouplage Pa:Hr, seuils SV1/SV2 normo vs hyperthermie, recuperation wellness).

CALIBRATION :
- Seance simple (endurance homogene sans derive marquee ni Tcore > 38.0 C) : ultra-concis (100 a 160 mots).
- Seance complexe (series/intervalles, derive EF/FC/alpha1, Tcore > 38.0 C ou forte charge) : dense et scannable en diagonale (220 a 360 mots max).

REGLES STRICTES :
- Zero formule de politesse, zero introduction creuse, zero conclusion recapitulative, zero avertissement generique.
- Cite les chiffres exacts et les ecarts (Delta) utiles a la decision ; ignore le superflu.
- TymeWear = ECG (jamais PPG) + ventilation (Ve/Rf/Vt) ; CORE = Tcore/Tskin/HSI ; nutrition strictement compatible regime sans ou tres peu de viande.
- Pour "suggested_questions", propose 4 questions courtes (< 55 caracteres), precises et directement exploitables pour approfondir CETTE journee (ex: recalibrage intensite demain, explication d'une derive precise, ajustement refroidissement/hydratation, protocole nutrition sans viande). Jamais de questions vagues ou generiques.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundNum(val, digits = 2) {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function cleanSecret(val) {
  return String(val ?? "").replace(/[\r\n\t]+/g, "").trim();
}

function cleanModelId(val) {
  return cleanSecret(val).replace(/^models\//, "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error(`Delai depasse (${Math.round(timeoutMs / 1000)} s) vers l'API Gemini.`);
      timeoutErr.isRetryableNetwork = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function pickBestAvailableModel(modelsList, currentSavedModel = "", excludeIds = []) {
  const excluded = new Set(excludeIds.map(cleanModelId).filter(Boolean));
  const availableIds = (Array.isArray(modelsList) ? modelsList : [])
    .map((m) => cleanModelId(typeof m === "string" ? m : m?.id || m?.name || ""))
    .filter((id) => id && !excluded.has(id));

  const saved = cleanModelId(currentSavedModel);

  if (availableIds.length === 0) {
    return saved && !excluded.has(saved) ? saved : PREFERRED_MODEL_ORDER[0];
  }

  // Priorite a gemini-4-hydrogen si l'utilisateur etait sur un ancien defaut deprecie
  if (saved && saved !== "gemini-2.5-flash" && saved !== "gemini-3.5-flash" && availableIds.includes(saved)) {
    return saved;
  }

  for (const candidate of PREFERRED_MODEL_ORDER) {
    if (availableIds.includes(candidate)) {
      return candidate;
    }
  }

  const hydrogenLike = availableIds.find((id) => id.includes("hydrogen"));
  if (hydrogenLike) return hydrogenLike;

  const flashLike = availableIds.find((id) => id.includes("flash") && !id.includes("thinking") && !id.includes("image"));
  if (flashLike) return flashLike;

  return availableIds[0];
}

export async function fetchAvailableGeminiModels(geminiApiKey) {
  const cleanKey = cleanSecret(geminiApiKey);
  if (!cleanKey) {
    throw new Error("Cle API Gemini requise pour lister les modeles.");
  }

  const url = `${GEMINI_BASE_URL}?key=${encodeURIComponent(cleanKey)}&pageSize=100`;
  const response = await fetchWithTimeout(url, { method: "GET" }, 15000);
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Erreur Gemini Models HTTP ${response.status} : ${errText.slice(0, 160)}`);
  }

  const data = await response.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => {
      const name = String(m?.name || "");
      const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      return name.includes("gemini-") && methods.includes("generateContent");
    })
    .map((m) => ({
      id: cleanModelId(m.name),
      displayName: String(m.displayName || cleanModelId(m.name))
    }))
    .sort((a, b) => {
      const ia = PREFERRED_MODEL_ORDER.indexOf(a.id);
      const ib = PREFERRED_MODEL_ORDER.indexOf(b.id);
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      }
      return b.id.localeCompare(a.id);
    });
}

function compactWorkIntervals(intervals) {
  if (!Array.isArray(intervals)) return [];
  const works = intervals.filter((seg) => seg && seg.kind === "work");
  return works.slice(0, 20).map((seg) => ({
    label: seg.label ?? "",
    series: seg.series_id ?? null,
    dur_s: roundNum(seg.duration_s, 0),
    p_w: roundNum(seg.p_avg_w, 0),
    np_w: roundNum(seg.np_w, 0),
    cad: roundNum(seg.cadence_rpm, 0),
    hr: roundNum(seg.hr_avg_bpm, 0),
    ef: roundNum(seg.ef_w_bpm, 2),
    ve: roundNum(seg.ve_avg, 1),
    rf: roundNum(seg.rf_avg, 1),
    a1: roundNum(seg.alpha1_filt, 2),
    tc_end: roundNum(seg.tcore_end, 2),
    hsi_max: roundNum(seg.hsi_max, 1)
  }));
}

function compactSeriesDrift(seriesList) {
  if (!Array.isArray(seriesList)) return [];
  return seriesList
    .filter((s) => s && s.drift_1_to_n)
    .map((s) => {
      const d = s.drift_1_to_n;
      return {
        series: s.series_id,
        count: s.interval_count,
        span: `${d.from_label} -> ${d.to_label}`,
        d_p_w: roundNum(d.delta_power_w, 0),
        d_hr: roundNum(d.delta_hr_bpm, 1),
        d_ef_pct: roundNum(d.delta_ef_pct, 1),
        d_a1: roundNum(d.delta_alpha1, 2),
        d_tc: roundNum(d.delta_tcore_c, 2),
        d_ve_100w_pct: roundNum(d.delta_ve_per_100w_pct, 1)
      };
    });
}

function compactThresholds(th) {
  if (!th) return null;
  const normoN = th.normothermic?.sample_count || 0;
  const hyperN = th.hyperthermic?.sample_count || 0;
  if (normoN === 0 && hyperN === 0) return null;
  return {
    normo: normoN > 0 ? {
      sv1_w: roundNum(th.normothermic?.sv1?.watts, 0),
      sv1_hr: roundNum(th.normothermic?.sv1?.hr, 0),
      sv2_w: roundNum(th.normothermic?.sv2?.watts, 0),
      sv2_hr: roundNum(th.normothermic?.sv2?.hr, 0)
    } : null,
    hyper: hyperN > 0 ? {
      sv1_w: roundNum(th.hyperthermic?.sv1?.watts, 0),
      sv1_hr: roundNum(th.hyperthermic?.sv1?.hr, 0),
      sv2_w: roundNum(th.hyperthermic?.sv2?.watts, 0),
      sv2_hr: roundNum(th.hyperthermic?.sv2?.hr, 0)
    } : null,
    bias_sv1_w: roundNum(th.thermal_bias_w?.sv1_w_diff, 0),
    bias_sv2_w: roundNum(th.thermal_bias_w?.sv2_w_diff, 0)
  };
}

function compactCrossAnalysis(cross) {
  if (!cross) return null;
  const out = {};
  if (cross.start_vs_end_drift?.found) {
    const d = cross.start_vs_end_drift;
    out.start_vs_end = {
      pair: `${d.early_interval?.label} -> ${d.late_interval?.label}`,
      d_ef_pct: roundNum(d.deltas?.delta_ef_pct, 1),
      d_hr: roundNum(d.deltas?.delta_hr_bpm, 1),
      d_a1: roundNum(d.deltas?.delta_alpha1, 2),
      d_tc: roundNum(d.deltas?.delta_tcore_c, 2)
    };
  }
  if (cross.cadence_comparison?.found) {
    const c = cross.cadence_comparison;
    out.cadence = {
      low_rpm: roundNum(c.low_cad_interval?.cadence_rpm, 0),
      high_rpm: roundNum(c.high_cad_interval?.cadence_rpm, 0),
      d_hr: roundNum(c.deltas?.delta_hr_bpm, 1),
      d_ef_pct: roundNum(c.deltas?.delta_ef_pct, 1),
      d_a1: roundNum(c.deltas?.delta_alpha1, 2)
    };
  }
  if (cross.thermal_paradox?.found) {
    const p = cross.thermal_paradox;
    out.thermal_paradox = {
      d_p_w: roundNum(p.deltas?.delta_p_w, 0),
      d_tc: roundNum(p.deltas?.delta_tcore_c, 2),
      d_a1: roundNum(p.deltas?.delta_alpha1, 2)
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function compactIncidents(inc) {
  const pauses = Array.isArray(inc?.auto_pause_incidents) ? inc.auto_pause_incidents : [];
  const tach = Array.isArray(inc?.tachypnea_peaks) ? inc.tachypnea_peaks : [];
  if (pauses.length === 0 && tach.length === 0) return null;
  return {
    auto_pauses: pauses.slice(0, 5).map((p) => ({
      at: p.auto_pause?.time_before_hms,
      gap_s: roundNum(p.auto_pause?.gap_s, 0),
      d_tc: roundNum(p.auto_pause?.delta_tcore, 2),
      d_hr: roundNum(p.auto_pause?.delta_hr, 0)
    })),
    tachypnea_peaks: tach.slice(0, 5).map((t) => ({
      at: t.start_hms,
      dur_s: roundNum(t.duration_s, 0),
      rf_max: roundNum(t.rf_max, 0),
      tc_max: roundNum(t.tcore_max, 2)
    }))
  };
}

function extractEssentialSession(session, index) {
  const s = session || {};
  const g = s.global || {};
  const out = {
    index: index + 1,
    name: s.meta?.name || s.name || `Seance ${index + 1}`,
    sport: s.meta?.type || s.sport || "Ride",
    global: {
      dur_s: roundNum(g.moving_time_s, 0),
      dist_km: roundNum(g.distance_km, 1),
      d_plus_m: roundNum(g.elevation_gain_m, 0),
      work_kj: roundNum(g.work_kj, 0),
      p_avg_w: roundNum(g.avg_power_w, 0),
      np_w: roundNum(g.normalized_power_w, 0),
      if: roundNum(g.intensity_factor, 2),
      tss: roundNum(g.tss, 0),
      hr_avg: roundNum(g.avg_hr_bpm, 0),
      hr_max: roundNum(g.max_hr_bpm, 0),
      ef_np: roundNum(g.ef_np, 2),
      pa_hr_pct: roundNum(g.aerobic_decoupling_pa_hr_pct, 1),
      cad_avg: roundNum(g.avg_cadence_rpm, 0),
      w_bal_min_pct: roundNum(g.w_prime_min_pct, 1),
      ve_avg: roundNum(g.ve_mean, 1),
      rf_avg: roundNum(g.rf_mean, 1),
      vt_avg_l: roundNum(g.vt_mean_l, 2),
      ve_100w: roundNum(g.ve_per_100w_mean, 1),
      a1_avg: roundNum(g.alpha1_filtered_mean, 2),
      art_pct: roundNum(g.artifacts_mean_pct, 1),
      tc_max: roundNum(g.tcore_max, 2),
      hsi_max: roundNum(g.hsi_max, 1)
    }
  };

  const seriesDrift = compactSeriesDrift(s.series);
  if (seriesDrift.length > 0) out.series_drift = seriesDrift;

  const workIntervals = compactWorkIntervals(s.intervals);
  if (workIntervals.length > 0) out.work_intervals = workIntervals;

  const thresholds = compactThresholds(s.thresholds);
  if (thresholds) out.thresholds = thresholds;

  const cross = compactCrossAnalysis(s.cross_analysis);
  if (cross) out.drifts = cross;

  const incidents = compactIncidents(s.incidents);
  if (incidents) out.incidents = incidents;

  return out;
}

export function buildInitialContextPayload(dailyBundle) {
  const bundle = dailyBundle || {};
  const rawSessions = Array.isArray(bundle.sessions) ? bundle.sessions : [];
  const w = bundle.wellness || null;
  const rawW = w?.raw || {};
  const ds = bundle.day_summary || null;

  return {
    date: bundle.date || "",
    wellness: w ? {
      hrv_rmssd: roundNum(w.hrv_rmssd, 1),
      resting_hr: roundNum(w.resting_hr, 0),
      ctl: roundNum(w.ctl, 1),
      atl: roundNum(w.atl, 1),
      tsb: roundNum(w.tsb, 1),
      sleep_h: w.sleep_secs ? roundNum(w.sleep_secs / 3600, 2) : null,
      readiness: roundNum(w.readiness, 0),
      handgrip_d: roundNum(rawW.HandgripDroit, 1),
      handgrip_g: roundNum(rawW.HandgripGauche, 1),
      pvt_ms: roundNum(rawW.PvtMedian, 0),
      pvt_lapses: roundNum(rawW.PvtLapses, 0)
    } : null,
    day_totals: ds && rawSessions.length > 1 ? {
      sessions: ds.session_count,
      dur_s: roundNum(ds.moving_time_s, 0),
      tss: roundNum(ds.tss, 0),
      work_kj: roundNum(ds.work_kj, 0),
      np_w: roundNum(ds.np_weighted_w, 0),
      tc_max: roundNum(ds.tcore_max_day, 2),
      inter_session_drift: ds.inter_session_drift || null
    } : null,
    sessions: rawSessions.map((sess, idx) => extractEssentialSession(sess, idx))
  };
}

function extractReplyText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const nonThought = parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("\n\n").trim();
  if (nonThought) return nonThought;
  const all = parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n\n").trim();
  if (all) return all;
  const reason = data?.candidates?.[0]?.finishReason || "UNKNOWN";
  throw new Error(`Reponse Gemini vide (finishReason: ${reason}).`);
}

async function callGeminiOnce({ cleanKey, cleanModel, systemText, contents, generationConfig, maxRetries = 2 }) {
  const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });

      if (response.ok) {
        const data = await response.json();
        return extractReplyText(data);
      }

      let detail = "";
      try {
        const errJson = await response.json();
        detail = errJson?.error?.message || "";
      } catch {
        detail = "";
      }

      const isRetryableHttp = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (isRetryableHttp && attempt < maxRetries) {
        const delayMs = 900 * (2 ** attempt) + Math.floor(Math.random() * 400);
        await sleep(delayMs);
        continue;
      }

      const err = new Error(`Gemini API HTTP ${response.status} (${cleanModel})${detail ? ` : ${detail}` : ""}`);
      err.status = response.status;
      err.detail = detail;
      throw err;
    } catch (err) {
      const isNetworkErr =
        err instanceof TypeError ||
        Boolean(err?.isRetryableNetwork) ||
        (!err?.status && /fetch|network|abort|delai/i.test(String(err?.message || "")));

      if (isNetworkErr && attempt < maxRetries) {
        const delayMs = 800 * (2 ** attempt) + Math.floor(Math.random() * 350);
        await sleep(delayMs);
        continue;
      }

      if (err instanceof TypeError) {
        const netErr = new Error(`Echec reseau (Failed to fetch) vers Gemini (${cleanModel}). Verifiez la connexion internet ou la validite de la cle API.`);
        netErr.isNetwork = true;
        throw netErr;
      }
      throw err;
    }
  }

  throw new Error(`Echec de l'appel Gemini (${cleanModel}).`);
}

async function callGeminiWithAutoFallback({ geminiApiKey, model, systemText, contents, generationConfig }) {
  const cleanKey = cleanSecret(geminiApiKey);
  if (!cleanKey) {
    throw new Error("Cle API Gemini manquante.");
  }

  const initialModel = cleanModelId(model) || PREFERRED_MODEL_ORDER[0];
  try {
    const text = await callGeminiOnce({
      cleanKey,
      cleanModel: initialModel,
      systemText,
      contents,
      generationConfig
    });
    return { text, usedModel: initialModel };
  } catch (err) {
    const modelBroken =
      err?.status === 404 ||
      (err?.status === 400 && /model|not found|not supported/i.test(String(err?.detail || err?.message || "")));

    if (!modelBroken) {
      throw err;
    }

    // Adaptation automatique : interroge la liste live et bascule sur le meilleur modele compatible
    const liveModels = await fetchAvailableGeminiModels(cleanKey);
    const fallbackModel = pickBestAvailableModel(liveModels, "", [initialModel]);
    if (!fallbackModel || fallbackModel === initialModel) {
      throw err;
    }

    const text = await callGeminiOnce({
      cleanKey,
      cleanModel: fallbackModel,
      systemText,
      contents,
      generationConfig
    });
    return { text, usedModel: fallbackModel };
  }
}

function parseStrictSynthesisJson(rawText) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(text);
  return {
    verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "",
    daily_synthesis: typeof parsed.daily_synthesis === "string" ? parsed.daily_synthesis.trim() : "",
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String).filter(Boolean) : [],
    breaking_points: Array.isArray(parsed.breaking_points) ? parsed.breaking_points.map(String).filter(Boolean) : [],
    priority_axes: Array.isArray(parsed.priority_axes)
      ? parsed.priority_axes
          .map((ax) => ({
            title: typeof ax?.title === "string" ? ax.title.trim() : "",
            metric_basis: typeof ax?.metric_basis === "string" ? ax.metric_basis.trim() : "",
            action: typeof ax?.action === "string" ? ax.action.trim() : ""
          }))
          .filter((ax) => ax.title || ax.action)
      : [],
    technical_notes: typeof parsed.technical_notes === "string" ? parsed.technical_notes.trim() : "",
    suggested_questions: Array.isArray(parsed.suggested_questions)
      ? parsed.suggested_questions.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 4)
      : []
  };
}

export async function generateInitialSynthesis({ dailyBundle, geminiApiKey, model = "gemini-4-hydrogen" }) {
  const contextPayload = buildInitialContextPayload(dailyBundle);

  const userPrompt = [
    "Analyse les donnees mathematiques essentielles de la journee ci-dessous.",
    "Retourne EXCLUSIVEMENT un objet JSON valide respectant exactement ce schema :",
    "{",
    '  "verdict": "string (verdict direct en 1-2 phrases)",',
    '  "daily_synthesis": "string (lecture croisee chiffres + derives + recuperation)",',
    '  "strengths": ["string"],',
    '  "breaking_points": ["string"],',
    '  "priority_axes": [{ "title": "string", "metric_basis": "string", "action": "string" }],',
    '  "technical_notes": "string (qualite ECG/artefacts, CORE, note nutrition sans viande)",',
    '  "suggested_questions": ["string (4 questions courtes < 55 car., specifiques aux vrais chiffres de cette journee)"]',
    "}",
    "",
    "DONNEES ESSENTIELLES DU JOUR :",
    JSON.stringify(contextPayload)
  ].join("\n");

  const userTurn = { role: "user", parts: [{ text: userPrompt }] };

  const { text: rawAnswer, usedModel } = await callGeminiWithAutoFallback({
    geminiApiKey,
    model,
    systemText: SYSTEM_PROMPT,
    contents: [userTurn],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2
    }
  });

  const synthesis = parseStrictSynthesisJson(rawAnswer);
  const modelTurn = { role: "model", parts: [{ text: JSON.stringify(synthesis) }] };

  return {
    synthesis,
    usedModel,
    conversationHistory: [userTurn, modelTurn]
  };
}

export async function sendChatMessage({
  conversationHistory = [],
  question,
  geminiApiKey,
  model = "gemini-4-hydrogen"
}) {
  const cleanQuestion = String(question ?? "").trim();
  if (!cleanQuestion) {
    throw new Error("Question vide.");
  }

  const userTurn = { role: "user", parts: [{ text: cleanQuestion }] };
  const nextHistory = [...conversationHistory, userTurn];

  const { text: answer, usedModel } = await callGeminiWithAutoFallback({
    geminiApiKey,
    model,
    systemText: `${SYSTEM_PROMPT}\n\nMode suivi interactif : reponds en Markdown concis, factuel et chiffre (sans bloc JSON brut ni ligne SUGGESTED_CHIPS).`,
    contents: nextHistory,
    generationConfig: {
      temperature: 0.25
    }
  });

  const modelTurn = { role: "model", parts: [{ text: answer }] };
  return {
    answer,
    usedModel,
    conversationHistory: [...nextHistory, modelTurn]
  };
}