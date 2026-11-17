/**
 * Client direct Gemini API (v1beta generateContent) + Prompt "First Principles".
 * Zéro dépendance, zéro backend, conversation multi-tours en mémoire.
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const RAW_STREAM_KEYS = new Set([
  "streams",
  "rawStreams",
  "raw_streams",
  "points",
  "samples",
  "series_1hz",
  "time_series_1hz"
]);

export const SYSTEM_PROMPT = `Tu es un physiologiste de l'exercice et analyste biométrique rigoureux appliquant une approche "First Principles".
Règles strictes d'analyse et de rédaction :
1. Zéro flatterie, zéro introduction générique, zéro conclusion récapitulative creuse : entre directement dans l'analyse critique et factuelle dès la première phrase.
2. À la première apparition de tout terme technique ou acronyme (NP, IF, TSS, EF, Pa:Hr, W'bal, VE, Rf, VT, DFA alpha-1, Tcore, Tskin, HSI, SV1, SV2, RMSSD), ajoute systématiquement entre parenthèses une explication concrète en 5 à 12 mots simples.
3. Matériel spécifique : la fréquence cardiaque et le DFA alpha-1 proviennent d'une ceinture ECG TymeWear (mesure électrique directe, jamais PPG optique) couplée à la ventilation (VE, Rf, VT) ; la thermorégulation provient du capteur CORE (Tcore, Tskin, HSI). Le DFA alpha-1 n'est exploitable que lorsque le taux d'artefacts est strictement inférieur à 5 %.
4. Nutrition strictement sans viande (régime végétarien / pesco-végétarien) : privilégie les protéines à haute biodisponibilité riches en leucine (œufs, produits laitiers/whey, soja, poisson si pesco-végétarien), et calibre l'apport intra-effort autour de 80 à 90 g/h de glucides (ratio maltodextrine/fructose 1:0.8) avec 700 à 900 mg/L de sodium selon la dérive thermique et sudorale.
5. Justifie chaque affirmation par les grandeurs mesurées (corrélations, corrélations partielles, seuils SV1/SV2, dérives intra-séries, intervalles/transitions et incidents étape par étape).`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLargeNumericArray(value) {
  if (!Array.isArray(value) || value.length <= 250) return false;
  return typeof value[0] === "number" || value[0] === null;
}

/**
 * Copie récursivement un objet analytique en éliminant uniquement les flux bruts 1 Hz
 * tout en conservant 100 % des globaux, corrélations, seuils, dérives, intervalles et incidents.
 */
function stripRawOneHzStreams(node) {
  if (node === null || node === undefined) return node;
  if (typeof node !== "object") return node;

  if (Array.isArray(node)) {
    if (isLargeNumericArray(node)) return undefined;
    return node.map((item) => stripRawOneHzStreams(item)).filter((item) => item !== undefined);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (RAW_STREAM_KEYS.has(key)) continue;
    if (isLargeNumericArray(value)) continue;

    const cleaned = stripRawOneHzStreams(value);
    if (cleaned !== undefined) {
      out[key] = cleaned;
    }
  }
  return out;
}

function extractSessionSummary(session, index) {
  const s = session || {};
  const cleaned = stripRawOneHzStreams(s) || {};

  // Conserve explicitement les sections analytiques retournées par analyzeActivity()
  const structured = {
    index: index + 1,
    id: cleaned.id ?? cleaned.meta?.id ?? `session-${index + 1}`,
    name: cleaned.name ?? cleaned.meta?.name ?? `Séance ${index + 1}`,
    date: cleaned.date ?? cleaned.meta?.start_date_local ?? "",
    sport: cleaned.sport ?? cleaned.meta?.type ?? "Cyclisme",
    global: cleaned.global ?? null,
    correlations: cleaned.correlations ?? null,
    partial_correlations: cleaned.correlations?.partial ?? null,
    thresholds: cleaned.thresholds ?? null,
    series_drift: cleaned.series ?? [],
    intervals: cleaned.intervals ?? null,
    transitions: (cleaned.intervals || []).filter((seg) => seg?.kind === "transition"),
    incidents: cleaned.incidents ?? null,
    cross_analysis: cleaned.cross_analysis ?? null
  };

  // Préserve tout autre champ calculé utile issu de physio_engine.js sans doublon massif
  for (const [key, val] of Object.entries(cleaned)) {
    if (!(key in structured) && key !== "meta") {
      structured[key] = val;
    }
  }
  if (cleaned.meta) {
    structured.meta = {
      id: cleaned.meta.id,
      name: cleaned.meta.name,
      type: cleaned.meta.type,
      start_date_local: cleaned.meta.start_date_local,
      moving_time: cleaned.meta.moving_time,
      elapsed_time: cleaned.meta.elapsed_time,
      distance: cleaned.meta.distance,
      total_elevation_gain: cleaned.meta.total_elevation_gain,
      icu_training_load: cleaned.meta.icu_training_load,
      icu_intensity: cleaned.meta.icu_intensity
    };
  }

  return structured;
}

/**
 * Compacte les données mathématiques calculées de toutes les séances de la journée + wellness,
 * sans transmettre les séries brutes 1 Hz.
 */
