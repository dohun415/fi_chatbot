import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const DATASET_PATH = path.join(__dirname, "extracted_financial_qa.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const DIRECT_ANSWER_THRESHOLD = Number(process.env.DIRECT_ANSWER_THRESHOLD || 0.92);
const FOCUSED_RAG_THRESHOLD = Number(process.env.FOCUSED_RAG_THRESHOLD || 0.45);
const RAG_MIN_THRESHOLD = Number(process.env.RAG_MIN_THRESHOLD || 0.18);
const AI_CONFIDENCE_THRESHOLD = Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.68);
const RAG_UNCERTAINTY_THRESHOLD = Number(process.env.RAG_UNCERTAINTY_THRESHOLD || 0.55);
const RAG_CONTEXT_LIMIT = Number(process.env.RAG_CONTEXT_LIMIT || 12);

const RUNYOURAI_API_KEY = process.env.RUNYOURAI_API_KEY || "";
const RUNYOURAI_BASE_URL = (process.env.RUNYOURAI_BASE_URL || "").replace(/\/$/, "");
const RUNYOURAI_MODEL = process.env.RUNYOURAI_MODEL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const dataset = JSON.parse(await readFile(DATASET_PATH, "utf8"));
const indexedDataset = dataset.map((item) => ({
  ...item,
  searchText: [item.topic, item.category, item.question, item.answer].filter(Boolean).join(" "),
  vector: vectorize([item.topic, item.question, item.question, item.answer].filter(Boolean).join(" ")),
}));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export const server = http.createServer(handleRequest);

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, getConfig());
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      const result = await answerQuestion(String(body.question || "").trim());
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/handoff") {
      const body = await readJson(req);
      const result = await sendDiscordHandoff(body);
      return sendJson(res, result);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || "Unexpected server error" }, 500);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`Financial RAG chatbot running at http://localhost:${PORT}`);
  });
}

export function getConfig() {
  return {
    datasetCount: dataset.length,
    topics: [...new Set(dataset.map((item) => item.topic))].sort(),
    thresholds: {
      directAnswer: DIRECT_ANSWER_THRESHOLD,
      focusedRag: FOCUSED_RAG_THRESHOLD,
      ragMinimum: RAG_MIN_THRESHOLD,
      aiConfidence: AI_CONFIDENCE_THRESHOLD,
      ragUncertainty: RAG_UNCERTAINTY_THRESHOLD,
      ragContextLimit: RAG_CONTEXT_LIMIT,
    },
    integrations: {
      runyouraiConfigured: Boolean(RUNYOURAI_API_KEY && RUNYOURAI_BASE_URL && RUNYOURAI_MODEL),
      discordConfigured: Boolean(DISCORD_WEBHOOK_URL),
    },
  };
}

