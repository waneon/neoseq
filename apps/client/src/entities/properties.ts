// Client-side view of the uniform property model. The checked-in contract is
// shared with the domain registry, so shape and placement policy stay aligned.
// Presentation remains a sparse client concern.

import registryContract from "../../../../contracts/property-registry.json";
import type { PropertyValue, PropertyValueType } from "../core-port/snapshot";

export type PropertyTarget = "page" | "block" | "tag_metadata" | "tag_default";
export type PropertyAccess = "user" | "core";
export type PropertyVisibility =
  | "generic"
  | "feature_and_generic"
  | "read_only_metadata"
  | "hidden";

export type StringSpec = "any" | { suggested: string[] } | { one_of: string[] };
export type PropertyValueSpec =
  | "number"
  | "page"
  | "checkbox"
  | "date"
  | { string: StringSpec }
  | { document: { schema: string; version: number } };
export type PropertyShape =
  | { single: PropertyValueSpec }
  | { set: PropertyValueSpec };

export interface PropertySpec {
  shape: PropertyShape;
  placements: Partial<Record<PropertyTarget, PropertyAccess>>;
}

export const REGISTRY = registryContract.properties as Record<string, PropertySpec>;

export const VALUE_TYPES: PropertyValueType[] = ["string", "number", "checkbox", "date", "page"];

const PROPERTY_KEY_PATTERN = /^(?:builtin|user)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FEATURE_RENDERERS = new Set([
  "builtin.query",
  "builtin.task-status",
  "builtin.task-scheduled",
  "builtin.task-deadline",
  "builtin.task-priority",
]);
const METADATA_RENDERERS = new Set([
  "builtin.page-kind",
  "builtin.journal-date",
  "builtin.created-at",
  "builtin.updated-at",
]);

export function definition(key: string): PropertySpec | undefined {
  return REGISTRY[key];
}

function shapeValue(shape: PropertyShape): PropertyValueSpec {
  return "single" in shape ? shape.single : shape.set;
}

function specValueType(spec: PropertySpec): PropertyValueType {
  const value = shapeValue(spec.shape);
  if (typeof value === "string") return value;
  return "document" in value ? "document" : "string";
}

function hasUserPlacement(spec: PropertySpec): boolean {
  return Object.values(spec.placements).some((access) => access === "user");
}

export function valueTypeOf(key: string): PropertyValueType | undefined {
  const spec = definition(key);
  return spec && specValueType(spec);
}

export function stringChoicesOf(key: string): string[] {
  const spec = definition(key);
  if (!spec) return [];
  const value = shapeValue(spec.shape);
  if (typeof value === "string" || "document" in value || value.string === "any") return [];
  return "suggested" in value.string ? value.string.suggested : value.string.one_of;
}

export function visibilityOf(key: string): PropertyVisibility {
  if (METADATA_RENDERERS.has(key)) return "read_only_metadata";
  if (FEATURE_RENDERERS.has(key)) return "feature_and_generic";
  const spec = definition(key);
  if (spec && !hasUserPlacement(spec)) return "hidden";
  return "generic";
}

export function isGenericProperty(key: string): boolean {
  const visibility = visibilityOf(key);
  return visibility === "generic" || visibility === "feature_and_generic";
}

export type WritableTarget = "page" | "block" | "tag_default";

export function canUserWrite(key: string, target: WritableTarget): boolean {
  const spec = definition(key);
  if (spec) return spec.placements[target] === "user";
  return PROPERTY_KEY_PATTERN.test(key) && key.startsWith("user.");
}

export function cardinalityOf(key: string): "single" | "repeated" {
  const spec = definition(key);
  return spec && "set" in spec.shape ? "repeated" : "single";
}

export interface ValidationIssue {
  code:
    | "control_character"
    | "date"
    | "default_forbidden"
    | "empty_key"
    | "empty_page"
    | "finite_number"
    | "key_length"
    | "key_format"
    | "property_cardinality"
    | "property_strings"
    | "property_target"
    | "property_type"
    | "reserved_key"
    | "string_length"
    | "whitespace_key";
  message: string;
  values?: Record<string, string>;
}

export function validateKey(key: string): ValidationIssue | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { code: "empty_key", message: "Property key cannot be empty." };
  if (trimmed !== key) return { code: "whitespace_key", message: "Property key cannot have surrounding whitespace." };
  if (new TextEncoder().encode(key).length > 128) {
    return { code: "key_length", message: "Property key exceeds 128 bytes." };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return { code: "control_character", message: "Property key contains a control character." };
  if (!PROPERTY_KEY_PATTERN.test(key)) {
    return {
      code: "key_format",
      message: "Property key must use builtin.* or user.* with a lowercase kebab-case name.",
    };
  }
  const spec = definition(key);
  if ((spec && !hasUserPlacement(spec)) || (!spec && key.startsWith("builtin."))) {
    return {
      code: "reserved_key",
      message: `“${key}” is managed by the core.`,
      values: { key },
    };
  }
  return null;
}

