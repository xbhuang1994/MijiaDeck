// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pi Agent 技能沉淀与持久化仓库（agent_skills.json + agent_skills/<id>.md）。
 *
 * 当 Agent 执行任务遇到异常并通过思考-排错-状态核验闭环成功解决后，
 * 自动将「踩坑原因 + 经校验有效的执行步骤 + 状态校验规则」沉淀为可复用 Skill，
 * 下次收到同类任务时直接复用成熟流程，避免重复踩坑。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, dataFile, readJson, writeJson } from "../core/jsonStore.ts";
import type { DeviceInfo } from "../core/models.ts";

const SKILLS_FILENAME = "agent_skills.json";
const SKILLS_MD_DIRNAME = "agent_skills";
const SKILLS_STORE_VERSION = 1;
const MAX_STORED_SKILLS = 100;

export interface AgentSkillStep {
  toolName: string;
  args: Record<string, unknown>;
  note?: string;
}

export interface AgentSkillVerificationSpec {
  did?: string;
  deviceName?: string;
  toolName: string;
  expectedPower?: boolean;
  expectedProps?: Record<string, unknown>;
  note?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  normalizedIntentKey: string;
  targetDids: string[];
  pitfall: string;
  resolutionSummary: string;
  steps: AgentSkillStep[];
  verification: AgentSkillVerificationSpec[];
  createdFromRetry: boolean;
  useCount: number;
  retriesAvoided: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  markdownFile?: string;
}

export interface SaveAgentSkillInput {
  name: string;
  description: string;
  triggerText: string;
  triggers?: string[];
  targetDids?: string[];
  pitfall: string;
  resolutionSummary: string;
  steps: AgentSkillStep[];
  verification?: AgentSkillVerificationSpec[];
  createdFromRetry?: boolean;
  enabled?: boolean;
}

interface AgentSkillFilePayload {
  version: number;
  skills: AgentSkill[];
}

const RE_POLITE_PREFIX =
  /^(?:你好|您好|小派|派派|米家助手|请|麻烦|帮我|帮忙|给我|替我|赶紧|马上|立刻|现在|先|再)+[，,、\s]*/i;
const RE_POLITE_SUFFIX = /(?:一下|一下子|吧|呀|哦|啊|呢|嘛|好了|谢谢|感谢|please|thanks)+$/i;

/**
 * 将自然语言指令规范化为稳定的技能意图签名：
 * 去除客套前后缀、空格与标点，但严格保留全部数字、单位、动作词与设备名，
 * 避免“亮度调到85%”误命中“亮度调到30%”的技能。
 */
export function normalizeSkillIntentKey(raw: string): string {
  let out = String(raw ?? "").trim().toLowerCase();
  if (!out) return "";
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    out = out.replace(RE_POLITE_PREFIX, "").replace(RE_POLITE_SUFFIX, "").trim();
    if (out === before) break;
  }
  return out
    .replace(/[的\s\-_·.,，。！？!?“”"'`（）()【】\[\]:：;；~～]/g, "")
    .trim();
}

function slugifySkillId(seed: string): string {
  const ascii = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const hash = simpleHash(seed);
  return ascii ? `skill_${ascii}_${hash}` : `skill_${hash}`;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 8);
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  } catch {
    return { ...(args ?? {}) };
  }
}

function sanitizeStep(raw: unknown): AgentSkillStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const toolName = typeof rec.toolName === "string" ? rec.toolName.trim() : "";
  if (!toolName) return null;
  const args =
    rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
      ? cloneArgs(rec.args as Record<string, unknown>)
      : {};
  const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim().slice(0, 200) : undefined;
  return {
    toolName,
    args,
    ...(note ? { note } : {}),
  };
}

function sanitizeVerificationSpec(raw: unknown): AgentSkillVerificationSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const toolName = typeof rec.toolName === "string" ? rec.toolName.trim() : "";
  if (!toolName) return null;
  const did = typeof rec.did === "string" && rec.did.trim() ? rec.did.trim() : undefined;
  const deviceName =
    typeof rec.deviceName === "string" && rec.deviceName.trim() ? rec.deviceName.trim() : undefined;
  const expectedPower = typeof rec.expectedPower === "boolean" ? rec.expectedPower : undefined;
  const expectedProps =
    rec.expectedProps && typeof rec.expectedProps === "object" && !Array.isArray(rec.expectedProps)
      ? cloneArgs(rec.expectedProps as Record<string, unknown>)
      : undefined;
  const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim().slice(0, 200) : undefined;
  return {
    toolName,
    ...(did ? { did } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(expectedPower !== undefined ? { expectedPower } : {}),
    ...(expectedProps && Object.keys(expectedProps).length > 0 ? { expectedProps } : {}),
    ...(note ? { note } : {}),
  };
}

