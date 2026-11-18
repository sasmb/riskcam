# RiskCam packaging worker

FastAPI service for barcode decoding, image sharpness checks, structured package text extraction, and optional comparison against a curated reference package.

## Local development

Install the system `zbar` library and Python dependencies, then set the provider key and shared worker secret in your shell or a private environment file:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export VLM_WORKER_SECRET="$(openssl rand -hex 32)"
export VLM_PROVIDER=openai
export OPENAI_API_KEY="replace-with-your-key"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

`GET /healthz` is an unauthenticated health check. `POST /analyze-packaging` requires the matching `X-Worker-Secret` header. It accepts short-lived HTTPS image URLs; by default the service only downloads public AWS S3 hosts. Do not make the worker reachable without setting the secret. The API key and secret belong in environment configuration and must not be committed.

Set the same `VLM_WORKER_SECRET` in the Wasp server and set `VLM_WORKER_URL=http://localhost:8000`. For Gemini, use `VLM_PROVIDER=gemini` and set `GEMINI_API_KEY` and `GEMINI_MODEL` in the worker environment.

## Fly.io deployment commands

Run the worker commands from the repository root after setting `OPENAI_API_KEY` and signing in to Fly.io. To use Gemini, replace the provider and key values with `VLM_PROVIDER=gemini GEMINI_API_KEY="$GEMINI_API_KEY" GEMINI_MODEL="$GEMINI_MODEL"`.

```sh
export VLM_WORKER_SECRET="$(openssl rand -hex 32)"
fly apps create riskcam-vlm
fly secrets set VLM_WORKER_SECRET="$VLM_WORKER_SECRET" VLM_PROVIDER=openai OPENAI_API_KEY="$OPENAI_API_KEY" OPENAI_VLM_MODEL=gpt-4o --app riskcam-vlm
fly deploy template/vlm-worker --config template/vlm-worker/fly.toml --app riskcam-vlm
```

After the worker is deployed, make the required Open SaaS server variables available in your shell from a private secret store. `.env.server` is for local development; the Wasp Fly deployment needs these values passed as server secrets. Set the three React variables from a private client configuration as well, then run the app command from `template/app/`:

```sh
cd template/app
REACT_APP_GOOGLE_ANALYTICS_ID="$REACT_APP_GOOGLE_ANALYTICS_ID" \
REACT_APP_PADDLE_CLIENT_TOKEN="$REACT_APP_PADDLE_CLIENT_TOKEN" \
REACT_APP_PADDLE_SANDBOX_MODE="$REACT_APP_PADDLE_SANDBOX_MODE" \
wasp deploy fly launch riskcam iad \
  --server-secret VLM_WORKER_URL=https://riskcam-vlm.fly.dev \
  --server-secret VLM_WORKER_SECRET="$VLM_WORKER_SECRET" \
  --server-secret VLM_WORKER_TIMEOUT_MS=120000 \
  --server-secret TYPESAFE_API_KEY="$TYPESAFE_API_KEY" \
  --server-secret TYPESAFE_MODEL=jev-latest \
  --server-secret OPENAI_API_KEY="$OPENAI_API_KEY" \
  --server-secret STRIPE_API_KEY="$STRIPE_API_KEY" \
  --server-secret STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  --server-secret LEMONSQUEEZY_API_KEY="$LEMONSQUEEZY_API_KEY" \
  --server-secret LEMONSQUEEZY_STORE_ID="$LEMONSQUEEZY_STORE_ID" \
  --server-secret LEMONSQUEEZY_WEBHOOK_SECRET="$LEMONSQUEEZY_WEBHOOK_SECRET" \
  --server-secret POLAR_ORGANIZATION_ACCESS_TOKEN="$POLAR_ORGANIZATION_ACCESS_TOKEN" \
  --server-secret POLAR_WEBHOOK_SECRET="$POLAR_WEBHOOK_SECRET" \
  --server-secret POLAR_SANDBOX_MODE="$POLAR_SANDBOX_MODE" \
  --server-secret PADDLE_API_KEY="$PADDLE_API_KEY" \
  --server-secret PADDLE_WEBHOOK_SECRET="$PADDLE_WEBHOOK_SECRET" \
  --server-secret PADDLE_SANDBOX_MODE="$PADDLE_SANDBOX_MODE" \
  --server-secret PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID="$PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID" \
  --server-secret PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID="$PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID" \
  --server-secret PAYMENTS_CREDITS_10_PLAN_ID="$PAYMENTS_CREDITS_10_PLAN_ID" \
  --server-secret GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  --server-secret GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  --server-secret SENDGRID_API_KEY="$SENDGRID_API_KEY" \
  --server-secret PLAUSIBLE_API_KEY="$PLAUSIBLE_API_KEY" \
  --server-secret PLAUSIBLE_SITE_ID="$PLAUSIBLE_SITE_ID" \
  --server-secret PLAUSIBLE_BASE_URL="$PLAUSIBLE_BASE_URL" \
  --server-secret GOOGLE_ANALYTICS_CLIENT_EMAIL="$GOOGLE_ANALYTICS_CLIENT_EMAIL" \
  --server-secret GOOGLE_ANALYTICS_PRIVATE_KEY="$GOOGLE_ANALYTICS_PRIVATE_KEY" \
  --server-secret GOOGLE_ANALYTICS_PROPERTY_ID="$GOOGLE_ANALYTICS_PROPERTY_ID" \
  --server-secret AWS_S3_REGION="$AWS_S3_REGION" \
  --server-secret AWS_S3_IAM_ACCESS_KEY="$AWS_S3_IAM_ACCESS_KEY" \
  --server-secret AWS_S3_IAM_SECRET_KEY="$AWS_S3_IAM_SECRET_KEY" \
  --server-secret AWS_S3_FILES_BUCKET="$AWS_S3_FILES_BUCKET"
```

If a real NAFDAC adapter is configured, also pass `--server-secret NAFDAC_REGISTRY_URL="$NAFDAC_REGISTRY_URL"` and, when needed, `--server-secret NAFDAC_REGISTRY_API_KEY="$NAFDAC_REGISTRY_API_KEY"`.

If the app has already been launched, run the Wasp commands from `template/app/`: update server secrets with `wasp deploy fly cmd secrets set NAME=value --context=server`, then deploy with the React variables present in the shell:

```sh
wasp deploy fly cmd secrets set VLM_WORKER_URL=https://riskcam-vlm.fly.dev VLM_WORKER_SECRET="$VLM_WORKER_SECRET" TYPESAFE_API_KEY="$TYPESAFE_API_KEY" --context=server
REACT_APP_GOOGLE_ANALYTICS_ID="$REACT_APP_GOOGLE_ANALYTICS_ID" REACT_APP_PADDLE_CLIENT_TOKEN="$REACT_APP_PADDLE_CLIENT_TOKEN" REACT_APP_PADDLE_SANDBOX_MODE="$REACT_APP_PADDLE_SANDBOX_MODE" wasp deploy fly deploy
```

The worker service is public at the network layer so Fly Proxy can wake it from zero, but its analysis endpoint rejects requests without the private shared-secret header. Fly scale-to-zero is configured with autostop, autostart, and zero minimum running machines.

## Evidence limits

The worker extracts visible package text and flags image-level signals. It does not verify regulatory authenticity. Registry evidence is supplied separately by the Wasp server; the development mock record is clearly labeled as synthetic.
