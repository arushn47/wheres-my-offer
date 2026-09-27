import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import {
  PlacementAiExtractionSchema,
  MODEL_ID,
  PROMPT_VERSION,
  SCHEMA_VERSION,
} from './ai-schema';
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from './ai-prompt';
import type { PlacementAiExtraction } from './ai-schema';
import type {
  ValidatedAiExtraction,
} from './ai-deterministic-postprocess';
import {
  postProcessAndSanitizeAiExtraction,
} from './ai-deterministic-postprocess';

// In-memory cache for fast repeated runs during a session or dev server run
const memoryCache = new Map<string, ValidatedAiExtraction>();

/**
 * Computes deterministic cache key including model, prompt, and schema versions.
 * Invalidate automatically whenever prompt, schema, or model is changed.
 */
export function computeAiCacheKey(bodyText: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(bodyText || '');
  hash.update(MODEL_ID);
  hash.update(PROMPT_VERSION);
  hash.update(SCHEMA_VERSION);
  return hash.digest('hex');
}

export interface AiFallbackOptions {
  apiKey?: string;
  forceRefresh?: boolean;
}

export interface AiExtractionResponse {
  success: boolean;
  fromCache: boolean;
  data: ValidatedAiExtraction | null;
  rawJson?: string;
  error?: string;
}

/**
 * Executes the Tier 2 AI fallback extraction with:
 * - Cache keying by body + model + prompt + schema
 * - Temperature 0
 * - Validation retry loop
 * - Deterministic post-processing & sanity checking
 */
export async function executeAiPlacementExtraction(
  subject: string,
  bodyText: string,
  receivedAt: Date,
  options: AiFallbackOptions = {}
): Promise<AiExtractionResponse> {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      fromCache: false,
      data: null,
      error: 'GEMINI_API_KEY is not configured',
    };
  }

  const cacheKey = computeAiCacheKey(bodyText);

  // 1. Check Cache
  if (!options.forceRefresh && memoryCache.has(cacheKey)) {
    return {
      success: true,
      fromCache: true,
      data: memoryCache.get(cacheKey)!,
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const userPrompt = buildUserPrompt(subject, bodyText, receivedAt.toISOString());

async function callGeminiWithRetry(ai: GoogleGenAI, contents: string, maxRetries = 2): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: MODEL_ID,
        contents,
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        },
      });
      return res.text || '';
    } catch (err: any) {
      lastErr = err;
      const isTransient =
        err?.status === 503 ||
        err?.status === 429 ||
        (err?.message && (err.message.includes('503') || err.message.includes('high demand')));

      if (isTransient && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

  // 2. First Attempt
  let rawText = '';
  try {
    rawText = await callGeminiWithRetry(ai, userPrompt);
  } catch (apiErr) {
    const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
    return {
      success: false,
      fromCache: false,
      data: null,
      error: `Gemini API call failed: ${errMsg}`,
    };
  }

  // 3. Parse and Validate Schema
  let parsedJson: any;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (e) {
    // Retry once with error correction if JSON was malformed
    try {
      const retryRes = await ai.models.generateContent({
        model: MODEL_ID,
        contents: `${userPrompt}\n\nYour previous response was NOT valid JSON. Return ONLY the raw JSON object conforming strictly to the schema:\n${rawText}`,
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        },
      });
      parsedJson = JSON.parse(retryRes.text || '{}');
      rawText = retryRes.text || '';
    } catch (retryErr) {
      return {
        success: false,
        fromCache: false,
        data: null,
        rawJson: rawText,
        error: 'Failed to parse JSON output from model after retry',
      };
    }
  }

  const validationResult = PlacementAiExtractionSchema.safeParse(parsedJson);

  if (!validationResult.success) {
    // Retry once with Zod validation errors provided
    const issueSummary = validationResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');

    try {
      const fixRes = await ai.models.generateContent({
        model: MODEL_ID,
        contents: `${userPrompt}\n\nYour previous JSON failed schema validation with errors: ${issueSummary}. Please correct these issues and return valid JSON:\n${rawText}`,
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        },
      });

      const secondParsed = JSON.parse(fixRes.text || '{}');
      const secondValidation = PlacementAiExtractionSchema.safeParse(secondParsed);

      if (!secondValidation.success) {
        return {
          success: false,
          fromCache: false,
          data: null,
          rawJson: fixRes.text || rawText,
          error: `Schema validation failed after retry: ${secondValidation.error.message}`,
        };
      }

      parsedJson = secondValidation.data;
    } catch (fixErr) {
      return {
        success: false,
        fromCache: false,
        data: null,
        rawJson: rawText,
        error: `Schema validation retry failed: ${validationResult.error.message}`,
      };
    }
  } else {
    parsedJson = validationResult.data;
  }

  // 4. Deterministic Post-Processing & Sanity Checks
  const validatedData = postProcessAndSanitizeAiExtraction(
    parsedJson as PlacementAiExtraction,
    bodyText,
    receivedAt
  );

  // 5. Store in Cache
  memoryCache.set(cacheKey, validatedData);

  return {
    success: true,
    fromCache: false,
    data: validatedData,
    rawJson: rawText,
  };
}
