const fs = require("node:fs").promises as typeof import("node:fs/promises");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

import { TurnId as TurnIdSchema, type TurnId } from "@t3tools/contracts";
import { buildGeminiThinkingModelConfigAliases } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { asArray, asNumber, asRecord, trimToUndefined } from "./jsonValue.ts";

const GEMINI_RESUME_CURSOR_VERSION = 1;
const GEMINI_TMP_DIR = path.join(os.homedir(), ".gemini", "tmp");
const GEMINI_USER_ENV_PATH = path.join(os.homedir(), ".gemini", ".env");
const GEMINI_CHAT_DIR_NAME = "chats";
const GEMINI_SESSION_FILE_PREFIX = "session-";
const T3CODE_GEMINI_SETTINGS_DIR = path.join(os.tmpdir(), "t3code", "gemini");

export interface GeminiStoredTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly snapshotSessionId?: string;
  readonly snapshotFilePath?: string;
}

function cloneUnknownArray(items: ReadonlyArray<unknown>): Array<unknown> {
  return items.map((item) => {
    const record = asRecord(item);
    return record ? Object.assign({}, record) : item;
  });
}

export function cloneGeminiStoredTurn(turn: GeminiStoredTurn): GeminiStoredTurn {
  return {
    id: turn.id,
    items: cloneUnknownArray(turn.items),
    ...(turn.snapshotSessionId ? { snapshotSessionId: turn.snapshotSessionId } : {}),
    ...(turn.snapshotFilePath ? { snapshotFilePath: turn.snapshotFilePath } : {}),
  };
}

export function cloneGeminiTurnItems(items: ReadonlyArray<unknown>): Array<unknown> {
  return cloneUnknownArray(items);
}

export function readGeminiResumeSessionId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  if (!record) {
    return undefined;
  }

  const schemaVersion = asNumber(record.schemaVersion);
  if (schemaVersion !== undefined && schemaVersion !== GEMINI_RESUME_CURSOR_VERSION) {
    return undefined;
  }

  return trimToUndefined(record.sessionId);
}

export function buildGeminiResumeCursor(sessionId: string) {
  return {
    schemaVersion: GEMINI_RESUME_CURSOR_VERSION,
    sessionId,
  };
}

export function readLegacyGeminiResumeTurns(resumeCursor: unknown): Array<GeminiStoredTurn> {
  const record = asRecord(resumeCursor);
  const schemaVersion = asNumber(record?.schemaVersion);
  if (schemaVersion !== undefined) {
    return [];
  }

  return (
    asArray(record?.snapshots)?.reduce<Array<GeminiStoredTurn>>((acc, entry) => {
      const snapshot = asRecord(entry);
      const turnId = trimToUndefined(snapshot?.turnId);
      const sessionId = trimToUndefined(snapshot?.sessionId);
      const items = asArray(snapshot?.items);
      if (!turnId || !sessionId || !items) {
        return acc;
      }
      const filePath = trimToUndefined(snapshot?.filePath);
      acc.push({
        id: TurnIdSchema.make(turnId),
        items: cloneUnknownArray(items),
        snapshotSessionId: sessionId,
        ...(filePath ? { snapshotFilePath: filePath } : {}),
      });
      return acc;
    }, []) ?? []
  );
}

function isStoredGeminiSession(value: unknown): value is Record<string, unknown> & {
  sessionId: string;
  messages: Array<unknown>;
  startTime: string;
  lastUpdated: string;
} {
  const record = asRecord(value);
  return Boolean(
    trimToUndefined(record?.sessionId) &&
    asArray(record?.messages) &&
    trimToUndefined(record?.startTime) &&
    trimToUndefined(record?.lastUpdated),
  );
}

async function currentIsoTimestamp(): Promise<string> {
  return DateTime.formatIso(await Effect.runPromise(DateTime.now));
}

async function makeGeminiSessionFileName(sessionId: string): Promise<string> {
  const timestamp = (await currentIsoTimestamp()).replaceAll(":", "-").replaceAll(".", "-");
  return `${GEMINI_SESSION_FILE_PREFIX}${timestamp}-${sessionId.slice(0, 8)}.json`;
}

async function readStoredGeminiSession(filePath: string) {
  const content = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isStoredGeminiSession(content)) {
    throw new Error(`Invalid Gemini session file: ${filePath}`);
  }
  return content;
}

