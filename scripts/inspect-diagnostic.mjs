#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const MAX_FILES = 64;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const MAX_SENSITIVE_JSON_LINE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const jsonOutput = args.includes("--json");
const allowSensitive = args.includes("--allow-sensitive");
const path = args.find((argument) => !argument.startsWith("--"));
if (!path) fail("usage: pnpm diagnostics:inspect -- [--allow-sensitive] <report.neoseq-bug> [--json]");

const archive = await readFile(path);
const files = readZip(archive);
for (const required of [
  "manifest.json",
  "summary.json",
  "events.jsonl",
  "metrics.jsonl",
  "errors.jsonl",
  "schemas/manifest.schema.json",
  "schemas/record.schema.json",
  "README.md",
  "checksums.sha256",
]) {
  if (!files.has(required)) fail(`artifact is missing ${required}`);
}

verifyChecksums(files);
const manifest = parseJson(files.get("manifest.json"), "manifest.json");
const summary = parseJson(files.get("summary.json"), "summary.json");
if (manifest.artifact_schema_version !== 1) {
  fail(`unsupported artifact schema: ${String(manifest.artifact_schema_version)}`);
}
const containsSensitive = manifest.contains_sensitive_content === true;
if (containsSensitive && !allowSensitive) {
  fail("artifact contains sensitive user content; inspect again with --allow-sensitive after reviewing its source");
}
if (containsSensitive !== files.has("sensitive/content.jsonl")) {
  fail("sensitive content declaration does not match artifact files");
}
validateInventory(manifest, files);
parseJson(files.get("schemas/manifest.schema.json"), "schemas/manifest.schema.json");
parseJson(files.get("schemas/record.schema.json"), "schemas/record.schema.json");
let sensitiveRecords = [];
if (containsSensitive) {
  if (!files.has("schemas/sensitive-record.schema.json")) {
    fail("artifact is missing schemas/sensitive-record.schema.json");
  }
  parseJson(files.get("schemas/sensitive-record.schema.json"), "schemas/sensitive-record.schema.json");
  sensitiveRecords = validateSensitiveJsonLines(
    files.get("sensitive/content.jsonl"),
    "sensitive/content.jsonl",
  );
  if (manifest.sensitive_record_count !== sensitiveRecords.length) {
    fail("sensitive record count does not match artifact stream");
  }
}
decodeUtf8(files.get("README.md"), "README.md");
const records = ["events.jsonl", "metrics.jsonl", "errors.jsonl"]
  .flatMap((stream) => validateJsonLines(files.get(stream), stream));
if (manifest.record_count !== records.length || summary.record_count !== records.length) {
  fail("record count does not match artifact streams");
}
if (!manifest.contains_user_content && records.some((record) => "annotation" in record)) {
  fail("content-free artifact contains an annotation");
}

const result = {
  artifact_schema_version: manifest.artifact_schema_version,
  capture_policy_version: manifest.capture_policy_version,
  redaction_level: manifest.redaction_level,
  contains_user_content: manifest.contains_user_content,
  contains_sensitive_content: containsSensitive,
  sensitive_record_count: sensitiveRecords.length,
  application: manifest.application,
  duration_ms: summary.duration_ms,
  record_count: summary.record_count,
  dropped_count: summary.dropped_count,
  recovered: summary.recovered,
  error_counts: summary.error_counts,
  gaps: summary.gaps,
  slowest_spans: summary.slowest_spans,
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const app = result.application ?? {};
  process.stdout.write([
    `Neoseq diagnostic artifact v${result.artifact_schema_version}`,
    `Capture: ${String(result.redaction_level)}${result.contains_sensitive_content ? " (contains sensitive user content)" : result.contains_user_content ? " (contains user annotation)" : " (content-free)"}`,
    `Build: ${String(app.version ?? "unknown")} / ${String(app.build_id ?? "unknown")}`,
    `Duration: ${String(result.duration_ms)} ms`,
    `Records: ${String(result.record_count)} (${String(result.dropped_count)} dropped)`,
    `Recovered: ${String(result.recovered)}`,
    `Errors: ${JSON.stringify(result.error_counts ?? {})}`,
    `Gaps: ${JSON.stringify(result.gaps ?? [])}`,
    "Slowest spans:",
    ...((result.slowest_spans ?? []).map((span) =>
      `  ${String(span.duration_ms).padStart(8)} ms  ${span.source}.${span.name}  trace=${span.trace_id ?? "-"}`)),
    "",
  ].join("\n"));
}

