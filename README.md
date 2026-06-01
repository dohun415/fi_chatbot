# 하나 금융 상담 챗봇

`topic/question/answer` 데이터셋과 RunYourAI 모델을 함께 사용하는 금융 상담 챗봇입니다. 답변 하단에 신뢰도와 topic을 표시하고, 낮은 신뢰도 답변에만 상담사 연결 버튼을 제공합니다.

## 실행

```bash
cp .env.example .env
npm run dev
```

브라우저에서 `http://localhost:3000`을 열면 됩니다.

## 처리 흐름

1. 사용자 질문을 문자 n-gram 벡터로 변환합니다.
2. 전체 질답 데이터셋과 cosine similarity를 계산합니다.
3. 최고 유사도가 `DIRECT_ANSWER_THRESHOLD` 이상이면 기존 답변을 바로 반환합니다.
4. 부분집합 또는 근접 질문이면 `focused RAG`로 base 답변에서 필요한 범위만 추려 생성합니다.
5. 특정 base로 좁히기 어렵다면 `expanded RAG`로 더 많은 근거를 넣어 생성합니다.
6. 엔트로피 기반 불확실성과 신뢰도를 계산합니다.
7. 낮은 신뢰도지만 답변이 생성된 경우에만 상담사 연결 버튼을 표시합니다.

## RunYourAI 연결

`.env` 또는 실행 환경에 아래 값을 넣어 주세요.

```bash
RUNYOURAI_API_KEY=발급받은_API_키
RUNYOURAI_BASE_URL=https://api.runyour.ai/v1
RUNYOURAI_MODEL=openai/gpt-5.5-2026-04-23
```

현재 서버는 `POST {RUNYOURAI_BASE_URL}/chat/completions`로 호출합니다. RunYourAI의 경로가 다르면 `server.mjs`의 `generateWithRunYourAI` 함수에서 URL만 맞추면 됩니다.

## Discord 상담 연결 준비

1. Discord 서버에서 상담 요청을 받을 채널을 만듭니다.
2. 채널 설정에서 `연동` 또는 `Integrations`로 이동합니다.
3. `웹후크 만들기`를 선택하고 이름과 대상 채널을 지정합니다.
4. Webhook URL을 복사합니다.
5. `.env`에 `DISCORD_WEBHOOK_URL=복사한_URL`을 넣고 서버를 재시작합니다.

Webhook 방식은 가장 빠른 검증용 연결입니다. 실제 서비스에서는 상담사가 상태를 변경하거나 답변을 남기는 양방향 처리가 필요하므로 Discord Bot 토큰, 상담 티켓 채널 생성, DB 저장까지 확장하는 편이 좋습니다.

## Vercel 배포

이 저장소는 Vercel 서버리스 함수용 `api/` 엔드포인트와 `vercel.json`을 포함합니다.

1. GitHub 저장소에 프로젝트를 push합니다.
2. Vercel에서 `New Project`를 선택하고 해당 저장소를 import합니다.
3. Environment Variables에 아래 값을 등록합니다.

```bash
RUNYOURAI_API_KEY=발급받은_API_키
RUNYOURAI_BASE_URL=https://api.runyour.ai/v1
RUNYOURAI_MODEL=openai/gpt-5.5-2026-04-23
DISCORD_WEBHOOK_URL=Discord_Webhook_URL
DIRECT_ANSWER_THRESHOLD=0.92
FOCUSED_RAG_THRESHOLD=0.45
RAG_MIN_THRESHOLD=0.18
AI_CONFIDENCE_THRESHOLD=0.68
RAG_UNCERTAINTY_THRESHOLD=0.55
RAG_CONTEXT_LIMIT=12
```

4. Build command는 비워두거나 기본값을 사용합니다.
5. Deploy 후 발급된 Vercel URL로 접속합니다.

로컬 실행은 `node server.mjs`, Vercel 배포는 `api/chat.js`, `api/config.js`, `api/handoff.js` 서버리스 함수가 처리합니다.
