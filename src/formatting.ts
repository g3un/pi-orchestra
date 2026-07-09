const DEFAULT_MAX_CHARS = 4_000;

export const RESULT_DATA_MAX_CHARS = DEFAULT_MAX_CHARS;
export const BUS_MESSAGE_MAX_CHARS = DEFAULT_MAX_CHARS;
export const DETAIL_MAX_COLLECTION_ITEMS = 10;
export const RESULT_DATA_TRUNCATION_SUFFIX =
  "\n… truncated; inspect the child run details/session for complete result data.";

export function formatFullResultData(data: unknown): string {
  return typeof data === "string" ? data : (JSON.stringify(data, null, 2) ?? String(data));
}

export function formatResultData(data: unknown): string {
  return truncateText(formatFullResultData(data), RESULT_DATA_MAX_CHARS, RESULT_DATA_TRUNCATION_SUFFIX);
}

export function formatBoundedInlineData(data: unknown): string {
  const formatted = typeof data === "string" ? data : (JSON.stringify(data) ?? String(data));
  return truncateText(formatted, RESULT_DATA_MAX_CHARS, RESULT_DATA_TRUNCATION_SUFFIX);
}

export function formatBusMessageText(message: string): string {
  return truncateText(
    message,
    BUS_MESSAGE_MAX_CHARS,
    "\n… truncated; inspect the bus directly or use a narrower status view for complete message text.",
  );
}

export function boundResultData<T extends { result: { data?: unknown } | null }>(scope: T): T {
  if (!scope.result || scope.result.data === undefined) return scope;
  const boundedData = boundDetailValue(scope.result.data);
  if (boundedData === scope.result.data) return scope;
  return { ...scope, result: { ...scope.result, data: boundedData } };
}

export function boundDetailValue<T>(value: T, maxChars = DEFAULT_MAX_CHARS): T {
  if (serializedLengthWithin(value, maxChars)) return value;
  if (typeof value === "string") return truncateText(value, maxChars, RESULT_DATA_TRUNCATION_SUFFIX) as T;
  if (Array.isArray(value)) return value.map((item) => boundDetailValue(item, maxChars)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundDetailValue(entry, maxChars)])) as T;
}

function serializedLengthWithin(value: unknown, maxChars: number): boolean {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return serialized.length <= maxChars;
}

export function truncateText(text: string, maxChars = DEFAULT_MAX_CHARS, suffix = "… truncated."): string {
  if (text.length <= maxChars) return text;
  const textChars = Array.from(text);
  if (textChars.length <= maxChars) return text;

  const suffixChars = Array.from(suffix);
  if (suffixChars.length >= maxChars) return suffixChars.slice(0, maxChars).join("");
  return `${textChars.slice(0, maxChars - suffixChars.length).join("")}${suffix}`;
}
