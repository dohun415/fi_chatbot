const conversation = document.querySelector("#conversation");
const chatForm = document.querySelector("#chatForm");
const questionInput = document.querySelector("#questionInput");
const traceList = document.querySelector("#traceList");
const matchesEl = document.querySelector("#matches");
const routeBadge = document.querySelector("#routeBadge");
const confidenceBadge = document.querySelector("#confidenceBadge");
const configSummary = document.querySelector("#configSummary");
const integrationStatus = document.querySelector("#integrationStatus");
const flowToggle = document.querySelector("#flowToggle");
const debugPanel = document.querySelector("#debugPanel");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const drawerClose = document.querySelector("#drawerClose");

let lastResult = null;
let lastQuestion = "";

loadConfig();

flowToggle.addEventListener("click", () => setDrawerOpen(true));
drawerBackdrop.addEventListener("click", () => setDrawerOpen(false));
drawerClose.addEventListener("click", () => setDrawerOpen(false));

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  lastQuestion = question;
  appendMessage("user", "사용자", question);
  questionInput.value = "";
  setLoading(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "질문 처리에 실패했습니다.");

    lastResult = result;
    appendMessage("bot", "하나 상담봇", result.answer, false, result);
    renderTrace(result.trace || []);
    renderMatches(result.matches || []);
    renderDecision(result);
  } catch (error) {
    appendMessage("bot", "오류", error.message, true);
  } finally {
    setLoading(false);
  }
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  configSummary.textContent = `${config.datasetCount.toLocaleString("ko-KR")}개 질답, ${config.topics.length}개 topic을 사용합니다.`;
  integrationStatus.innerHTML = [
    pill(config.integrations.runyouraiConfigured ? "RunYourAI 연결됨" : "RunYourAI 미설정"),
    pill(config.integrations.discordConfigured ? "Discord 연결됨" : "Discord 미설정"),
  ].join("");
}

function appendMessage(type, author, text, isError = false, result = null) {
  const message = document.createElement("div");
  message.className = `message ${type}${isError ? " error" : ""}`;
  message.innerHTML = `<strong>${escapeHtml(author)}</strong><p>${escapeHtml(text)}</p>`;

  if (result && type === "bot") {
    const meta = document.createElement("div");
    meta.className = "answer-meta";
    meta.innerHTML = [
      `<span>신뢰도 ${Math.round((result.confidence || 0) * 100)}%</span>`,
      `<span>Topic ${escapeHtml(result.topic || "미분류")}</span>`,
    ].join("");
    message.appendChild(meta);

    if (result.canRequestCounselor) {
      const counsel = document.createElement("div");
      counsel.className = "counsel-box";
      counsel.innerHTML = `
        <p>AI가 답변을 제공했지만 신뢰도가 낮습니다. 상담사에게 이어서 확인할 수 있습니다.</p>
        <button type="button">상담사 연결</button>
        <small></small>
      `;
      const button = counsel.querySelector("button");
      const status = counsel.querySelector("small");
      button.addEventListener("click", () => requestCounselor(button, status));
      message.appendChild(counsel);
    }
  }

  conversation.appendChild(message);
  conversation.scrollTop = conversation.scrollHeight;
}

function renderTrace(trace) {
  traceList.innerHTML = trace
    .map((step) => `<li><strong>${escapeHtml(step.label)}</strong><p>${escapeHtml(step.detail)}</p></li>`)
    .join("");
}

function renderMatches(matches) {
  matchesEl.innerHTML = matches
    .map(
      (match) => `
        <article class="match">
          <div class="match-meta">
            <span>${Math.round(match.score * 100)}%</span>
            <span>${escapeHtml(match.topic)}</span>
            <span>${escapeHtml(match.category)}</span>
          </div>
          <strong>${escapeHtml(match.question)}</strong>
          <p>${escapeHtml(match.answer)}</p>
        </article>
      `,
    )
    .join("");
}

function renderDecision(result) {
  const labelByRoute = {
    direct: "기존 답변",
    focused_rag: "부분 답변",
    rag: "AI 답변",
    ai_low_confidence: "상담 권장",
    handoff: "상담 연결",
    model_error: "모델 오류",
    empty: "대기",
  };
  routeBadge.textContent = labelByRoute[result.route] || result.route;
  confidenceBadge.textContent = `${Math.round((result.confidence || 0) * 100)}%`;
}

async function requestCounselor(button, status) {
  if (!lastResult) return;
  button.disabled = true;
  status.textContent = "상담 요청을 전송하는 중입니다.";

  try {
    const response = await fetch("/api/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: lastQuestion,
        answer: lastResult.answer,
        route: lastResult.route,
        confidence: lastResult.confidence,
        topic: lastResult.topic,
      }),
    });
    const result = await response.json();
    status.textContent = result.message;
    if (!result.ok) button.disabled = false;
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

function setDrawerOpen(isOpen) {
  debugPanel.classList.toggle("open", isOpen);
  drawerBackdrop.classList.toggle("open", isOpen);
  debugPanel.setAttribute("aria-hidden", String(!isOpen));
}

function setLoading(isLoading) {
  chatForm.querySelector("button").disabled = isLoading;
  chatForm.querySelector("button").textContent = isLoading ? "처리 중" : "질문 보내기";
}

function pill(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
