import * as z from "zod";

export const productScanEnvSchema = z.object({
  VLM_WORKER_URL: z.url().default("http://localhost:8000"),
  VLM_WORKER_SECRET: z.string().min(16),
  VLM_WORKER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().default("jev-latest"),
  NAFDAC_REGISTRY_URL: z.url().optional(),
  NAFDAC_REGISTRY_API_KEY: z.string().optional(),
});