export async function answerQuestion(question) {
  if (!question) {
    return {
      answer: "질문을 입력해 주세요.",
      route: "empty",
      confidence: 0,
      topic: "",
      canRequestCounselor: false,
      needsHuman: false,
      trace: [{ label: "입력 확인", detail: "빈 질문이라 검색과 생성을 건너뜁니다." }],
      matches: [],
    };
  }

  const queryVector = vectorize(question);
  const matches = indexedDataset
    .map((item) => ({
      id: item.id,
      topic: item.topic,
      category: item.category,
      sourceInstitution: item.source_institution,
      question: item.question,
      answer: item.answer,
      score: cosineSimilarity(queryVector, item.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RAG_CONTEXT_LIMIT);

  const top = matches[0];
  const trace = [
    { label: "사용자 질문 수신", detail: question },
    {
      label: "임베딩 유사도 검색",
      detail: `문자 n-gram 벡터로 ${dataset.length.toLocaleString("ko-KR")}개 질답과 비교하고 상위 ${matches.length}개 근거를 선택했습니다. 최고 유사도는 ${formatScore(top?.score)}입니다.`,
    },
  ];

  if (!top) {
    trace.push({
      label: "RAG 근거 부족",
      detail: "검색 후보가 없어 AI 답변을 생성하지 않고 상담사 연결로 전환합니다.",
    });
    return {
      answer: "질문과 충분히 가까운 기존 상담 데이터가 없어 실제 상담사 연결이 필요합니다.",
      route: "handoff",
      confidence: round(top?.score || 0),
      topic: "",
      canRequestCounselor: false,
      needsHuman: true,
      trace,
      matches,
    };
  }

  if (top.score >= DIRECT_ANSWER_THRESHOLD) {
    trace.push({
      label: "직접 답변 선택",
      detail: `최고 유사도 ${formatScore(top.score)}가 직접 답변 기준 ${DIRECT_ANSWER_THRESHOLD} 이상이라 기존 질답 답변을 그대로 반환합니다.`,
    });
    trace.push({
      label: "신뢰도 측정",
      detail: `거의 동일한 질문으로 판단되어 매칭 유사도 ${formatScore(top.score)}를 최종 신뢰도로 사용합니다.`,
    });
    return {
      answer: top.answer,
      route: "direct",
      confidence: round(top.score),
      topic: top.topic,
      entropy: 0,
      uncertainty: round(1 - top.score),
      metrics: {
        baseScore: round(top.score),
        evidenceSupport: round(top.score),
        topicCoherence: 1,
        modelConfidence: null,
      },
      needsHuman: false,
      canRequestCounselor: false,
      trace,
      matches,
      modelRaw: null,
    };
  }

  const isFocused = shouldUseFocusedRag(question, top);
  const selectedMatches = isFocused ? matches.slice(0, Math.min(5, matches.length)) : matches;

  trace.push({
    label: "base 질답 선택",
    detail: isFocused
      ? `최고 유사도 ${formatScore(top.score)}인 질답을 base로 선택했습니다. 사용자 질문이 base 질문의 부분집합 또는 근접 질문으로 보여 base 답변에서 필요한 범위만 추려 생성합니다.`
      : `최고 유사도 ${formatScore(top.score)}인 질답을 약한 base evidence로 선택하고, 확장 근거와 함께 답변을 생성합니다.`,
  });

  trace.push({
    label: isFocused ? "focused RAG 선택" : "expanded RAG 선택",
    detail: isFocused
      ? `질문이 base 질답과 충분히 가깝거나 부분집합으로 보여 base 답변에서 관련 내용만 추출하는 경로를 사용합니다.`
      : `질문이 특정 base 답변 하나로 좁혀지지 않아 더 넓은 확장 근거를 함께 사용하는 경로를 사용합니다.`,
  });

  if (top.score < RAG_MIN_THRESHOLD) {
    trace.push({
      label: "RAG 근거 약함",
      detail: `최고 유사도가 ${RAG_MIN_THRESHOLD} 미만이지만, 검증 정책에 따라 상위 후보를 근거로 LLM RAG 생성을 계속 진행합니다.`,
    });
  }

  let aiResult;
  try {
    aiResult = await generateWithRunYourAI(question, selectedMatches, {
      mode: isFocused ? "focused" : "expanded",
    });
  } catch (error) {
    trace.push({
      label: "LLM RAG 답변 생성 실패",
      detail: normalizeRunYourAIError(error),
    });
    trace.push({
      label: "실제 상담사 연결",
      detail: "모델 호출이 실패했기 때문에 AI 답변 대신 상담사 연결로 전환합니다.",
    });
    return {
      answer: "AI 모델 호출에 실패했습니다. 잠시 후 다시 시도하시거나 실제 상담사 연결을 이용해 주세요.",
      route: "model_error",
      confidence: round(Math.min(top?.score || 0, 0.3)),
      topic: top?.topic || "",
      canRequestCounselor: false,
      needsHuman: true,
      trace,
      matches,
    };
  }
  trace.push({
    label: "LLM RAG 답변 생성",
    detail: aiResult.usedModel
      ? `${RUNYOURAI_MODEL} 모델에 ${isFocused ? "focused RAG" : "expanded RAG"} 모드로 base 질답 1개와 근거 ${Math.max(selectedMatches.length - 1, 0)}개를 전달했습니다.`
      : "RunYourAI 설정이 없어 로컬 검증용 답변을 생성했습니다.",
  });
  trace.push({
    label: "엔트로피 측정",
    detail: `확장 근거 분포 엔트로피는 ${formatScore(aiResult.entropy)}, 불확실성은 ${formatScore(aiResult.uncertainty)}입니다. 불확실성이 높을수록 근거가 한 답변으로 모이지 않았다는 뜻입니다.`,
  });
  trace.push({
    label: "신뢰도 측정",
    detail: `base 유사도 ${formatScore(aiResult.metrics.baseScore)}, 확장 근거 평균 ${formatScore(aiResult.metrics.evidenceSupport)}, topic 일관성 ${formatScore(aiResult.metrics.topicCoherence)}, 모델 자체 평가 ${formatScore(aiResult.metrics.modelConfidence)}, 엔트로피 불확실성 ${formatScore(aiResult.uncertainty)}를 합산한 최종 신뢰도는 ${formatScore(aiResult.confidence)}입니다.`,
  });

  const needsHuman = aiResult.confidence < AI_CONFIDENCE_THRESHOLD || aiResult.uncertainty > RAG_UNCERTAINTY_THRESHOLD;
  if (needsHuman) {
    trace.push({
      label: "실제 상담사 연결",
      detail: `신뢰도 기준 ${AI_CONFIDENCE_THRESHOLD} 미만이거나 불확실성 기준 ${RAG_UNCERTAINTY_THRESHOLD} 초과라 Discord 상담 연결 대상으로 표시합니다.`,
    });
  } else {
    trace.push({
      label: "AI 답변 제공",
      detail: `신뢰도와 엔트로피 기준을 모두 통과해 AI 답변을 제공합니다.`,
    });
  }

  return {
    answer: aiResult.answer,
    route: needsHuman ? "ai_low_confidence" : (isFocused ? "focused_rag" : "rag"),
    confidence: round(aiResult.confidence),
    topic: top.topic,
    entropy: round(aiResult.entropy),
    uncertainty: round(aiResult.uncertainty),
    metrics: aiResult.metrics,
    needsHuman,
    canRequestCounselor: needsHuman && Boolean(aiResult.answer) && aiResult.usedModel,
    trace,
    matches: selectedMatches,
    modelRaw: aiResult.raw,
  };
}

async function generateWithRunYourAI(question, matches, options = {}) {
  const mode = options.mode || "expanded";
  const retrievalMetrics = measureRetrievalQuality(matches);
  if (!(RUNYOURAI_API_KEY && RUNYOURAI_BASE_URL && RUNYOURAI_MODEL)) {
    const confidence = calculateFinalConfidence({
      ...retrievalMetrics,
      modelConfidence: 0.45,
    });
    return {
      usedModel: false,
      answer: buildLocalRagAnswer(matches),
      confidence,
      entropy: retrievalMetrics.entropy,
      uncertainty: retrievalMetrics.uncertainty,
      metrics: {
        ...formatMetrics(retrievalMetrics),
        modelConfidence: 0.45,
      },
      raw: null,
    };
  }

  const base = matches[0];
  const supporting = matches.slice(1);
  const context = matches
    .map((item, index) => [
      index === 0 ? "[BASE 질답]" : `[확장 근거 ${index}]`,
      `topic: ${item.topic}`,
      `question: ${item.question}`,
      `answer: ${item.answer}`,
      `similarity: ${round(item.score)}`,
    ].join("\n"))
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content: [
        "당신은 금융 상담 챗봇입니다.",
        mode === "focused"
          ? "사용자 질문이 [BASE 질답]보다 좁은 범위일 수 있습니다. 이 경우 BASE 답변 전체를 늘어놓지 말고 사용자 질문에 필요한 부분집합만 추려 간결하게 답하세요."
          : "가장 유사한 [BASE 질답]을 핵심 근거로 삼되, 사용자 질문이 완전히 동일하지 않을 수 있으므로 기존 답변을 그대로 복사하지 말고 질문 의도에 맞게 재구성하세요.",
        "확장 근거들은 BASE 질답을 보완하는 용도로만 사용하세요.",
        "제공된 근거 밖의 정책, 수수료, 날짜, 한도, 절차를 새로 만들지 마세요.",
        "근거가 부족하면 답변에 한계를 밝히고 상담사 연결을 권하세요.",
        "JSON만 반환하세요: {\"answer\":\"...\", \"confidence\":0.0, \"reason\":\"...\"}",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `사용자 질문:\n${question}`,
        "",
        `선택된 BASE 질답:\nquestion: ${base.question}\nanswer: ${base.answer}\nsimilarity: ${round(base.score)}`,
        "",
        `확장 근거 수: ${supporting.length}`,
        "",
        `전체 근거:\n${context}`,
      ].join("\n"),
    },
  ];

  const response = await fetch(`${RUNYOURAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RUNYOURAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: RUNYOURAI_MODEL,
      messages,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RunYourAI API 요청 실패: ${response.status} ${text}`);
  }

  const raw = await response.json();
  const content = raw.choices?.[0]?.message?.content || "{}";
  const parsed = safeJsonParse(content);
  const modelConfidence = clamp(Number(parsed.confidence ?? 0.5), 0, 1);
  const confidence = calculateFinalConfidence({
    ...retrievalMetrics,
    modelConfidence,
  });

  return {
    usedModel: true,
    answer: parsed.answer || "답변을 생성하지 못했습니다. 상담사 연결을 권장합니다.",
    confidence,
    entropy: retrievalMetrics.entropy,
    uncertainty: retrievalMetrics.uncertainty,
    metrics: {
      ...formatMetrics(retrievalMetrics),
      modelConfidence: round(modelConfidence),
    },
    raw: parsed,
  };
}