export async function findGeminiSessionFileById(
  sessionId: string,
  hintedPath?: string,
): Promise<string | undefined> {
  const prefix = sessionId.slice(0, 8);
  const candidatePaths = new Set<string>();
  if (hintedPath) {
    candidatePaths.add(hintedPath);
  }

  let projectDirs: Array<string> = [];
  try {
    projectDirs = (await fs.readdir(GEMINI_TMP_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(GEMINI_TMP_DIR, entry.name, GEMINI_CHAT_DIR_NAME));
  } catch {
    return undefined;
  }

  for (const chatsDir of projectDirs) {
    try {
      const files = await fs.readdir(chatsDir, { withFileTypes: true });
      for (const entry of files) {
        if (
          entry.isFile() &&
          entry.name.startsWith(GEMINI_SESSION_FILE_PREFIX) &&
          entry.name.endsWith(".json") &&
          entry.name.includes(prefix)
        ) {
          candidatePaths.add(path.join(chatsDir, entry.name));
        }
      }
    } catch {
      // Ignore project temp dirs without chats.
    }
  }

  for (const candidatePath of candidatePaths) {
    try {
      const storedSession = await readStoredGeminiSession(candidatePath);
      if (storedSession.sessionId === sessionId) {
        return candidatePath;
      }
    } catch {
      // Ignore unreadable or unrelated files.
    }
  }

  return undefined;
}

export async function cloneGeminiSessionFile(
  sourcePath: string,
  sessionId: string,
): Promise<string> {
  const storedSession = await readStoredGeminiSession(sourcePath);
  const nextSession = {
    ...storedSession,
    sessionId,
    lastUpdated: await currentIsoTimestamp(),
  };
  const destinationPath = path.join(
    path.dirname(sourcePath),
    await makeGeminiSessionFileName(sessionId),
  );
  await fs.writeFile(destinationPath, `${JSON.stringify(nextSession, null, 2)}\n`, "utf8");
  return destinationPath;
}

export async function writeGeminiModelAliasSettings(input: {
  readonly scopeId: string;
  readonly modelIds: ReadonlyArray<string>;
}): Promise<{
  readonly systemSettingsPath?: string;
  readonly env?: Readonly<Record<string, string>>;
}> {
  const modelIds = input.modelIds.filter(
    (model, index, collection) => model.trim() && collection.indexOf(model) === index,
  );
  const aliases = buildGeminiThinkingModelConfigAliases(modelIds);
  if (Object.keys(aliases).length === 0) {
    return {};
  }

  const systemSettingsPath = path.join(
    T3CODE_GEMINI_SETTINGS_DIR,
    `${input.scopeId}-${crypto.randomUUID()}.json`,
  );
  await fs.mkdir(T3CODE_GEMINI_SETTINGS_DIR, { recursive: true });
  await fs.writeFile(
    systemSettingsPath,
    JSON.stringify(
      {
        modelConfigs: {
          aliases,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    systemSettingsPath,
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
    },
  };
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if ((quote !== `"` && quote !== `'`) || trimmed.at(-1) !== quote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote !== `"`) {
    return inner;
  }

  let result = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\" || index === inner.length - 1) {
      result += char;
      continue;
    }

    const next = inner[index + 1];
    index += 1;
    if (next === "n") {
      result += "\n";
    } else if (next === `"` || next === "\\") {
      result += next;
    } else {
      result += `${char}${next}`;
    }
  }
  return result;
}

export function parseGeminiEnvFile(content: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const value = normalizedLine.slice(separatorIndex + 1);
    env[key] = unquoteEnvValue(value);
  }

  return env;
}

export async function readGeminiUserEnv(): Promise<Readonly<Record<string, string>>> {
  try {
    return parseGeminiEnvFile(await fs.readFile(GEMINI_USER_ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

export async function readGeminiLaunchEnv(
  overrides?: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>> | undefined> {
  const userEnv = await readGeminiUserEnv();
  const merged = {
    ...userEnv,
    ...process.env,
    ...overrides,
  };
  const entries = Object.entries(merged).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function cleanupGeminiSystemSettings(systemSettingsPath: string | undefined): void {
  if (!systemSettingsPath) {
    return;
  }
  void fs.unlink(systemSettingsPath).catch(() => {
    // Ignore already deleted temporary settings files.
  });
}
