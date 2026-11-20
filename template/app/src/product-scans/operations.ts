import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ContentValue } from "@typesafe-ai/sdk";
import type { GenuineProductRef, ProductScan } from "wasp/entities";
import { HttpError, env } from "wasp/server";
import type {
  CreateProductScan,
  GetGenuineProductRefs,
  GetProductScanById,
  GetProductScanHistory,
} from "wasp/server/operations";
import type { AnalyzeProductJob } from "wasp/server/jobs";
import { analyzeProductJob as analyzeProductJobClient } from "wasp/server/jobs";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import {
  getTemporaryDownloadFileSignedURLFromS3,
  getS3ObjectMetadataFromS3,
} from "../file-upload/s3Utils";

const MAX_SCAN_IMAGE_BYTES = 5 * 1024 * 1024;
const SCAN_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

const createProductScanInputSchema = z.object({
  s3Key: z.string().min(1).max(1024),
  genuineProductRefId: z.string().uuid().optional(),
});

type CreateProductScanInput = z.infer<typeof createProductScanInputSchema>;

export const createProductScan: CreateProductScan<
  CreateProductScanInput,
  Pick<ProductScan, "id" | "status" | "createdAt">
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    createProductScanInputSchema,
    rawArgs,
  );
  if (!args.s3Key.startsWith(`${context.user.id}/`)) {
    throw new HttpError(403, "The uploaded image does not belong to you.");
  }

  const uploadedFile = await context.entities.File.findFirst({
    where: { userId: context.user.id, s3Key: args.s3Key },
  });
  if (!uploadedFile) {
    throw new HttpError(404, "Upload the product image before scanning it.");
  }

  const objectMetadata = await getS3ObjectMetadataFromS3(args.s3Key);
  if (
    !SCAN_IMAGE_TYPES.includes(
      objectMetadata.contentType as (typeof SCAN_IMAGE_TYPES)[number],
    ) ||
    objectMetadata.contentLength > MAX_SCAN_IMAGE_BYTES
  ) {
    throw new HttpError(400, "Use a JPEG or PNG image up to 5 MB.");
  }

  let reference: GenuineProductRef | null = null;
  if (args.genuineProductRefId) {
    reference = await context.entities.GenuineProductRef.findFirst({
      where: { id: args.genuineProductRefId, isActive: true },
    });
    if (!reference) {
      throw new HttpError(404, "The selected reference package is unavailable.");
    }
  }

  const scan = await context.entities.ProductScan.create({
    data: {
      imageS3Key: args.s3Key,
      user: { connect: { id: context.user.id } },
      genuineProductRef: reference
        ? { connect: { id: reference.id } }
        : undefined,
      status: "PENDING",
    },
    select: { id: true, status: true, createdAt: true },
  });

  try {
    await analyzeProductJobClient.submit({ scanId: scan.id });
  } catch (error) {
    console.error(`Could not queue product scan ${scan.id}`, error);
    await context.entities.ProductScan.update({
      where: { id: scan.id },
      data: {
        status: "FAILED",
        errorMessage: "The screening job could not be queued. Please try again.",
      },
    });
    throw new HttpError(503, "Screening is temporarily unavailable.");
  }

  return scan;
};

const productScanIdSchema = z.object({ id: z.string().uuid() });
type ProductScanIdInput = z.infer<typeof productScanIdSchema>;

export const getProductScanById: GetProductScanById<
  ProductScanIdInput,
  ProductScan
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  const { id } = ensureArgsSchemaOrThrowHttpError(productScanIdSchema, rawArgs);
  const scan = await context.entities.ProductScan.findFirst({
    where: { id, userId: context.user.id },
  });
  if (!scan) {
    throw new HttpError(404, "Product scan not found.");
  }
  return scan;
};