function measureRetrievalQuality(matches) {
  const scores = matches.map((match) => Math.max(match.score, 0));
  if (scores.length <= 1) {
    const baseScore = scores[0] || 0;
    return {
      baseScore,
      evidenceSupport: baseScore,
      topicCoherence: 1,
      entropy: 0,
      uncertainty: 1 - baseScore,
    };
  }

  const total = scores.reduce((sum, score) => sum + score, 0);
  if (!total) {
    return {
      baseScore: 0,
      evidenceSupport: 0,
      topicCoherence: 0,
      entropy: 1,
      uncertainty: 1,
    };
  }

  const probabilities = scores.map((score) => score / total);
  const entropy = probabilities.reduce((sum, probability) => {
    if (!probability) return sum;
    return sum - probability * Math.log(probability);
  }, 0) / Math.log(probabilities.length);

  const topScore = scores[0] || 0;
  const evidenceSupport = scores.reduce((sum, score, index) => {
    const weight = 1 / (index + 1);
    return sum + score * weight;
  }, 0) / scores.reduce((sum, _, index) => sum + 1 / (index + 1), 0);
  const baseTopic = matches[0]?.topic;
  const topicCoherence = baseTopic
    ? matches.filter((match) => match.topic === baseTopic).length / matches.length
    : 0;
  const uncertainty = clamp(entropy * (1 - topScore), 0, 1);
  return { baseScore: topScore, evidenceSupport, topicCoherence, entropy, uncertainty };
}