export function validateWriteTarget(key: string, target: WritableTarget): ValidationIssue | null {
  if (canUserWrite(key, target)) return null;
  if (target === "tag_default") {
    return { code: "default_forbidden", message: `“${key}” cannot be a tag default.`, values: { key } };
  }
  const spec = definition(key);
  if (spec?.placements[target] === "core" || key.startsWith("builtin.")) {
    return { code: "reserved_key", message: `“${key}” is managed by the core.`, values: { key } };
  }
  return {
    code: "property_target",
    message: `“${key}” cannot be written on a ${target}.`,
    values: { key, target },
  };
}

export function validateValue(
  key: string,
  value: PropertyValue,
  cardinality: "single" | "repeated",
): ValidationIssue | null {
  if (value.type === "number" && !Number.isFinite(value.value)) {
    return { code: "finite_number", message: "Number must be finite." };
  }
  if (value.type === "string" && new TextEncoder().encode(value.value).length > 65_536) {
    return { code: "string_length", message: "String exceeds 65536 bytes." };
  }
  if (value.type === "date" && !isValidLocalDate(value.value)) {
    return { code: "date", message: "Date must be a valid YYYY-MM-DD calendar date." };
  }
  if (value.type === "page" && value.value.trim().length === 0) {
    return { code: "empty_page", message: "Page reference cannot be empty." };
  }
  if (value.type === "document" || value.type === "unsupported_document") {
    return {
      code: "property_type",
      message: `“${key}” requires a document-specific command.`,
      values: { key, type: "document" },
    };
  }
  const spec = definition(key);
  if (!spec) return null;
  const expectedType = specValueType(spec);
  if (expectedType !== value.type) {
    return { code: "property_type", message: `“${key}” expects a ${expectedType} value.`, values: { key, type: expectedType } };
  }
  const expectedCardinality = "set" in spec.shape ? "repeated" : "single";
  if (expectedCardinality !== cardinality) {
    return { code: "property_cardinality", message: `“${key}” is a ${expectedCardinality} property.`, values: { key, cardinality: expectedCardinality } };
  }
  const valueSpec = shapeValue(spec.shape);
  if (
    typeof valueSpec !== "string"
    && "string" in valueSpec
    && typeof valueSpec.string !== "string"
    && "one_of" in valueSpec.string
    && value.type === "string"
    && !valueSpec.string.one_of.includes(value.value)
  ) {
    const allowed = valueSpec.string.one_of;
    return { code: "property_strings", message: `“${key}” allows: ${allowed.join(", ")}.`, values: { key, values: allowed.join(", ") } };
  }
  return null;
}

export function validateFieldShape(
  key: string,
  valueType: PropertyValueType,
  cardinality: "single" | "repeated",
): ValidationIssue | null {
  const spec = definition(key);
  if (!spec) return null;
  const expectedType = specValueType(spec);
  if (expectedType !== valueType) {
    return { code: "property_type", message: `“${key}” expects a ${expectedType} value.`, values: { key, type: expectedType } };
  }
  const expectedCardinality = "set" in spec.shape ? "repeated" : "single";
  if (expectedCardinality !== cardinality) {
    return { code: "property_cardinality", message: `“${key}” is a ${expectedCardinality} property.`, values: { key, cardinality: expectedCardinality } };
  }
  return null;
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
    case "document":
      return {
        type: "document",
        value: defaultQueryDocument(),
      };
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
    case "document":
      return value.value.schema;
    case "unsupported_document":
      return `${value.value.schema} v${value.value.version}`;
    default:
      return value.value;
  }
}

export function sameValue(left: PropertyValue, right: PropertyValue): boolean {
  if (
    left.type === "document"
    || right.type === "document"
    || left.type === "unsupported_document"
    || right.type === "unsupported_document"
  ) {
    return left.type === right.type && JSON.stringify(left.value) === JSON.stringify(right.value);
  }
  return left.type === right.type && left.value === right.value;
}

export function defaultQueryDocument(source = ""): Extract<PropertyValue, { type: "document" }>["value"] {
  return {
    schema: "neoseq.query",
    version: 1,
    source,
    language: "sparql-1.1/neoseq-v1",
    views: [
      { id: "table", name: "Table", kind: "table", position: 0, visible_variables: [] },
      { id: "list", name: "List", kind: "list", position: 1, visible_variables: [] },
    ],
    default_view_id: "table",
  };
}
