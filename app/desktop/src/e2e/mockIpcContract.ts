import type { CoreError } from "../lib/types";
import contractFixture from "./fixtures/mock-ipc-contract-v1.json";

export interface MockIpcConstantsV1 {
  readonly maxEditableNoteBytes: number;
  readonly maxTotalMatches: number;
  readonly maxMatchesPerFile: number;
  readonly maxQueryChars: number;
  readonly snippetMaxChars: number;
}

export interface MockIpcErrorsV1 {
  readonly notFound: Extract<CoreError, { kind: "notFound" }>;
  readonly alreadyExists: Extract<CoreError, { kind: "alreadyExists" }>;
  readonly outsideVault: Extract<CoreError, { kind: "outsideVault" }>;
  readonly invalidName: Extract<CoreError, { kind: "invalidName" }>;
  readonly invalidContent: Extract<CoreError, { kind: "invalidContent" }>;
  readonly conflict: Extract<CoreError, { kind: "conflict" }>;
  readonly io: Extract<CoreError, { kind: "io" }>;
  readonly frontmatter: Extract<CoreError, { kind: "frontmatter" }>;
  readonly llm: Extract<CoreError, { kind: "llm" }>;
  readonly localAi: Extract<CoreError, { kind: "localAi" }>;
}

export interface MockIpcExchangeV1 {
  readonly command: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly error?: CoreError;
  readonly mutation?: unknown;
}

export interface MockIpcContractV1 {
  readonly version: 1;
  readonly constants: MockIpcConstantsV1;
  readonly errors: MockIpcErrorsV1;
  readonly scenarios: Readonly<Record<string, readonly MockIpcExchangeV1[]>>;
}

const TOP_LEVEL_FIELDS = ["version", "constants", "errors", "scenarios"] as const;
const CONSTANT_FIELDS = [
  "maxEditableNoteBytes",
  "maxTotalMatches",
  "maxMatchesPerFile",
  "maxQueryChars",
  "snippetMaxChars",
] as const satisfies readonly (keyof MockIpcConstantsV1)[];

// The mapped object makes a new generated CoreError variant a TypeScript error
// until this versioned catalog and its Rust fixture generator are updated.
const CORE_ERROR_FIELDS: { readonly [Kind in CoreError["kind"]]: Kind } = {
  notFound: "notFound",
  alreadyExists: "alreadyExists",
  outsideVault: "outsideVault",
  invalidName: "invalidName",
  invalidContent: "invalidContent",
  conflict: "conflict",
  io: "io",
  frontmatter: "frontmatter",
  llm: "llm",
  localAi: "localAi",
};
const CORE_ERROR_KINDS = Object.values(CORE_ERROR_FIELDS);
const EXCHANGE_FIELDS = ["command", "arguments", "result", "error", "mutation"] as const;
const CORE_ERROR_VALUE_FIELDS = ["kind", "message"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactFields = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value);
  const missing = expected.filter((field) => !Object.hasOwn(value, field));
  const additional = actual.filter((field) => !expected.includes(field));
  if (missing.length === 0 && additional.length === 0) return;

  const details = [
    ...missing.map((field) => `missing '${field}'`),
    ...additional.map((field) => `additional '${field}'`),
  ];
  throw new Error(`${label} field drift: ${details.join(", ")}`);
};

const validateConstants = (value: unknown): MockIpcConstantsV1 => {
  if (!isRecord(value)) throw new Error("MockIpcContractV1 constants must be an object");
  assertExactFields(value, CONSTANT_FIELDS, "MockIpcContractV1 constants");
  for (const field of CONSTANT_FIELDS) {
    const constant = value[field];
    if (typeof constant !== "number" || !Number.isSafeInteger(constant) || constant < 0) {
      throw new Error(`MockIpcContractV1 constants.${field} must be a non-negative integer`);
    }
  }
  return value as unknown as MockIpcConstantsV1;
};

const validateCatalogError = (value: unknown, kind: CoreError["kind"]): CoreError => {
  if (!isRecord(value)) {
    throw new Error(`MockIpcContractV1 errors.${kind} must be a typed CoreError object`);
  }
  assertExactFields(value, CORE_ERROR_VALUE_FIELDS, `MockIpcContractV1 errors.${kind}`);
  if (value.kind !== kind || typeof value.message !== "string") {
    throw new Error(
      `MockIpcContractV1 errors.${kind} must contain CoreError kind '${kind}' and a string message`,
    );
  }
  return value as unknown as CoreError;
};

const validateErrors = (value: unknown): MockIpcErrorsV1 => {
  if (!isRecord(value)) throw new Error("MockIpcContractV1 errors must be an object");
  assertExactFields(value, CORE_ERROR_KINDS, "MockIpcContractV1 errors");
  for (const kind of CORE_ERROR_KINDS) validateCatalogError(value[kind], kind);
  return value as unknown as MockIpcErrorsV1;
};