function sanitizeSkill(raw: unknown): AgentSkill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const steps = Array.isArray(rec.steps)
    ? rec.steps.map(sanitizeStep).filter((s): s is AgentSkillStep => s !== null)
    : [];
  if (!id || !name || steps.length === 0) return null;

  const triggersRaw = Array.isArray(rec.triggers)
    ? rec.triggers.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  const normalizedIntentKey =
    typeof rec.normalizedIntentKey === "string" && rec.normalizedIntentKey.trim()
      ? rec.normalizedIntentKey.trim()
      : normalizeSkillIntentKey(triggersRaw[0] ?? name);
  if (!normalizedIntentKey) return null;

  const targetDids = Array.isArray(rec.targetDids)
    ? [...new Set(rec.targetDids.map((d) => String(d ?? "").trim()).filter(Boolean))]
    : [];
  const verification = Array.isArray(rec.verification)
    ? rec.verification
        .map(sanitizeVerificationSpec)
        .filter((v): v is AgentSkillVerificationSpec => v !== null)
    : [];

  const now = Date.now();
  return {
    id,
    name: name.slice(0, 80),
    description:
      typeof rec.description === "string" ? rec.description.trim().slice(0, 300) : name.slice(0, 80),
    triggers: [...new Set(triggersRaw)].slice(0, 12),
    normalizedIntentKey,
    targetDids,
    pitfall: typeof rec.pitfall === "string" ? rec.pitfall.trim().slice(0, 300) : "",
    resolutionSummary:
      typeof rec.resolutionSummary === "string" ? rec.resolutionSummary.trim().slice(0, 300) : "",
    steps,
    verification,
    createdFromRetry: rec.createdFromRetry !== false,
    useCount: typeof rec.useCount === "number" && Number.isFinite(rec.useCount) ? Math.max(0, Math.trunc(rec.useCount)) : 0,
    retriesAvoided:
      typeof rec.retriesAvoided === "number" && Number.isFinite(rec.retriesAvoided)
        ? Math.max(0, Math.trunc(rec.retriesAvoided))
        : 0,
    enabled: rec.enabled !== false,
    createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : now,
    updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now,
    lastUsedAt:
      typeof rec.lastUsedAt === "number" && Number.isFinite(rec.lastUsedAt) ? rec.lastUsedAt : null,
    ...(typeof rec.markdownFile === "string" && rec.markdownFile.trim()
      ? { markdownFile: rec.markdownFile.trim() }
      : {}),
  };
}

function skillsMarkdownDir(): string {
  return path.join(dataDir(), SKILLS_MD_DIRNAME);
}

function renderSkillMarkdown(skill: AgentSkill): string {
  const stepsLines = skill.steps.map((s, idx) => {
    const argsJson = JSON.stringify(s.args);
    return `${idx + 1}. \`${s.toolName}\` \`${argsJson}\`${s.note ? ` — ${s.note}` : ""}`;
  });
  const verifyLines =
    skill.verification.length > 0
      ? skill.verification.map((v, idx) => {
          const expectParts: string[] = [];
          if (typeof v.expectedPower === "boolean") {
            expectParts.push(`power=${v.expectedPower ? "on" : "off"}`);
          }
          if (v.expectedProps) {
            for (const [k, val] of Object.entries(v.expectedProps)) {
              expectParts.push(`${k}=${JSON.stringify(val)}`);
            }
          }
          const target = v.deviceName || v.did || v.toolName;
          return `${idx + 1}. ${target}: ${expectParts.join(", ") || v.note || "状态正常"}`;
        })
      : ["1. 执行完成后回读设备实时状态并核对目标值"];

  return [
    "---",
    `id: ${skill.id}`,
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    `intent_key: ${JSON.stringify(skill.normalizedIntentKey)}`,
    `enabled: ${skill.enabled}`,
    `created_from_retry: ${skill.createdFromRetry}`,
    `updated_at: ${new Date(skill.updatedAt).toISOString()}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    "## 触发指令",
    ...skill.triggers.map((t) => `- ${t}`),
    "",
    "## 避坑记录（历史问题）",
    skill.pitfall || "（通过排错核验沉淀）",
    "",
    "## 有效解决策略",
    skill.resolutionSummary || "按以下经验证通过的步骤顺序执行。",
    "",
    "## 经验证的执行步骤",
    ...stepsLines,
    "",
    "## 执行后状态检查标准",
    ...verifyLines,
    "",
  ].join("\n");
}

function syncSkillMarkdownFile(skill: AgentSkill): string | undefined {
  try {
    const dir = skillsMarkdownDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${skill.id}.md`;
    const filePath = path.join(dir, fileName);
    writeFileSync(filePath, renderSkillMarkdown(skill), "utf-8");
    return path.join(SKILLS_MD_DIRNAME, fileName).replaceAll("\\", "/");
  } catch {
    return skill.markdownFile;
  }
}

