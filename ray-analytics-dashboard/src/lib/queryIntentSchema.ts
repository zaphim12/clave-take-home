import { z } from "zod";

export const VisualizationTypeSchema = z.enum([
  "line",
  "bar",
  "pie",
  "table",
  "metric_card",
]);

export const QueryIntentSchema = z.object({
  metric: z.enum(["revenue", "orders", "items_sold", "per_item_revenue"]),
  groupBy: z.array(
    z.enum(["location", "product", "category", "date", "hour", "fulfillment_method", "provider"])
  ).min(1),
  filters: z.object({
    date_range: z
      .object({
        start: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, { message: "Invalid date format. Expected YYYY-MM-DD" }),
        end: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, { message: "Invalid date format. Expected YYYY-MM-DD" }),
      })
      .optional(),
    locations: z.array(
      z.enum(["airport", "downtown", "mall", "university"])
    ).optional(),
    fulfillmentMethods: z
      .array(z.enum(["delivery", "pickup", "dine_in"]))
      .optional(),
    categories: z.array(z.string()).optional(),
    products: z.array(z.string()).optional(),
    providers: z.array(
      z.enum(["location", "product", "category", "time", "fulfillment_method", "provider"])
    ).optional(),
  }),
  limit: z.number().optional(),
  sortBy: z.enum(["value", "count", "name", "date"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const LLMResponseSchema = z.object({
  visualization: VisualizationTypeSchema,
  intent: QueryIntentSchema,
  chartTitle: z.string(),
  explanation: z.string().optional(),
});

export type QueryIntent = z.infer<typeof QueryIntentSchema>;
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

export function schemaAsString() {
  const jsonSchema = z.toJSONSchema(LLMResponseSchema);
  return JSON.stringify(jsonSchema, null, 2);
}