/** Validate a scripted or generated failure against the Rust-generated V1 catalog. */
export function validateMockCoreErrorV1(
  contract: MockIpcContractV1,
  value: unknown,
  context = "mock failure",
): CoreError {
  if (!isRecord(value)) throw new Error(`${context} must be a typed CoreError object`);
  assertExactFields(value, CORE_ERROR_VALUE_FIELDS, `${context} CoreError`);
  const kind = value.kind;
  if (
    typeof kind !== "string"
    || !Object.hasOwn(contract.errors, kind)
    || !CORE_ERROR_KINDS.includes(kind as CoreError["kind"])
  ) {
    throw new Error(`${context} CoreError kind '${String(kind)}' is not in the Rust-generated V1 catalog`);
  }
  if (typeof value.message !== "string") {
    throw new Error(`${context} CoreError '${kind}' must have a string message`);
  }
  return value as unknown as CoreError;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

export function validateMockIpcContractV1(value: unknown): MockIpcContractV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("MockIpcContractV1 must have version 1");
  }
  assertExactFields(value, TOP_LEVEL_FIELDS, "MockIpcContractV1");
  const constants = validateConstants(value.constants);
  const errors = validateErrors(value.errors);
  if (!isRecord(value.scenarios)) {
    throw new Error("MockIpcContractV1 scenarios must be an object");
  }

  const contract = { ...value, constants, errors } as unknown as MockIpcContractV1;
  for (const [scenario, exchanges] of Object.entries(value.scenarios)) {
    if (!Array.isArray(exchanges)) throw new Error(`scenario '${scenario}' must be an array`);
    for (const exchange of exchanges) {
      if (!isRecord(exchange)) {
        throw new Error(`scenario '${scenario}' contains an invalid exchange`);
      }
      const allowedFields = EXCHANGE_FIELDS.filter((field) => Object.hasOwn(exchange, field));
      assertExactFields(exchange, allowedFields, `scenario '${scenario}' exchange`);
      if (
        typeof exchange.command !== "string"
        || !isRecord(exchange.arguments)
        || (("result" in exchange) === ("error" in exchange))
      ) {
        throw new Error(`scenario '${scenario}' contains an invalid exchange`);
      }
      if ("error" in exchange) {
        validateMockCoreErrorV1(contract, exchange.error, `scenario '${scenario}'`);
      }
    }
  }
  return contract;
}

/** The single validated fixture instance consumed by all MockIPC constants and failures. */
export const MOCK_IPC_CONTRACT_V1 = validateMockIpcContractV1(contractFixture);

export interface MockIpcReplay {
  assertNextInvocation: (
    command: string,
    arguments_: Readonly<Record<string, unknown>>,
  ) => void;
  invoke: (command: string, arguments_: Readonly<Record<string, unknown>>) => unknown;
  ownsCommand: (command: string) => boolean;
  nextCommand: () => string | null;
  remaining: () => number;
}

export function createMockIpcReplay(
  contract: MockIpcContractV1,
  scenario: string,
  onMutation: (mutation: unknown) => void = () => {},
): MockIpcReplay {
  const exchanges = contract.scenarios[scenario];
  if (!exchanges) throw new Error(`unknown MockIpcContractV1 scenario '${scenario}'`);
  const ownedCommands = new Set(exchanges.map((exchange) => exchange.command));
  let cursor = 0;
  const nextExchangeFor = (
    command: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): MockIpcExchangeV1 => {
    const expected = exchanges[cursor];
    if (!expected) throw new Error(`unexpected command '${command}' after scenario '${scenario}' was consumed`);
    if (expected.command !== command) {
      throw new Error(
        `command drift in '${scenario}': expected '${expected.command}', received '${command}'`,
      );
    }
    if (canonicalJson(expected.arguments) !== canonicalJson(arguments_)) {
      throw new Error(
        `argument drift for '${command}' in '${scenario}': expected ${canonicalJson(expected.arguments)}, received ${canonicalJson(arguments_)}`,
      );
    }
    return expected;
  };
  return {
    assertNextInvocation(command, arguments_) {
      nextExchangeFor(command, arguments_);
    },
    invoke(command, arguments_) {
      const expected = nextExchangeFor(command, arguments_);
      cursor += 1;
      if (expected.mutation !== undefined) onMutation(structuredClone(expected.mutation));
      if (expected.error) throw structuredClone(expected.error);
      return structuredClone(expected.result);
    },
    ownsCommand: (command) => ownedCommands.has(command),
    nextCommand: () => exchanges[cursor]?.command ?? null,
    remaining: () => exchanges.length - cursor,
  };
}
