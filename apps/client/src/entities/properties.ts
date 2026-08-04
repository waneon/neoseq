// Client-side view of the uniform property model. The registry is loaded
// from the versioned core fixture so the UI and the Rust core validate
// against one definition source. Unknown keys are first-class: they render
// and edit through the same generic path.

import registryFixture from "../../../../fixtures/core/property-definitions-v3.json";
import type { PropertyValue, PropertyValueType } from "../core-port/snapshot";

export interface PropertyDefinition {
  key: string;
  type: PropertyValueType;
  cardinality: "single" | "repeated";
  defaultable: boolean;
  allowed_strings: string[];
}

export const REGISTRY: PropertyDefinition[] = registryFixture.properties as PropertyDefinition[];

export const VALUE_TYPES: PropertyValueType[] = ["string", "number", "checkbox", "date", "page"];

/** Keys the app writes through dedicated commands or system paths. */
const RESERVED_KEYS = new Set(["tag", "page.title", "block.page", "page.kind", "journal.date"]);

export function definition(key: string): PropertyDefinition | undefined {
  return REGISTRY.find((item) => item.key === key);
}

export function isSystemKey(key: string): boolean {
  return key.startsWith("system.") || RESERVED_KEYS.has(key);
}

export function cardinalityOf(key: string): "single" | "repeated" {
  return definition(key)?.cardinality ?? "single";
}

export interface ValidationIssue {
  message: string;
}

export function validateKey(key: string): ValidationIssue | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { message: "Property key cannot be empty." };
  if (trimmed !== key) return { message: "Property key cannot have surrounding whitespace." };
  if (key.length > 128) return { message: "Property key exceeds 128 bytes." };
  if (RESERVED_KEYS.has(key)) return { message: `“${key}” is structural and cannot be a property.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return { message: "Property key contains a control character." };
  return null;
}

export function validateValue(
  key: string,
  value: PropertyValue,
  cardinality: "single" | "repeated",
): ValidationIssue | null {
  if (value.type === "number" && !Number.isFinite(value.value)) {
    return { message: "Number must be finite." };
  }
  if (value.type === "string" && new TextEncoder().encode(value.value).length > 65_536) {
    return { message: "String exceeds 65536 bytes." };
  }
  if (value.type === "date" && !isValidLocalDate(value.value)) {
    return { message: "Date must be a valid YYYY-MM-DD calendar date." };
  }
  if (value.type === "page" && value.value.trim().length === 0) {
    return { message: "Page reference cannot be empty." };
  }
  const item = definition(key);
  if (!item) return null;
  if (item.type !== value.type) {
    return { message: `“${key}” expects a ${item.type} value.` };
  }
  if (item.cardinality !== cardinality) {
    return { message: `“${key}” is a ${item.cardinality} property.` };
  }
  if (item.allowed_strings.length > 0 && value.type === "string" && !item.allowed_strings.includes(value.value)) {
    return { message: `“${key}” allows: ${item.allowed_strings.join(", ")}.` };
  }
  return null;
}

export function validateDefault(key: string, value: PropertyValue): ValidationIssue | null {
  if (key.startsWith("page.") || key.startsWith("system.")) {
    return { message: `“${key}” cannot be a tag default.` };
  }
  const item = definition(key);
  if (item && !item.defaultable) {
    return { message: `“${key}” cannot be a tag default.` };
  }
  return validateValue(key, value, "single");
}

export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= days;
}

export function defaultValueFor(type: PropertyValueType, today: string): PropertyValue {
  switch (type) {
    case "number":
      return { type: "number", value: 0 };
    case "checkbox":
      return { type: "checkbox", value: false };
    case "date":
      return { type: "date", value: today };
    case "page":
      return { type: "page", value: "" };
    default:
      return { type: "string", value: "" };
  }
}

export function formatValue(value: PropertyValue): string {
  switch (value.type) {
    case "checkbox":
      return value.value ? "checked" : "unchecked";
    case "number":
      return String(value.value);
    default:
      return value.value;
  }
}

export function sameValue(left: PropertyValue, right: PropertyValue): boolean {
  return left.type === right.type && left.value === right.value;
}
