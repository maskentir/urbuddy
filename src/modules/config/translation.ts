import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

export interface TranslationLanguages {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface TranslationFlags {
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  readonly translationProvider?: string;
  readonly translationModel?: string;
}

export type TranslationConfig =
  | { readonly enabled: false }
  | (TranslationLanguages & {
      readonly enabled: true;
      readonly provider: "openai";
      readonly model: string;
      readonly modelConfigVersion: string;
    });

export const DEFAULT_TRANSLATION_LANGUAGES: TranslationLanguages = Object.freeze({
  sourceLanguage: "auto",
  targetLanguage: "id",
});
const TRANSLATION_MODEL_CONFIG_VERSION = "translation-model-v1";
export const DEFAULT_TRANSLATION_MODEL = "gpt-6.1-terra";

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

function canonicalLanguage(value: string): string | undefined {
  if (value.length > 64) {
    return undefined;
  }
  try {
    const tag = Intl.getCanonicalLocales(value)[0];
    if (tag === undefined) {
      return undefined;
    }
    const language = new Intl.Locale(tag).language;
    if (
      language === "und" ||
      language === "mul" ||
      language === "zxx" ||
      languageNames.of(language) === undefined
    ) {
      return undefined;
    }
    return tag;
  } catch {
    return undefined;
  }
}

export function loadTranslationConfig(
  enabled: boolean,
  flags: TranslationFlags = {},
  env: Readonly<Record<string, string | undefined>> = {},
): Result<TranslationConfig, AppError> {
  if (!enabled) {
    return Object.values(flags).some((value) => value !== undefined)
      ? err(appError("CONFIG_INVALID", "translation options require --translate"))
      : ok(Object.freeze({ enabled: false }));
  }
  const source =
    flags.sourceLanguage ??
    env["URBUDDY_TRANSLATION_SOURCE_LANGUAGE"] ??
    DEFAULT_TRANSLATION_LANGUAGES.sourceLanguage;
  const target =
    flags.targetLanguage ??
    env["URBUDDY_TRANSLATION_TARGET_LANGUAGE"] ??
    DEFAULT_TRANSLATION_LANGUAGES.targetLanguage;
  const sourceLanguage = source === "auto" ? source : canonicalLanguage(source);
  const targetLanguage = canonicalLanguage(target);
  if (!sourceLanguage || !targetLanguage || targetLanguage === "auto") {
    return err(
      appError("CONFIG_INVALID", "translation requires valid source and target language tags"),
    );
  }
  const provider = flags.translationProvider ?? env["URBUDDY_TRANSLATION_PROVIDER"] ?? "openai";
  if (provider !== "openai") {
    return err(appError("CONFIG_INVALID", "unsupported translation provider"));
  }
  const model =
    flags.translationModel ?? env["URBUDDY_TRANSLATION_MODEL"] ?? DEFAULT_TRANSLATION_MODEL;
  if (!/^[a-z\d][a-z\d.-]{0,79}$/.test(model)) {
    return err(appError("CONFIG_INVALID", "invalid translation model identifier"));
  }
  return ok(
    Object.freeze({
      enabled: true,
      sourceLanguage,
      targetLanguage,
      provider,
      model,
      modelConfigVersion: TRANSLATION_MODEL_CONFIG_VERSION,
    }),
  );
}
