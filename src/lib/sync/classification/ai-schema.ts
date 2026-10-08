import { z } from 'zod';

export const PROMPT_VERSION = 'v1.3';
export const SCHEMA_VERSION = 'v1.3';
export const MODEL_ID = 'gemini-2.5-flash';

/**
 * Strict schema for LLM placement extraction.
 * 
 * DESIGN DISCIPLINE:
 * 1. NO MATH in the LLM: Raw strings for compensation ('14+1 LPA', '11,50,000') are returned
 *    directly. Arithmetic and conversion to LPA are performed deterministically in TypeScript.
 * 2. Explicit Nulls: Missing or omitted fields cleanly default to null or empty arrays via .nullish().
 * 3. Auditability: Each event includes a `source_quote` from the email text.
 */
export const PlacementAiExtractionSchema = z.object({
  company_name: z
    .string()
    .nullish()
    .transform((v) => v ?? null)
    .describe('Official canonical company name (e.g. "Goldman Sachs", "TresVista"). Return null if unknown.'),

  drive_number: z
    .string()
    .nullish()
    .transform((v) => v ?? null)
    .describe('Official NeoPAT drive number if present (e.g. "pat-PL-2026-1261"). Return null if missing.'),

  compensation: z
    .object({
      ctc_text_raw: z
        .string()
        .nullish()
        .transform((v) => v ?? null)
        .describe('Exact raw compensation string from text (e.g. "14+1 LPA", "11,50,000 (if converted)", "8.5 - 10 LPA"). Return null if unannounced or TBA.'),
      stipend_text_raw: z
        .string()
        .nullish()
        .transform((v) => v ?? null)
        .describe('Exact raw stipend string from text (e.g. "₹75,000/month", "35k pm"). Return null if unannounced or TBA.'),
      category: z
        .enum(['Super Dream', 'Super Dream Internship', 'Dream', 'Dream Internship', 'Regular', 'Unknown'])
        .nullish()
        .transform((v) => v ?? 'Unknown'),
      category_source_quote: z
        .string()
        .nullish()
        .transform((v) => v ?? null)
        .describe('Direct quote from text proving the category (e.g. "Category: Super Dream"). Return null if not explicitly stated.'),
      compensation_source_quote: z
        .string()
        .nullish()
        .transform((v) => v ?? null)
        .describe('Direct quote from text stating the CTC or stipend. Return null if not mentioned.'),
    })
    .default({
      ctc_text_raw: null,
      stipend_text_raw: null,
      category: 'Unknown',
      category_source_quote: null,
      compensation_source_quote: null,
    }),

  events: z
    .array(
      z.object({
        round_type: z.enum([
          'ppt',
          'online_test',
          'technical_interview',
          'hr_interview',
          'result',
        ]),
        is_explicitly_scheduled: z.boolean().default(false),
        date_text_raw: z
          .string()
          .nullish()
          .transform((v) => v ?? null)
          .describe('Exact raw date and time string from text (e.g. "02.09.2026 by 3.30 pm"). Return null if date is not fixed.'),
        venue: z
          .string()
          .nullish()
          .transform((v) => v ?? null)
          .describe('Physical lab/hall or virtual platform (e.g. "PRP-717", "Own Location", "Mettl", "Zoom").'),
        source_quote: z
          .string()
          .nullish()
          .transform((v) => v ?? null)
          .describe('Brief direct quote from email text proving this event schedule for audit purposes.'),
      })
    )
    .nullish()
    .transform((v) => v ?? []),

  confidence: z
    .enum(['high', 'medium', 'low'])
    .nullish()
    .transform((v) => v ?? 'medium')
    .describe('Self-reported model confidence based on textual clarity.'),

  extraction_notes: z
    .string()
    .nullish()
    .transform((v) => v ?? '')
    .describe('1-2 sentences explaining reasoning, especially for null fields or ambiguous dates.'),
});

export type PlacementAiExtraction = z.infer<typeof PlacementAiExtractionSchema>;
