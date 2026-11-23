// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/** Keep account-owned card preferences separate while sharing appearance settings. */

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { dataFile, readJson, writeJsonStrict } from "./jsonStore.ts";
import { getDefaultSpeakerDid, setDefaultSpeakerDid } from "./settingsStore.ts";

const FILES = ["tray.json", "workbench.json"] as const;
const PROFILES_FILENAME = "account_profiles.json";
const DEVICES_CACHE_FILENAME = "devices_cache.json";

interface AccountProfile extends Record<string, unknown> {
  "tray.json"?: Record<string, unknown>;
  "workbench.json"?: Record<string, unknown>;
  speaker?: string;
}

interface AccountProfilesState extends Record<string, unknown> {
  owner?: string | null;
  profiles?: Record<string, AccountProfile>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeStrictFile(name: string, value: Record<string, unknown>): void {
  // Profile backups must succeed before active preferences are cleared.
  writeJsonStrict(dataFile(name), value);
}

function readState(): AccountProfilesState {
  return readJson<AccountProfilesState>(dataFile(PROFILES_FILENAME), {});
}

function takeSnapshot(): AccountProfile {
  const result: AccountProfile = {};
  for (const name of FILES) {
    result[name] = readJson<Record<string, unknown>>(dataFile(name), {});
  }
  result.speaker = getDefaultSpeakerDid();
  return result;
}

function restoreProfile(profile: AccountProfile): void {
  for (const name of FILES) {
    const fileData = profile[name];
    writeStrictFile(name, isPlainRecord(fileData) ? fileData : {});
  }
  setDefaultSpeakerDid(typeof profile.speaker === "string" ? profile.speaker : "");
  try {
    unlinkSync(dataFile(DEVICES_CACHE_FILENAME));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export function activate(accountId: string): void {
  if (!accountId) {
    return;
  }
  const key = createHash("sha256").update(String(accountId), "utf-8").digest("hex");
  const state = readState();
  if (Object.keys(state).length === 0) {
    // First upgrade adopts existing preferences without deleting anything.
    writeStrictFile(PROFILES_FILENAME, { owner: key, profiles: {} });
    return;
  }
  if (state.owner === key) {
    return;
  }
  let profiles = state.profiles;
  if (!isPlainRecord(profiles)) {
    profiles = {};
    state.profiles = profiles;
  }
  if (typeof state.owner === "string" && state.owner.length > 0) {
    profiles[state.owner] = takeSnapshot();
  }
  writeStrictFile(PROFILES_FILENAME, state);
  const nextProfile = profiles[key];
  restoreProfile(isPlainRecord(nextProfile) ? (nextProfile as AccountProfile) : {});
  state.owner = key;
  writeStrictFile(PROFILES_FILENAME, state);
}

export function deactivate(): void {
  const state = readState();
  const owner = state.owner;
  if (typeof owner === "string" && owner.length > 0) {
    let profiles = state.profiles;
    if (!isPlainRecord(profiles)) {
      profiles = {};
      state.profiles = profiles;
    }
    profiles[owner] = takeSnapshot();
  }
  state.owner = null;
  writeStrictFile(PROFILES_FILENAME, state);
  restoreProfile({});
}