function calculateFinalConfidence(metrics) {
  return clamp(
    metrics.baseScore * 0.28 +
      metrics.evidenceSupport * 0.22 +
      metrics.topicCoherence * 0.15 +
      metrics.modelConfidence * 0.25 +
      (1 - metrics.uncertainty) * 0.1,
    0,
    1,
  );
}

function formatMetrics(metrics) {
  return {
    baseScore: round(metrics.baseScore),
    evidenceSupport: round(metrics.evidenceSupport),
    topicCoherence: round(metrics.topicCoherence),
  };
}

function shouldUseFocusedRag(question, topMatch) {
  if (!topMatch) return false;
  if (topMatch.score >= FOCUSED_RAG_THRESHOLD) return true;

  const queryTerms = meaningfulTerms(question);
  const baseTerms = new Set(meaningfulTerms(topMatch.question));
  const termCoverage = queryTerms.length && baseTerms.size
    ? queryTerms.filter((term) => baseTerms.has(term)).length / queryTerms.length
    : 0;
  const ngramCoverage = charNgramCoverage(question, topMatch.question, 2);

  return (
    topMatch.score >= RAG_MIN_THRESHOLD &&
    (termCoverage >= 0.72 || ngramCoverage >= 0.5)
  );
}

function charNgramCoverage(source, target, size = 2) {
  const sourceCompact = normalizeText(source).replace(/\s+/g, "");
  const targetCompact = normalizeText(target).replace(/\s+/g, "");
  if (sourceCompact.length < size || targetCompact.length < size) return 0;

  const targetGrams = new Set();
  for (let i = 0; i <= targetCompact.length - size; i += 1) {
    targetGrams.add(targetCompact.slice(i, i + size));
  }

  let total = 0;
  let covered = 0;
  for (let i = 0; i <= sourceCompact.length - size; i += 1) {
    total += 1;
    if (targetGrams.has(sourceCompact.slice(i, i + size))) covered += 1;
  }
  return total ? covered / total : 0;
}