function removeSkillMarkdownFile(skillId: string): void {
  try {
    const filePath = path.join(skillsMarkdownDir(), `${skillId}.md`);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  } catch {
    // ignore cleanup failure
  }
}

function persistSkills(skills: AgentSkill[]): void {
  const payload: AgentSkillFilePayload = {
    version: SKILLS_STORE_VERSION,
    skills: skills.slice(0, MAX_STORED_SKILLS),
  };
  writeJson(dataFile(SKILLS_FILENAME), payload as unknown as Record<string, unknown>);
}

export function loadAgentSkills(): AgentSkill[] {
  const raw = readJson<Partial<AgentSkillFilePayload>>(dataFile(SKILLS_FILENAME), {
    version: SKILLS_STORE_VERSION,
    skills: [],
  });
  if (!raw || !Array.isArray(raw.skills)) {
    return [];
  }
  return raw.skills
    .map(sanitizeSkill)
    .filter((s): s is AgentSkill => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveAgentSkill(input: SaveAgentSkillInput): { skill: AgentSkill; created: boolean } {
  const triggerText = input.triggerText.trim();
  const normalizedIntentKey = normalizeSkillIntentKey(triggerText || input.name);
  if (!normalizedIntentKey) {
    throw new Error("技能触发指令不能为空");
  }
  const steps = input.steps
    .map((s) => sanitizeStep(s))
    .filter((s): s is AgentSkillStep => s !== null);
  if (steps.length === 0) {
    throw new Error("技能必须包含至少一个有效执行步骤");
  }

  const now = Date.now();
  const skills = loadAgentSkills();
  const existingIdx = skills.findIndex((s) => s.normalizedIntentKey === normalizedIntentKey);

  const mergedTriggers = [
    ...new Set(
      [
        ...(existingIdx >= 0 ? skills[existingIdx]!.triggers : []),
        triggerText,
        ...(input.triggers ?? []),
      ]
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 12);

  const inferredDids = [
    ...(input.targetDids ?? []),
    ...steps
      .map((s) => (typeof s.args.target === "string" ? s.args.target.trim() : ""))
      .filter(Boolean),
    ...(input.verification ?? []).map((v) => v.did ?? "").filter(Boolean),
  ];
  const targetDids = [...new Set(inferredDids)];

  const verification = (input.verification ?? [])
    .map((v) => sanitizeVerificationSpec(v))
    .filter((v): v is AgentSkillVerificationSpec => v !== null);

  let saved: AgentSkill;
  let created: boolean;

  if (existingIdx >= 0) {
    const prev = skills[existingIdx]!;
    saved = {
      ...prev,
      name: input.name.trim().slice(0, 80) || prev.name,
      description: input.description.trim().slice(0, 300) || prev.description,
      triggers: mergedTriggers,
      targetDids: targetDids.length > 0 ? targetDids : prev.targetDids,
      pitfall: input.pitfall.trim().slice(0, 300) || prev.pitfall,
      resolutionSummary: input.resolutionSummary.trim().slice(0, 300) || prev.resolutionSummary,
      steps,
      verification: verification.length > 0 ? verification : prev.verification,
      createdFromRetry: input.createdFromRetry ?? prev.createdFromRetry,
      enabled: input.enabled ?? prev.enabled,
      updatedAt: now,
    };
    skills[existingIdx] = saved;
    created = false;
  } else {
    const id = slugifySkillId(`${normalizedIntentKey}_${steps.map((s) => s.toolName).join("_")}`);
    saved = {
      id,
      name: input.name.trim().slice(0, 80) || triggerText.slice(0, 40),
      description: input.description.trim().slice(0, 300) || `自动沉淀的稳定执行流程：${triggerText}`,
      triggers: mergedTriggers,
      normalizedIntentKey,
      targetDids,
      pitfall: input.pitfall.trim().slice(0, 300),
      resolutionSummary: input.resolutionSummary.trim().slice(0, 300),
      steps,
      verification,
      createdFromRetry: input.createdFromRetry !== false,
      useCount: 0,
      retriesAvoided: 0,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    skills.unshift(saved);
    created = true;
  }

  saved.markdownFile = syncSkillMarkdownFile(saved);
  skills.sort((a, b) => b.updatedAt - a.updatedAt);
  persistSkills(skills);
  return { skill: saved, created };
}

/**
 * 为当前用户任务匹配已沉淀且启用的可复用 Skill。
 * 严格校对规范意图键与目标设备有效性（若设备已被屏蔽或移除则自动跳过）。
 */
export function matchAgentSkill(
  userText: string,
  activeDevices: readonly DeviceInfo[],
): AgentSkill | null {
  const norm = normalizeSkillIntentKey(userText);
  if (!norm) return null;

  const activeDidSet = new Set(activeDevices.map((d) => d.did));
  const activeNameSet = new Set(activeDevices.map((d) => normalizeSkillIntentKey(d.name)));
  const skills = loadAgentSkills();

  const candidates = skills.filter((skill) => {
    if (!skill.enabled || skill.steps.length === 0) return false;

    const intentMatch =
      skill.normalizedIntentKey === norm ||
      skill.triggers.some((t) => normalizeSkillIntentKey(t) === norm);
    if (!intentMatch) return false;

    // 若技能绑定了具体设备 did，确保目标设备仍在当前可用设备列表中（未被屏蔽/移除）
    if (skill.targetDids.length > 0 && activeDevices.length > 0) {
      const allValid = skill.targetDids.every((target) => {
        if (activeDidSet.has(target)) return true;
        // 兼容以设备名称记录的目标
        const normTarget = normalizeSkillIntentKey(target);
        return normTarget.length > 0 && activeNameSet.has(normTarget);
      });
      if (!allValid) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || b.useCount - a.useCount);
  return candidates[0]!;
}

export function recordSkillUse(skillId: string, avoidedRetry = true): AgentSkill | null {
  const skills = loadAgentSkills();
  const hit = skills.find((s) => s.id === skillId);
  if (!hit) return null;
  hit.useCount += 1;
  if (avoidedRetry) {
    hit.retriesAvoided += 1;
  }
  hit.lastUsedAt = Date.now();
  persistSkills(skills);
  return hit;
}

export function setAgentSkillEnabled(skillId: string, enabled: boolean): AgentSkill | null {
  const skills = loadAgentSkills();
  const hit = skills.find((s) => s.id === skillId);
  if (!hit) return null;
  hit.enabled = Boolean(enabled);
  hit.updatedAt = Date.now();
  hit.markdownFile = syncSkillMarkdownFile(hit);
  persistSkills(skills);
  return hit;
}

export function deleteAgentSkill(skillId: string): boolean {
  const skills = loadAgentSkills();
  const next = skills.filter((s) => s.id !== skillId);
  if (next.length === skills.length) return false;
  persistSkills(next);
  removeSkillMarkdownFile(skillId);
  return true;
}

export function clearAgentSkills(): void {
  const prev = loadAgentSkills();
  for (const s of prev) {
    removeSkillMarkdownFile(s.id);
  }
  persistSkills([]);
}

/**
 * 构建注入系统提示词的紧凑 Skill 避坑参考段（供云端大模型参考已有经验）。
 */
export function buildSkillsPromptSection(skills: readonly AgentSkill[], maxItems = 8): string {
  const enabled = skills.filter((s) => s.enabled && s.steps.length > 0).slice(0, maxItems);
  if (enabled.length === 0) return "";
  const lines = [
    "已沉淀技能（Skills · 历史避坑经验，遇到同类任务优先按已验证步骤执行）：",
    ...enabled.map((s) => {
      const stepDesc = s.steps
        .slice(0, 3)
        .map((st) => `${st.toolName}(${JSON.stringify(st.args)})`)
        .join(" -> ");
      const pitfallPart = s.pitfall ? ` | 曾踩坑:${s.pitfall}` : "";
      return `- ${s.name}${pitfallPart} | 验证步骤:${stepDesc}`;
    }),
  ];
  return lines.join("\n");
}