function readZip(buffer) {
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_FILES) fail(`artifact has too many files: ${count}`);
  const files = new Map();
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length) fail("truncated ZIP central directory");
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail("invalid ZIP central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) {
      fail("truncated ZIP central directory entry");
    }
    const name = decodeUtf8(buffer.subarray(offset + 46, offset + 46 + nameLength), "ZIP path");
    if (!safePath(name) || files.has(name)) fail(`unsafe or duplicate ZIP path: ${name}`);
    if (externalAttributes !== 0) fail(`unsupported ZIP attributes for ${name}`);
    if (method !== 0 || compressed !== uncompressed) fail(`unsupported ZIP compression for ${name}`);
    if (localOffset + 30 > buffer.length) fail(`truncated local header for ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) fail(`invalid local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = decodeUtf8(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      "local ZIP path",
    );
    if (localName !== name) fail(`mismatched ZIP entry name: ${name}`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataOffset, dataOffset + uncompressed);
    if (data.length !== uncompressed) fail(`truncated ZIP entry: ${name}`);
    expanded += uncompressed;
    if (expanded > MAX_EXPANDED_BYTES) fail("artifact exceeds expanded size limit");
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findEnd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail("invalid ZIP: end record not found");
}

function verifyChecksums(files) {
  const list = decodeUtf8(files.get("checksums.sha256"), "checksums.sha256").trim().split("\n");
  const verified = new Set();
  for (const line of list) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || !safePath(match[2]) || match[2] === "checksums.sha256") fail("invalid checksum list");
    const data = files.get(match[2]);
    if (!data) fail(`checksum references missing file: ${match[2]}`);
    if (verified.has(match[2])) fail(`duplicate checksum: ${match[2]}`);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== match[1]) fail(`checksum mismatch: ${match[2]}`);
    verified.add(match[2]);
  }
  for (const name of files.keys()) {
    if (name !== "checksums.sha256" && !verified.has(name)) fail(`file is not checksummed: ${name}`);
  }
}

function parseJson(buffer, name) {
  try {
    const value = JSON.parse(decodeUtf8(buffer, name));
    assertJsonDepth(value, name);
    return value;
  } catch {
    fail(`invalid JSON: ${name}`);
  }
}

function validateJsonLines(buffer, name) {
  const records = [];
  for (const line of decodeUtf8(buffer, name).split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_JSON_LINE_BYTES) fail(`oversized JSON line: ${name}`);
    try {
      const record = JSON.parse(line);
      assertJsonDepth(record, name);
      if (record.schema_version !== 1 || typeof record.sequence !== "number") {
        fail(`invalid diagnostic record: ${name}`);
      }
      records.push(record);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid diagnostic")) throw error;
      fail(`invalid JSON line: ${name}`);
    }
  }
  return records;
}

function validateSensitiveJsonLines(buffer, name) {
  const records = [];
  for (const line of decodeUtf8(buffer, name).split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_SENSITIVE_JSON_LINE_BYTES) {
      fail(`oversized sensitive JSON line: ${name}`);
    }
    try {
      const record = JSON.parse(line);
      assertJsonDepth(record, name);
      if (
        record.schema_version !== 1 ||
        typeof record.payload_id !== "string" ||
        typeof record.monotonic_ms !== "number" ||
        !["command", "query", "page_snapshot", "tag_snapshot", "graph_snapshot"].includes(record.kind)
      ) {
        fail(`invalid sensitive diagnostic record: ${name}`);
      }
      records.push(record);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid sensitive")) throw error;
      fail(`invalid JSON line: ${name}`);
    }
  }
  return records;
}

function validateInventory(manifest, files) {
  if (!Array.isArray(manifest.files)) fail("manifest file inventory is missing");
  const inventory = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.classification !== "string") {
      fail("invalid manifest file inventory");
    }
    if (!safePath(entry.path) || inventory.has(entry.path)) fail("invalid manifest file inventory");
    inventory.add(entry.path);
  }
  for (const name of files.keys()) {
    if (!inventory.has(name)) fail(`file is not classified in manifest: ${name}`);
  }
  for (const name of inventory) {
    if (!files.has(name)) fail(`manifest references missing file: ${name}`);
  }
}

function safePath(value) {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function decodeUtf8(buffer, name) {
  try {
    return decoder.decode(buffer);
  } catch {
    fail(`invalid UTF-8: ${name}`);
  }
}

function assertJsonDepth(value, name) {
  const stack = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_JSON_DEPTH) fail(`JSON nesting limit exceeded: ${name}`);
    if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