export function buildInitialContextPayload(dailyBundle) {
  const bundle = dailyBundle || {};
  const rawSessions = Array.isArray(bundle.sessions)
    ? bundle.sessions
    : Array.isArray(bundle.activities)
    ? bundle.activities
    : [];

  return {
    date: bundle.date || "",
    wellness: stripRawOneHzStreams(bundle.wellness ?? null),
    day_summary: stripRawOneHzStreams(bundle.day_summary ?? bundle.consolidated ?? null),
    sessions: rawSessions.map((sess, idx) => extractSessionSummary(sess, idx))
  };
}

async function callGeminiGenerateContent({ geminiApiKey, model, systemText, contents, generationConfig, maxRetries = 2 }) {
  const cleanKey = String(geminiApiKey ?? "").trim();
  if (!cleanKey) {
    throw new Error("Clé API Gemini manquante.");
  }

  const cleanModel = String(model || "gemini-3.5-flash").trim() || "gemini-3.5-flash";
  const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(cleanKey)}`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemText }]
    },
    contents,
    generationConfig
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("")
        .trim();

      if (!text) {
        throw new Error("Réponse Gemini vide ou bloquée par les filtres de sécurité.");
      }
      return text;
    }

    const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (isRetryable && attempt < maxRetries) {
      const delayMs = 1000 * (2 ** attempt) + Math.floor(Math.random() * 400);
      await sleep(delayMs);
      continue;
    }

    let detail = "";
    try {
      const errJson = await response.json();
      detail = errJson?.error?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`Gemini API HTTP ${response.status}${detail ? ` : ${detail}` : ""}`);
  }

  throw new Error("Échec de l'appel Gemini API.");
}

function parseStrictSynthesisJson(rawText) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  const parsed = JSON.parse(text);
  return {
    verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
    daily_synthesis: typeof parsed.daily_synthesis === "string" ? parsed.daily_synthesis : "",
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    breaking_points: Array.isArray(parsed.breaking_points) ? parsed.breaking_points.map(String) : [],
    priority_axes: Array.isArray(parsed.priority_axes)
      ? parsed.priority_axes.map((ax) => ({
          title: typeof ax?.title === "string" ? ax.title : "",
          metric_basis: typeof ax?.metric_basis === "string" ? ax.metric_basis : "",
          action: typeof ax?.action === "string" ? ax.action : ""
        }))
      : [],
    technical_notes: typeof parsed.technical_notes === "string" ? parsed.technical_notes : ""
  };
}

/**
 * Génère la synthèse initiale structurée en JSON strict et initialise l'historique multi-tours.
 */
export async function fetchAvailableGeminiModels(geminiApiKey) {
  const cleanKey = String(geminiApiKey ?? "").trim();
  if (!cleanKey) {
    throw new Error("Clé API Gemini requante pour lister les modèles.");
  }
  const url = `${GEMINI_BASE_URL}?key=${encodeURIComponent(cleanKey)}&pageSize=100`;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Erreur Gemini Models (${response.status}): ${errText.slice(0, 180)}`);
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
      id: String(m.name).replace(/^models\//, ""),
      displayName: String(m.displayName || m.name.replace(/^models\//, ""))
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export async function generateInitialSynthesis({ dailyBundle, geminiApiKey, model = "gemini-3.5-flash" }) {
  const contextPayload = buildInitialContextPayload(dailyBundle);

  const userPrompt = [
    "Analyse les données biométriques et de télémétrie 1 Hz compactées ci-dessous pour la journée complète.",
    "Retourne EXCLUSIVEMENT un objet JSON valide respectant exactement ce schéma :",
    "{",
    '  "verdict": "string (verdict direct dès la première phrase)",',
    '  "daily_synthesis": "string (analyse physiologique croisée journée + wellness + dérives)",',
    '  "strengths": ["string"],',
    '  "breaking_points": ["string"],',
    '  "priority_axes": [{ "title": "string", "metric_basis": "string", "action": "string" }],',
    '  "technical_notes": "string (qualité ECG/artefacts DFA, capteur CORE, remarques nutrition sans viande)"',
    "}",
    "",
    "DONNÉES DU JOUR :",
    JSON.stringify(contextPayload)
  ].join("\n");

  const userTurn = {
    role: "user",
    parts: [{ text: userPrompt }]
  };

  const rawAnswer = await callGeminiGenerateContent({
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
  const modelTurn = {
    role: "model",
    parts: [{ text: JSON.stringify(synthesis) }]
  };

  return {
    synthesis,
    conversationHistory: [userTurn, modelTurn]
  };
}

/**
 * Envoie une question de suivi en conservant tout l'historique multi-tours.
 */
export async function sendChatMessage({
  conversationHistory = [],
  question,
  geminiApiKey,
  model = "gemini-3.5-flash"
}) {
  const cleanQuestion = String(question ?? "").trim();
  if (!cleanQuestion) {
    throw new Error("Question vide.");
  }

  const userTurn = {
    role: "user",
    parts: [{ text: cleanQuestion }]
  };

  const nextHistory = [...conversationHistory, userTurn];

  const answer = await callGeminiGenerateContent({
    geminiApiKey,
    model,
    systemText: `${SYSTEM_PROMPT}\n\nMode suivi interactif : réponds en Markdown concis, factuel et chiffré (sans bloc JSON brut).`,
    contents: nextHistory,
    generationConfig: {
      temperature: 0.25
    }
  });

  const modelTurn = {
    role: "model",
    parts: [{ text: answer }]
  };

  return {
    answer,
    conversationHistory: [...nextHistory, modelTurn]
  };
}
