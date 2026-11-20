import { useEffect, useState, type FormEvent } from "react";
import {
  createProductScan,
  createFileUploadUrl,
  addFileToDb,
  getGenuineProductRefs,
  getProductScanById,
  getProductScanHistory,
  useQuery,
} from "wasp/client/operations";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Clock3,
  ShieldAlert,
  ScanLine,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../client/components/ui/alert";
import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";
import { Progress } from "../client/components/ui/progress";
import { toast } from "../client/hooks/use-toast";
import { uploadFileWithProgress, validateFile } from "../file-upload/fileUploading";
import { MAX_FILE_SIZE_BYTES } from "../file-upload/validation";

const SCAN_IMAGE_TYPES = ["image/jpeg", "image/png"];
const FINAL_STATUSES = new Set(["COMPLETE", "FAILED"]);

type JsonRecord = Record<string, unknown>;

export function ProductScanPage() {
  const [uploadProgressPercent, setUploadProgressPercent] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [selectedReferenceId, setSelectedReferenceId] = useState("");

  const historyQuery = useQuery(getProductScanHistory);
  const referencesQuery = useQuery(getGenuineProductRefs);
  const scanQuery = useQuery(
    getProductScanById,
    { id: activeScanId ?? "" },
    { enabled: false },
  );

  useEffect(() => {
    if (!activeScanId) return;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refreshScan = async () => {
      const result = await scanQuery.refetch();
      if (
        !stopped &&
        result.status === "success" &&
        FINAL_STATUSES.has(result.data.status)
      ) {
        if (timer) clearInterval(timer);
        await historyQuery.refetch();
      }
    };

    timer = setInterval(() => void refreshScan(), 2000);
    void refreshScan();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [activeScanId, historyQuery.refetch, scanQuery.refetch]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const chosenFile = formData.get("product-image");

    if (!(chosenFile instanceof File) || chosenFile.size === 0) {
      toast({
        title: "Choose a product photo",
        description: "Use the rear camera to capture the label and package clearly.",
        variant: "destructive",
      });
      return;
    }

    if (!SCAN_IMAGE_TYPES.includes(chosenFile.type)) {
      toast({
        title: "Unsupported image",
        description: "Product scans accept JPEG or PNG images.",
        variant: "destructive",
      });
      return;
    }
    if (chosenFile.size > MAX_FILE_SIZE_BYTES) {
      toast({
        title: "Image is too large",
        description: "Choose an image up to 5 MB.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const file = validateFile(chosenFile);
      const { s3UploadUrl, s3UploadFields, s3Key } = await createFileUploadUrl({
        fileType: file.type,
        fileName: file.name,
      });

      await uploadFileWithProgress({
        file,
        s3UploadUrl,
        s3UploadFields,
        setUploadProgressPercent,
      });
      await addFileToDb({
        s3Key,
        fileType: file.type,
        fileName: file.name,
      });

      const scan = await createProductScan({
        s3Key,
        genuineProductRefId: selectedReferenceId || undefined,
      });
      setActiveScanId(scan.id);
      form.reset();
      await historyQuery.refetch();
      toast({
        title: "Scan started",
        description: "We are checking the package and will update this result shortly.",
      });
    } catch (error) {
      console.error("Product scan could not be started", error);
      toast({
        title: "Could not start scan",
        description:
          error instanceof Error ? error.message : "Please try again with another photo.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
      setUploadProgressPercent(0);
    }
  };

  const currentScan = scanQuery.data;
  const extraction = asRecord(currentScan?.extractedFields);
  const registry = asRecord(currentScan?.registryEvidence);
  const activeIngredientsValue = extraction.active_ingredients;
  const hasActiveIngredients = Array.isArray(activeIngredientsValue);
  const activeIngredients = asStringArray(activeIngredientsValue);
  const flags = Array.isArray(currentScan?.flags)
    ? (currentScan.flags as string[])
    : [];

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <p className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em]">
          <ScanLine className="size-4" /> Product verification
        </p>
        <h1 className="text-foreground text-3xl font-bold tracking-tight sm:text-4xl">
          Scan a medicine package
        </h1>
        <p className="text-muted-foreground mt-3 max-w-2xl leading-7">
          Capture the front label and registration details. RiskCam checks package
          text, barcode, available registry evidence, dates, and optional reference
          packaging. Results are a screening aid, not a guarantee of authenticity.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="text-primary size-5" /> Take a package photo
            </CardTitle>
            <CardDescription>
              Keep the registration number, batch, and dates in focus. Avoid glare.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="product-image">Package image</Label>
                <Input
                  id="product-image"
                  name="product-image"
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  required
                  className="cursor-pointer"
                />
                <p className="text-muted-foreground text-xs">
                  JPEG or PNG, up to 5 MB. On mobile this opens the rear camera.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="genuine-reference">Compare with a catalog reference</Label>
                <select
                  id="genuine-reference"
                  value={selectedReferenceId}
                  onChange={(event) => setSelectedReferenceId(event.target.value)}
                  className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  <option value="">No reference selected</option>
                  {referencesQuery.data?.map((reference) => (
                    <option key={reference.id} value={reference.id}>
                      {reference.productName} · {reference.manufacturer}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs">
                  References are curated catalog records. They are not uploaded by the scanner.
                </p>
              </div>

              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? "Uploading and starting scan…" : "Scan package"}
              </Button>
              {uploadProgressPercent > 0 && (
                <div className="space-y-2">
                  <Progress value={uploadProgressPercent} />
                  <p className="text-muted-foreground text-center text-xs">
                    Uploading {uploadProgressPercent}%
                  </p>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle>How to get a useful result</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-4 text-sm leading-6">
            <p>Photograph one package at a time, filling most of the frame.</p>
            <p>Include the NAFDAC number, batch number, manufacture date, and expiry date when possible.</p>
            <p>A barcode or visual match alone cannot confirm that a product is genuine.</p>
          </CardContent>
        </Card>
      </div>

      {activeScanId && (
        <Card className="mt-6" aria-live="polite">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {currentScan?.status === "COMPLETE" ? (
                <CheckCircle2 className="text-primary size-5" />
              ) : currentScan?.status === "FAILED" ? (
                <AlertCircle className="text-destructive size-5" />
              ) : (
                <Clock3 className="text-primary size-5 animate-pulse" />
              )}
              Screening result
            </CardTitle>
            <CardDescription>
              {currentScan?.status === "COMPLETE"
                ? `Completed ${formatDate(currentScan.completedAt ?? currentScan.createdAt)}`
                : currentScan?.status === "FAILED"
                  ? "This scan could not be completed."
                  : "Analyzing package details. This view refreshes every two seconds."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {currentScan?.status === "FAILED" ? (
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertTitle>Screening unavailable</AlertTitle>
                <AlertDescription>
                  {currentScan.errorMessage ?? "Please try again with a clear package image."}
                </AlertDescription>
              </Alert>
            ) : currentScan?.status === "COMPLETE" ? (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                      Screening verdict
                    </p>
                    <p className="text-foreground mt-1 text-2xl font-bold">
                      {formatVerdict(currentScan.verdict)}
                    </p>
                  </div>
                  <div className="bg-background rounded-lg border px-4 py-3 text-sm">
                    <span className="text-muted-foreground">Model confidence </span>
                    <strong className="text-foreground">
                      {formatConfidence(currentScan.confidence)}
                    </strong>
                    {currentScan.jevRiskScore !== null && (
                      <span className="text-muted-foreground ml-3">
                        Risk score {Math.round(currentScan.jevRiskScore)}/100
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-muted-foreground leading-6">
                  {currentScan.decisionReason}
                </p>

                {flags.length > 0 && (
                  <Alert variant="destructive">
                    <ShieldAlert className="size-4" />
                    <AlertTitle>Signals to review</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {flags.map((flag) => (
                          <li key={flag}>{humanize(flag)}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <EvidenceField label="Product" value={extraction.product_name} />
                  <EvidenceField label="Manufacturer" value={extraction.manufacturer} />
                  <EvidenceField label="NAFDAC number" value={extraction.registration_number} />
                  <EvidenceField label="Batch number" value={extraction.batch_number} />
                  <EvidenceField label="Manufactured" value={extraction.manufacture_date} />
                  <EvidenceField label="Expiry" value={extraction.expiry_date} />
                  <EvidenceField label="Barcode" value={extraction.barcode ?? currentScan.barcode} />
                  <EvidenceField
                    label="Registry source"
                    value={registry.isMock ? "Local mock fallback" : registry.source ?? "Unavailable"}
                  />
                </div>
                {hasActiveIngredients && (
                  <div>
                    <h3 className="text-foreground mb-2 text-sm font-semibold">Active ingredients</h3>
                    <p className="text-muted-foreground text-sm">
                      {activeIngredients.join(", ") || "Not read from the image"}
                    </p>
                  </div>
                )}
                <p className="text-muted-foreground border-border border-t pt-4 text-xs leading-5">
                  This is an automated screening result based on the photo and available evidence. It does not prove regulatory approval or product authenticity. Verify with NAFDAC or a qualified professional if concerned.
                </p>
              </div>
            ) : (
              <div className="text-muted-foreground flex items-center gap-3 text-sm">
                <span className="bg-primary size-2 animate-pulse rounded-full" />
                {scanQuery.error ? "Still waiting for the screening service…" : "Reading the package and checking available evidence…"}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <section className="mt-10" aria-labelledby="scan-history-title">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 id="scan-history-title" className="text-foreground text-xl font-semibold">
              Recent scans
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">Your latest 50 screening records.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void historyQuery.refetch()}>
            Refresh
          </Button>
        </div>
        {historyQuery.error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>Could not load scan history: {historyQuery.error.message}</AlertDescription>
          </Alert>
        )}
        {historyQuery.isLoading ? (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading scans…</p>
        ) : historyQuery.data?.length ? (
          <div className="space-y-3">
            {historyQuery.data.map((scan) => (
              <button
                key={scan.id}
                type="button"
                onClick={() => setActiveScanId(scan.id)}
                className="bg-card text-card-foreground hover:border-primary/50 flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition-colors"
              >
                <span>
                  <span className="block font-medium">{formatVerdict(scan.verdict ?? scan.status)}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {formatDate(scan.createdAt)}
                  </span>
                </span>
                <span className="text-muted-foreground text-right text-sm">
                  {scan.confidence === null ? scan.status : formatConfidence(scan.confidence)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="border-border text-muted-foreground rounded-xl border border-dashed px-6 py-10 text-center text-sm">
            No scans yet. Capture a product package to start your history.
          </div>
        )}
      </section>
    </main>
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item: unknown): item is string => typeof item === "string")
    : [];
}

function EvidenceField({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" && value.trim() ? value : "Not read from the image";
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="text-foreground mt-1 break-words text-sm font-medium">{text}</p>
    </div>
  );
}

function formatVerdict(verdict: string | null | undefined): string {
  switch (verdict) {
    case "LIKELY_GENUINE":
      return "Likely consistent";
    case "SUSPICIOUS":
      return "Suspicious signals";
    case "INCONCLUSIVE":
      return "Inconclusive";
    case "PENDING":
    case "PROCESSING":
      return "Screening in progress";
    case "FAILED":
      return "Screening failed";
    default:
      return "Waiting for result";
  }
}

function formatConfidence(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

function formatDate(value: Date | string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