function meaningfulTerms(text) {
  const stopwords = new Set([
    "제가",
    "저는",
    "나는",
    "하면",
    "하려면",
    "그리고",
    "또한",
    "어떻게",
    "어떤",
    "궁금합니다",
    "알려주세요",
    "주세요",
    "문의",
    "관련",
  ]);
  return normalizeText(text)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopwords.has(term));
}

function buildLocalRagAnswer(matches) {
  const top = matches[0];
  if (!top) return "참고할 기존 질답이 없어 상담사 연결이 필요합니다.";
  return [
    "RunYourAI API 설정 전 검증용 답변입니다.",
    `가장 가까운 기존 질문은 "${top.question}"이며, 해당 답변은 다음과 같습니다.`,
    top.answer,
  ].join("\n\n");
}

export async function sendDiscordHandoff(body) {
  if (!DISCORD_WEBHOOK_URL) {
    return {
      ok: false,
      configured: false,
      message: "DISCORD_WEBHOOK_URL이 설정되지 않았습니다.",
    };
  }

  const fields = [
    `질문: ${body.question || ""}`,
    `라우트: ${body.route || ""}`,
    `신뢰도: ${body.confidence ?? ""}`,
    `답변 초안: ${body.answer || ""}`,
  ];

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Financial Chatbot Handoff",
      content: "상담사 연결이 필요한 문의가 도착했습니다.",
      embeds: [
        {
          title: "상담 요청",
          description: fields.join("\n\n").slice(0, 3900),
          color: 16753920,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });

  return {
    ok: response.ok,
    configured: true,
    message: response.ok ? "Discord로 상담 요청을 전송했습니다." : `Discord 전송 실패: ${response.status}`,
  };
}

function vectorize(text) {
  const normalized = normalizeText(text);
  const terms = [];
  const compact = normalized.replace(/\s+/g, "");

  for (const token of normalized.split(/\s+/).filter(Boolean)) terms.push(token);
  for (let size = 2; size <= 3; size += 1) {
    for (let i = 0; i <= compact.length - size; i += 1) terms.push(compact.slice(i, i + size));
  }

  const vector = new Map();
  for (const term of terms) vector.set(term, (vector.get(term) || 0) + 1);
  return vector;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [term, value] of a.entries()) dot += value * (b.get(term) || 0);

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(requestPath, res) {
  const pathname = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  res.end(body);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function formatScore(score = 0) {
  return `${Math.round(score * 100)}%`;
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRunYourAIError(error) {
  const cause = error?.cause;
  if (cause?.code === "ENOTFOUND") {
    return `Base URL 도메인을 찾을 수 없습니다: ${cause.hostname}. RUNYOURAI_BASE_URL 값을 확인해 주세요.`;
  }
  if (cause?.code === "ECONNREFUSED") {
    return "RunYourAI 서버 연결이 거부되었습니다. Base URL과 네트워크 상태를 확인해 주세요.";
  }
  if (cause?.code === "ETIMEDOUT") {
    return "RunYourAI 요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  return error?.message || "알 수 없는 모델 호출 오류입니다.";
}

async function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const body = await readFile(filePath, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
