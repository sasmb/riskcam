import { action, job, page, query, route, type Spec } from "@wasp/spec";

import { ProductScanPage } from "./ProductScanPage" with { type: "ref" };
import {
  createProductScan,
  getGenuineProductRefs,
  getProductScanById,
  getProductScanHistory,
} from "./operations" with { type: "ref" };
import { analyzeProductJob } from "./operations" with { type: "ref" };

export const productScansSpec: Spec = [
  route(
    "ProductScanRoute",
    "/scan",
    page(ProductScanPage, { authRequired: true }),
  ),
  query(getProductScanById, { entities: ["ProductScan"] }),
  query(getProductScanHistory, { entities: ["ProductScan"] }),
  query(getGenuineProductRefs, { entities: ["GenuineProductRef"] }),
  action(createProductScan, {
    entities: ["ProductScan", "File", "GenuineProductRef"],
  }),
  job(analyzeProductJob, {
    executor: "PgBoss",
    entities: ["ProductScan", "GenuineProductRef"],
  }),
];
