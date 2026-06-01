#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_PROMPT = "hello"


def load_dotenv(path=".env"):
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def request_json(method, url, api_key, payload=None, timeout=30):
    body = None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            return response.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"raw": text}
        return error.code, payload


def list_models(base_url, api_key):
    status, payload = request_json("GET", f"{base_url}/models", api_key)
    if status != 200:
        raise RuntimeError(f"모델 목록 조회 실패: HTTP {status} {compact_json(payload)}")

    return [item["id"] for item in payload.get("data", []) if item.get("id")]


def check_model(base_url, api_key, model, prompt, timeout):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 20,
    }
    status, response = request_json(
        "POST",
        f"{base_url}/chat/completions",
        api_key,
        payload=payload,
        timeout=timeout,
    )

    if status == 200:
        message = response.get("choices", [{}])[0].get("message", {}).get("content", "")
        returned_model = response.get("model", "")
        return {
            "ok": True,
            "status": status,
            "returned_model": returned_model,
            "sample": message.replace("\n", " ")[:120],
        }

    error = response.get("error", response)
    if isinstance(error, dict):
        message = error.get("message") or compact_json(error)
    else:
        message = str(error)

    return {
        "ok": False,
        "status": status,
        "error": message[:300],
    }


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))[:800]


def main():
    parser = argparse.ArgumentParser(
        description="RunYourAI /v1/models 목록과 chat/completions 사용 가능 여부를 확인합니다."
    )
    parser.add_argument(
        "--check-all",
        action="store_true",
        help="조회된 모든 모델에 대해 짧은 chat/completions 테스트를 수행합니다.",
    )
    parser.add_argument(
        "--model",
        action="append",
        help="특정 모델만 테스트합니다. 여러 번 지정할 수 있습니다.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help=f"테스트 프롬프트입니다. 기본값: {DEFAULT_PROMPT!r}",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="각 HTTP 요청 제한 시간(초)입니다.",
    )
    args = parser.parse_args()

    load_dotenv()

    api_key = os.environ.get("RUNYOURAI_API_KEY", "").strip()
    base_url = os.environ.get("RUNYOURAI_BASE_URL", "").strip().rstrip("/")
    configured_model = os.environ.get("RUNYOURAI_MODEL", "").strip()

    if not api_key or not base_url:
        print("RUNYOURAI_API_KEY와 RUNYOURAI_BASE_URL을 .env에 설정해 주세요.", file=sys.stderr)
        return 1

    print(f"Base URL: {base_url}")
    print(f"Configured model: {configured_model or '(missing)'}")
    print()

    models = list_models(base_url, api_key)
    print(f"Available models ({len(models)}):")
    for model in models:
        marker = "  *" if model == configured_model else "   "
        print(f"{marker} {model}")

    targets = args.model or ([configured_model] if configured_model else [])
    if args.check_all:
        targets = models

    targets = [model for model in dict.fromkeys(targets) if model]
    if not targets:
        print("\n테스트할 모델이 없습니다. .env의 RUNYOURAI_MODEL을 설정하거나 --model을 지정하세요.")
        return 0

    print("\nChat completion check:")
    for model in targets:
        result = check_model(base_url, api_key, model, args.prompt, args.timeout)
        if result["ok"]:
            print(f"✅ {model} | HTTP {result['status']} | returned={result['returned_model']}")
            print(f"   sample: {result['sample']}")
        else:
            print(f"❌ {model} | HTTP {result['status']}")
            print(f"   error: {result['error']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