export const getProductScanHistory: GetProductScanHistory<
  void,
  ProductScan[]
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.ProductScan.findMany({
    where: { userId: context.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
};

type ProductReferenceSummary = Pick<
  GenuineProductRef,
  "id" | "productName" | "manufacturer" | "nafdacRegistrationNumber"
>;

export const getGenuineProductRefs: GetGenuineProductRefs<
  void,
  ProductReferenceSummary[]
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.GenuineProductRef.findMany({
    where: { isActive: true },
    orderBy: { productName: "asc" },
    select: {
      id: true,
      productName: true,
      manufacturer: true,
      nafdacRegistrationNumber: true,
    },
  });
};

const packagingResponseSchema = z.object({
  product_name: z.string().nullable(),
  active_ingredients: z.array(z.string()),
  manufacturer: z.string().nullable(),
  registration_number: z.string().nullable(),
  batch_number: z.string().nullable(),
  manufacture_date: z.string().nullable(),
  expiry_date: z.string().nullable(),
  shelf_life_months: z.number().int().nullable(),
  barcode: z.string().nullable(),
  barcode_format: z.string().nullable(),
  sharpness_score: z.number().nonnegative(),
  is_blurry: z.boolean(),
  visual_flags: z.array(z.string()),
  visual_match_probability: z.number().min(0).max(1).nullable(),
  visual_differences: z.array(z.string()),
});

type PackagingResponse = z.infer<typeof packagingResponseSchema>;
type RegistryEvidence = {
  source: "registry" | "mock";
  found: boolean;
  registrationNumber: string | null;
  productName: string | null;
  manufacturer: string | null;
  status: string | null;
  isMock: boolean;
};

export async function runPackagingAnalysis({
  imageUrl,
  referenceImageUrl,
}: {
  imageUrl: string;
  referenceImageUrl?: string;
}): Promise<PackagingResponse> {
  const response = await fetch(`${env.VLM_WORKER_URL.replace(/\/$/, "")}/analyze-packaging`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": env.VLM_WORKER_SECRET,
    },
    body: JSON.stringify({
      image_url: imageUrl,
      reference_image_url: referenceImageUrl,
    }),
    signal: AbortSignal.timeout(env.VLM_WORKER_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Packaging worker returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return packagingResponseSchema.parse(payload);
}

export async function lookupNafdacRecord(
  registrationNumber: string | null,
): Promise<RegistryEvidence> {
  if (!registrationNumber) {
    return {
      source: "mock",
      found: false,
      registrationNumber: null,
      productName: null,
      manufacturer: null,
      status: null,
      isMock: true,
    };
  }

  if (env.NAFDAC_REGISTRY_URL) {
    const registryUrl = new URL(env.NAFDAC_REGISTRY_URL);
    registryUrl.searchParams.set("registrationNumber", registrationNumber);
    const headers = new Headers({ accept: "application/json" });
    if (env.NAFDAC_REGISTRY_API_KEY) {
      headers.set("authorization", `Bearer ${env.NAFDAC_REGISTRY_API_KEY}`);
    }

    try {
      const response = await fetch(registryUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        throw new Error(`NAFDAC registry returned HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      const registryRecordSchema = z.object({
        found: z.boolean(),
        registrationNumber: z.string().nullable().optional(),
        productName: z.string().nullable().optional(),
        manufacturer: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
      });
      const record = registryRecordSchema.parse(body);
      return {
        source: "registry",
        found: record.found,
        registrationNumber: record.registrationNumber ?? null,
        productName: record.productName ?? null,
        manufacturer: record.manufacturer ?? null,
        status: record.status ?? null,
        isMock: false,
      };
    } catch (error) {
      console.warn("NAFDAC registry lookup failed; using the local mock fallback.", error);
    }
  }

  // This deliberately synthetic record keeps local development useful without claiming to be
  // an official registry result. Configure NAFDAC_REGISTRY_URL for real registry evidence.
  const mockRecord =
    registrationNumber.trim().toUpperCase() === "NAFDAC-MOCK-0001"
      ? {
          found: true,
          registrationNumber: "NAFDAC-MOCK-0001",
          productName: "RiskCam Demo Paracetamol 500 mg",
          manufacturer: "RiskCam Demo Manufacturer",
          status: "MOCK ACTIVE",
        }
      : null;

  return {
    source: "mock",
    found: mockRecord?.found ?? false,
    registrationNumber: mockRecord?.registrationNumber ?? null,
    productName: mockRecord?.productName ?? null,
    manufacturer: mockRecord?.manufacturer ?? null,
    status: mockRecord?.status ?? null,
    isMock: true,
  };
}

function normalizeForComparison(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function dateFromExtraction(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function addMonthsUtc(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function deterministicFlags(
  extraction: PackagingResponse,
  registry: RegistryEvidence,
  reference: GenuineProductRef | null,
): string[] {
  const flags = new Set(
    extraction.visual_flags
      .map((flag) => flag.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"))
      .filter(Boolean),
  );
  if (extraction.is_blurry) flags.add("image_blurry");
  if (!extraction.barcode) flags.add("barcode_not_detected");
  if (!registry.found) flags.add("nafdac_registration_not_found");
  if (
    registry.found &&
    normalizeForComparison(registry.registrationNumber) !==
      normalizeForComparison(extraction.registration_number)
  ) {
    flags.add("nafdac_registration_number_mismatch");
  }
  if (
    registry.found &&
    registry.productName &&
    extraction.product_name &&
    normalizeForComparison(registry.productName) !==
      normalizeForComparison(extraction.product_name)
  ) {
    flags.add("nafdac_product_name_mismatch");
  }
  if (
    registry.found &&
    registry.manufacturer &&
    extraction.manufacturer &&
    normalizeForComparison(registry.manufacturer) !==
      normalizeForComparison(extraction.manufacturer)
  ) {
    flags.add("nafdac_manufacturer_mismatch");
  }
  if (
    extraction.visual_match_probability !== null &&
    extraction.visual_match_probability < 0.55
  ) {
    flags.add("reference_packaging_mismatch");
  }

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const manufactureDate = dateFromExtraction(extraction.manufacture_date);
  const expiryDate = dateFromExtraction(extraction.expiry_date);
  if (extraction.manufacture_date && !manufactureDate) {
    flags.add("manufacture_date_unparseable");
  }
  if (extraction.expiry_date && !expiryDate) {
    flags.add("expiry_date_unparseable");
  }
  if (manufactureDate && manufactureDate.getTime() > todayUtc) {
    flags.add("manufacture_date_in_future");
  }
  if (expiryDate && expiryDate.getTime() < todayUtc) {
    flags.add("product_expired");
  }
  if (
    manufactureDate &&
    expiryDate &&
    expiryDate.getTime() <= manufactureDate.getTime()
  ) {
    flags.add("expiry_precedes_manufacture");
  }
  if (
    manufactureDate &&
    expiryDate &&
    extraction.shelf_life_months !== null &&
    extraction.shelf_life_months > 0 &&
    extraction.shelf_life_months <= 1200
  ) {
    const expectedExpiry = addMonthsUtc(
      manufactureDate,
      extraction.shelf_life_months,
    );
    const differenceDays =
      Math.abs(expiryDate.getTime() - expectedExpiry.getTime()) / 86_400_000;
    if (differenceDays > 31) flags.add("shelf_life_mismatch");
  }

  if (
    reference &&
    extraction.registration_number &&
    reference.nafdacRegistrationNumber &&
    normalizeForComparison(extraction.registration_number) !==
      normalizeForComparison(reference.nafdacRegistrationNumber)
  ) {
    flags.add("reference_registration_number_mismatch");
  }
  if (
    reference &&
    extraction.barcode &&
    reference.barcode &&
    normalizeForComparison(extraction.barcode) !==
      normalizeForComparison(reference.barcode)
  ) {
    flags.add("reference_barcode_mismatch");
  }

  return Array.from(flags).sort();
}

async function assessWithJev(evidence: Record<string, ContentValue>) {
  if (!env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY is not configured.");
  }
  const client = new TypeSafeClient({
    apiKey: env.TYPESAFE_API_KEY,
    defaultModel: env.TYPESAFE_MODEL,
    timeout: 30_000,
    retry: { maxRetries: 1 },
  });
  const result = await client.systemOne({
    model: env.TYPESAFE_MODEL,
    state: evidence,
    questions: {
      verdict: choice(
        "Give a conservative screening verdict using the evidence. Do not claim regulatory authenticity.",
        {
          likely_genuine: "Evidence is consistent with the available registry and packaging checks.",
          suspicious: "Evidence contains one or more meaningful inconsistencies or tampering signals.",
          inconclusive: "Evidence is missing, unclear, or mixed; human review is needed.",
        },
      ),
      risk: score(
        "Rate the strength of counterfeit concern from 0 (none) to 10 (very strong).",
        [
          "0: no concrete concern in the supplied evidence",
          "1: negligible concern",
          "2: very low concern",
          "3: low concern",
          "4: mild concern",
          "5: moderate concern",
          "6: elevated concern",
          "7: high concern",
          "8: very high concern",
          "9: severe concern",
          "10: decisive concern requiring immediate human review",
        ],
      ),
      counterfeitSignal: noul(
        "Do the combined evidence and screening flags indicate a meaningful counterfeit risk?",
      ),
    },
  });

  return {
    verdict: result.answers.verdict.choice,
    confidence: result.answers.verdict.confidence,
    riskScore: result.answers.risk.score * 10,
    counterfeitProbability: result.answers.counterfeitSignal.noul,
  };
}

function buildDecisionReason(verdict: string, flags: string[]): string {
  const verdictText =
    verdict === "likely_genuine"
      ? "The screening evidence leans consistent."
      : verdict === "suspicious"
        ? "The screening evidence raises counterfeit concerns."
        : "The screening evidence is inconclusive and needs human review.";
  if (flags.length === 0) {
    return `${verdictText} No deterministic date, registry, barcode, or reference conflict was found. This is a screening result, not confirmation of authenticity.`;
  }
  const explanations = flags.map((flag) => flag.replaceAll("_", " "));
  return `${verdictText} Review these signals: ${explanations.join(", ")}. This is a screening result, not confirmation of authenticity.`;
}

export const analyzeProductJob: AnalyzeProductJob<
  { scanId: string },
  { status: "COMPLETE" | "FAILED" }
> = async (
  { scanId }: { scanId: string },
  context,
) => {
  const scan = await context.entities.ProductScan.findUnique({
    where: { id: scanId },
  });
  if (!scan) return { status: "FAILED" };

  try {
    await context.entities.ProductScan.update({
      where: { id: scanId },
      data: { status: "PROCESSING", errorMessage: null },
    });

    const reference: GenuineProductRef | null = scan.genuineProductRefId
      ? await context.entities.GenuineProductRef.findFirst({
          where: { id: scan.genuineProductRefId, isActive: true },
        })
      : null;
    const [imageUrl, referenceImageUrl] = await Promise.all([
      getTemporaryDownloadFileSignedURLFromS3(scan.imageS3Key, 300),
      reference
        ? getTemporaryDownloadFileSignedURLFromS3(reference.imageS3Key, 300)
        : Promise.resolve(undefined),
    ]);
    const extraction = await runPackagingAnalysis({
      imageUrl,
      referenceImageUrl,
    });
    const registry = await lookupNafdacRecord(extraction.registration_number);
    const flags = deterministicFlags(extraction, registry, reference);
    const evidence: Record<string, ContentValue> = {
      extractedPackaging: extraction,
      registryEvidence: registry,
      genuineReference: reference
        ? {
            productName: reference.productName,
            manufacturer: reference.manufacturer,
            nafdacRegistrationNumber: reference.nafdacRegistrationNumber,
            barcode: reference.barcode,
            visualMatchProbability: extraction.visual_match_probability,
            visualDifferences: extraction.visual_differences,
          }
        : null,
      deterministicFlags: flags,
      dateChecks: {
        checkedAt: new Date().toISOString(),
        method: "UTC calendar dates; expiry must be on or after today; shelf-life tolerance is 31 days",
      },
    };
    const decision = await assessWithJev(evidence);
    const verdict =
      decision.verdict === "likely_genuine"
        ? "LIKELY_GENUINE"
        : decision.verdict === "suspicious"
          ? "SUSPICIOUS"
          : "INCONCLUSIVE";

    await context.entities.ProductScan.update({
      where: { id: scanId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        barcode: extraction.barcode,
        extractedFields: extraction,
        registryEvidence: registry,
        verdict,
        confidence:
          typeof decision.confidence === "number" &&
          Number.isFinite(decision.confidence)
            ? decision.confidence
            : null,
        jevRiskScore: Number.isFinite(decision.riskScore)
          ? Math.max(0, Math.min(100, decision.riskScore))
          : null,
        flags,
        decisionReason: buildDecisionReason(decision.verdict, flags),
        errorMessage: null,
      },
    });
    return { status: "COMPLETE" };
  } catch (error) {
    console.error(`Product screening failed for scan ${scanId}`, error);
    await context.entities.ProductScan.update({
      where: { id: scanId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: "Screening could not be completed. Please try another clear image.",
      },
    });
    return { status: "FAILED" };
  }
};
