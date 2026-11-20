import * as z from "zod";

export const paymentPlansSchema = z.object({
  PAYMENTS_SUBSCRIPTION_PLAN_ID: z.string({
    error: "PAYMENTS_SUBSCRIPTION_PLAN_ID is required",
  }),
  PAYMENTS_CREDITS_10_PLAN_ID: z.string({
    error: "PAYMENTS_CREDITS_10_PLAN_ID is required",
  }),
});
