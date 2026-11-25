// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pi Agent 多条附加指令规则持久化与冲突裁决仓库（custom_instructions.json）。
 *
 * 特性：
 * - 支持通过语音、对话或设置面板保存多条长期附加指令规则；
 * - 每条规则分配严格单调递增的 priority 序号与时间戳；
 * - 多条规则存在冲突时，始终以最新保存（priority 最高）的规则优先；
 * - 提供语音保存/查看/删除意图的确定性解析、设备默认偏好解析（洗衣机程序、灯光偏好等）
 *   以及面向大模型的清晰优先级提示词拼装。
 */

import { dataFile, readJson, writeJson } from "../core/jsonStore.ts";

export const CUSTOM_INSTRUCTIONS_FILENAME = "custom_instructions.json";
export const CUSTOM_INSTRUCTIONS_STORE_VERSION = 1;
export const MAX_CUSTOM_INSTRUCTIONS = 100;
export const MAX_CUSTOM_INSTRUCTION_LEN = 500;

export type CustomInstructionSource = "voice" | "text" | "manual";

export interface CustomInstructionRule {
  id: string;
  content: string;
  rawText?: string;
  topic: string;
  source: CustomInstructionSource;
  enabled: boolean;
  /** 严格单调递增的优先级序号（数值越大越新、冲突时优先级越高） */
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CustomInstructionConflictInfo {
  ruleId: string;
  overriddenById: string;
  overriddenByPriority: number;
  overriddenByContent: string;
  topic: string;
  reason: string;
}

export interface SaveCustomInstructionInput {
  content: string;
  rawText?: string;
  topic?: string;
  source?: CustomInstructionSource;
  enabled?: boolean;
}

export interface SaveCustomInstructionResult {
  rule: CustomInstructionRule;
  created: boolean;
  bumped: boolean;
  totalCount: number;
  enabledCount: number;
  conflictingRules: CustomInstructionRule[];
}

export interface UpdateCustomInstructionPatch {
  content?: string;
  topic?: string;
  enabled?: boolean;
  bumpPriority?: boolean;
}

export type ParsedCustomInstructionIntent =
  | { kind: "save"; content: string; rawText: string; topic: string }
  | { kind: "list"; topic?: string }
  | { kind: "delete_latest" }
  | { kind: "delete_match"; query: string }
  | { kind: "clear" };

interface CustomInstructionsFilePayload {
  version: number;
  nextPriority: number;
  rules: CustomInstructionRule[];
}

const COMMON_ROOM_NAMES: readonly string[] = [
  "儿童房",
  "老人房",
  "衣帽间",
  "卫生间",
  "洗手间",
  "客厅",
  "主卧",
  "次卧",
  "卧室",
  "餐厅",
  "书房",
  "厨房",
  "阳台",
  "浴室",
  "厕所",
  "走廊",
  "过道",
  "玄关",
  "门厅",
  "车库",
];

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 8);
}

export function normalizeInstructionKey(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]+/g, "");
}

function cleanRuleContent(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+/, "")
    .replace(/[\s]+/g, " ")
    .replace(/[。！!？?;；,，]+$/, "")
    .trim()
    .slice(0, MAX_CUSTOM_INSTRUCTION_LEN);
}

export function inferInstructionTopic(text: string): string {
  const s = text.trim();
  if (!s) return "通用";
  if (/(?:洗衣机|洗烘|智洗烘|洗衣|滚筒|波轮|烘干|筒自洁|脱水|洗涤|漂洗|laundry|washer)/i.test(s)) {
    return "洗衣机";
  }
  if (/(?:空调|\bac\b|air\s*condition)/i.test(s)) {
    return "空调";
  }
  if (/(?:吸顶灯|吊灯|主灯|射灯|灯带|台灯|落地灯|壁灯|夜灯|筒灯|灯光|电灯|照明|开灯|关灯|亮度|色温|暖光|冷光|灯|\blights?\b|\blamps?\b)/i.test(s)) {
    return "灯光";
  }
  if (/(?:小爱|音箱|音响|音量|音乐|歌曲|播报|静音|\bspeaker\b|\bmusic\b)/i.test(s)) {
    return "音箱";
  }
  if (/(?:窗帘|纱帘|卷帘|\bcurtain)/i.test(s)) {
    return "窗帘";
  }
  if (/(?:除湿机|除湿)/i.test(s)) {
    return "除湿机";
  }
  if (/(?:喂食器|喂食|出粮|猫粮|狗粮|宠粮|投喂|\bfeeder\b)/i.test(s)) {
    return "喂食器";
  }
  if (/(?:摄像头|摄像机|监控|\bcamera\b)/i.test(s)) {
    return "摄像头";
  }
  if (/(?:插座|开关|排插|插排|\bplug\b|\bswitch\b)/i.test(s)) {
    return "插座开关";
  }
  if (/(?:温湿度|温度计|湿度计|传感器|\bsensor\b)/i.test(s)) {
    return "传感器";
  }
  return "通用";
}

function detectRoomScope(text: string): string {
  for (const room of COMMON_ROOM_NAMES) {
    if (text.includes(room)) return room;
  }
  return "*";
}

function extractExplicitTriggerKey(text: string): string | null {
  const m =
    /(?:我说|我让(?:你)?|我叫(?:你)?|我喊|听到|收到)[“"'「]?([^，,。！？!?\s”"'」]{2,14})[”"'」]?(?:的时候|时|就|你要|你就|你帮|请|帮我|把)/.exec(
      text,
    );
  if (!m?.[1]) return null;
  const norm = normalizeInstructionKey(m[1]);
  return norm.length >= 2 ? `trigger:${norm}` : null;
}

/**
 * 提取一条附加指令规则对应的冲突域签名。
 * 同域规则之间若参数/策略不同即存在潜在冲突，遵循最新规则覆盖旧规则原则。
 */
export function extractConflictDomains(rule: Pick<CustomInstructionRule, "content" | "topic">): string[] {
  const text = rule.content.trim();
  const topic = (rule.topic || inferInstructionTopic(text)).trim() || "通用";
  const room = detectRoomScope(text);
  const domains = new Set<string>();

  const trigger = extractExplicitTriggerKey(text);
  if (trigger) {
    domains.add(trigger);
  }

  if (topic === "洗衣机") {
    if (/(?:模式|程序|智洗烘|快洗|速洗|标准洗|混合洗|棉麻|轻柔|大件|羊毛|羽绒|单烘干|烘干|筒自洁|空气洗|洗烘|除菌|强力|mode|program)/i.test(text)) {
      domains.add(`洗衣机:${room}:program`);
    }
    if (/(?:水温|温度|\d{2}\s*度|冷水|热水)/i.test(text)) {
      domains.add(`洗衣机:${room}:water_temp`);
    }
    if (/(?:转速|脱水|甩干|\d{3,4}\s*转)/i.test(text)) {
      domains.add(`洗衣机:${room}:spin_speed`);
    }
    if (/(?:上筒|下筒|左筒|右筒|小筒|大筒|筒位)/i.test(text)) {
      domains.add(`洗衣机:${room}:drum`);
    }
    if (domains.size === 0) {
      domains.add(`洗衣机:${room}:default`);
    }
  } else if (topic === "空调") {
    if (/(?:打开空调|开空调|启动空调|室外温度|自动选择|自动判断|默认)/i.test(text)) {
      domains.add(`空调:${room}:open_policy`);
    }
    if (/(?:制冷|制热|送风|除湿|自动模式|模式|室外温度)/i.test(text)) {
      domains.add(`空调:${room}:mode`);
    }
    if (/(?:温度|\d{2}\s*度|几度|室外温度)/i.test(text)) {
      domains.add(`空调:${room}:temperature`);
    }
    if (/(?:风速|风量|静音风|自动风|强风|低风|高风|睡眠风)/i.test(text)) {
      domains.add(`空调:${room}:fan_speed`);
    }
    if (domains.size === 0) {
      domains.add(`空调:${room}:default`);
    }
  } else if (topic === "灯光") {
    if (/(?:亮度|调亮|调暗|最亮|最暗|\d{1,3}\s*%|brightness)/i.test(text)) {
      domains.add(`灯光:${room}:brightness`);
    }
    if (/(?:色温|暖光|暖色|冷光|冷色|白光|自然光|中性光|\d{4}\s*k)/i.test(text)) {
      domains.add(`灯光:${room}:color_temp`);
    }
    if (/(?:颜色|红色|橙色|黄色|绿色|蓝色|紫色|粉色|青色|#[0-9a-f]{6})/i.test(text)) {
      domains.add(`灯光:${room}:color`);
    }
    if (domains.size === 0) {
      domains.add(`灯光:${room}:default`);
    }
  } else if (topic === "音箱") {
    if (/(?:音量|声音|\d{1,3}\s*%?|大一点|小一点|静音)/i.test(text)) {
      domains.add(`音箱:${room}:volume`);
    }
    if (domains.size === 0) {
      domains.add(`音箱:${room}:default`);
    }
  } else if (topic === "喂食器") {
    if (/(?:份|出粮|喂食|投喂)/i.test(text)) {
      domains.add(`喂食器:${room}:portion`);
    }
  } else if (topic !== "通用" && domains.size === 0) {
    domains.add(`${topic}:${room}:default`);
  }

  return [...domains];
}

function domainsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.split(":");
  const pb = b.split(":");
  if (pa.length === 3 && pb.length === 3 && pa[0] === pb[0] && pa[2] === pb[2]) {
    // 泛化全屋规则 (*) 与具体房间规则仅在同为 * 或同房间时判定直接冲突；
    // 若较新规则是全屋规则 (*)，也视为可覆盖旧房间规则的潜在冲突
    if (pa[1] === "*" || pb[1] === "*" || pa[1] === pb[1]) {
      return true;
    }
  }
  return false;
}

function describeConflictDomain(domain: string): string {
  if (domain.startsWith("trigger:")) {
    return `触发指令「${domain.slice("trigger:".length)}」`;
  }
  if (domain.endsWith(":program")) return "默认洗涤模式";
  if (domain.endsWith(":water_temp")) return "默认水温";
  if (domain.endsWith(":spin_speed")) return "默认脱水转速";
  if (domain.endsWith(":drum")) return "默认筒位";
  if (domain.endsWith(":open_policy")) return "空调开启策略";
  if (domain.endsWith(":mode")) return "空调运行模式";
  if (domain.endsWith(":temperature")) return "空调目标温度";
  if (domain.endsWith(":fan_speed")) return "空调风速";
  if (domain.endsWith(":brightness")) return "默认灯光亮度";
  if (domain.endsWith(":color_temp")) return "默认灯光色温";
  if (domain.endsWith(":color")) return "默认灯光颜色";
  if (domain.endsWith(":volume")) return "默认音箱音量";
  if (domain.endsWith(":portion")) return "默认出粮份数";
  return `${domain.split(":")[0] || "同类"}规则`;
}

/**
 * 检测已启用规则间的潜在冲突：
 * 按 priority 从新到旧遍历，若旧规则与更新的规则命中相同冲突域，则标记该旧规则在冲突处由最新规则覆盖。
 */
export function detectCustomInstructionConflicts(
  rules: readonly CustomInstructionRule[],
): Map<string, CustomInstructionConflictInfo> {
  const enabledSorted = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);

  const conflicts = new Map<string, CustomInstructionConflictInfo>();
  const newerEntries: Array<{ rule: CustomInstructionRule; domains: string[] }> = [];

  for (const rule of enabledSorted) {
    const domains = extractConflictDomains(rule);
    for (const newer of newerEntries) {
      let matchedDomain: string | null = null;
      for (const nd of newer.domains) {
        if (domains.some((od) => domainsOverlap(nd, od))) {
          matchedDomain = nd;
          break;
        }
      }
      if (matchedDomain) {
        conflicts.set(rule.id, {
          ruleId: rule.id,
          overriddenById: newer.rule.id,
          overriddenByPriority: newer.rule.priority,
          overriddenByContent: newer.rule.content,
          topic: rule.topic,
          reason: `${describeConflictDomain(matchedDomain)}冲突，以最新规则为准`,
        });
        break;
      }
    }
    newerEntries.push({ rule, domains });
  }

  return conflicts;
}

function sanitizeSource(raw: unknown): CustomInstructionSource {
  if (raw === "voice" || raw === "text" || raw === "manual") return raw;
  return "manual";
}

function sanitizeRule(raw: unknown, fallbackPriority: number): CustomInstructionRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const content = cleanRuleContent(typeof rec.content === "string" ? rec.content : "");
  if (!content) return null;
  const now = Date.now();
  const priority =
    typeof rec.priority === "number" && Number.isFinite(rec.priority) && rec.priority > 0
      ? Math.trunc(rec.priority)
      : fallbackPriority;
  const id =
    typeof rec.id === "string" && rec.id.trim()
      ? rec.id.trim().slice(0, 64)
      : `inst_${simpleHash(content)}_${priority}`;
  const topicRaw = typeof rec.topic === "string" ? rec.topic.trim().slice(0, 24) : "";
  const rawText =
    typeof rec.rawText === "string" && rec.rawText.trim()
      ? rec.rawText.trim().slice(0, MAX_CUSTOM_INSTRUCTION_LEN)
      : undefined;
  return {
    id,
    content,
    ...(rawText ? { rawText } : {}),
    topic: topicRaw || inferInstructionTopic(content),
    source: sanitizeSource(rec.source),
    enabled: rec.enabled !== false,
    priority,
    createdAt:
      typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : now,
    updatedAt:
      typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now,
  };
}

function loadStorePayload(): CustomInstructionsFilePayload {
  const raw = readJson<Partial<CustomInstructionsFilePayload>>(
    dataFile(CUSTOM_INSTRUCTIONS_FILENAME),
    {
      version: CUSTOM_INSTRUCTIONS_STORE_VERSION,
      nextPriority: 1,
      rules: [],
    },
  );
  const rawList = Array.isArray(raw?.rules) ? raw.rules : [];
  const rules: CustomInstructionRule[] = [];
  let maxPriority = 0;
  for (let i = 0; i < rawList.length; i += 1) {
    const item = sanitizeRule(rawList[i], i + 1);
    if (!item) continue;
    if (item.priority > maxPriority) maxPriority = item.priority;
    rules.push(item);
  }
  rules.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
  const storedNext =
    typeof raw?.nextPriority === "number" && Number.isFinite(raw.nextPriority)
      ? Math.trunc(raw.nextPriority)
      : 1;
  return {
    version: CUSTOM_INSTRUCTIONS_STORE_VERSION,
    nextPriority: Math.max(storedNext, maxPriority + 1),
    rules: rules.slice(0, MAX_CUSTOM_INSTRUCTIONS),
  };
}

function persistStorePayload(payload: CustomInstructionsFilePayload): void {
  const sorted = [...payload.rules]
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
    .slice(0, MAX_CUSTOM_INSTRUCTIONS);
  writeJson(dataFile(CUSTOM_INSTRUCTIONS_FILENAME), {
    version: CUSTOM_INSTRUCTIONS_STORE_VERSION,
    nextPriority: payload.nextPriority,
    rules: sorted,
  });
}

export function loadCustomInstructions(): CustomInstructionRule[] {
  return loadStorePayload().rules;
}

export function loadEnabledCustomInstructions(): CustomInstructionRule[] {
  return loadStorePayload().rules.filter((r) => r.enabled);
}

export function addCustomInstruction(
  input: SaveCustomInstructionInput,
): SaveCustomInstructionResult {
  const content = cleanRuleContent(input.content);
  if (!content) {
    throw new Error("附加指令内容不能为空");
  }
  const normKey = normalizeInstructionKey(content);
  if (!normKey) {
    throw new Error("附加指令内容无效");
  }

  const payload = loadStorePayload();
  const now = Date.now();
  const topic = input.topic?.trim().slice(0, 24) || inferInstructionTopic(content);
  const source = sanitizeSource(input.source ?? "manual");
  const rawText = input.rawText?.trim().slice(0, MAX_CUSTOM_INSTRUCTION_LEN) || undefined;
  const enabled = input.enabled !== false;

  const existingIdx = payload.rules.findIndex((r) => normalizeInstructionKey(r.content) === normKey);
  const newPriority = payload.nextPriority;
  payload.nextPriority += 1;

  let rule: CustomInstructionRule;
  let created: boolean;
  let bumped: boolean;

  if (existingIdx >= 0) {
    const prev = payload.rules[existingIdx]!;
    rule = {
      ...prev,
      content,
      ...(rawText ? { rawText } : prev.rawText ? { rawText: prev.rawText } : {}),
      topic,
      source,
      enabled,
      priority: newPriority,
      updatedAt: now,
    };
    payload.rules[existingIdx] = rule;
    created = false;
    bumped = true;
  } else {
    rule = {
      id: `inst_${simpleHash(`${normKey}_${newPriority}`)}_${newPriority}`,
      content,
      ...(rawText ? { rawText } : {}),
      topic,
      source,
      enabled,
      priority: newPriority,
      createdAt: now,
      updatedAt: now,
    };
    payload.rules.unshift(rule);
    created = true;
    bumped = false;
  }

  payload.rules.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
  if (payload.rules.length > MAX_CUSTOM_INSTRUCTIONS) {
    payload.rules = payload.rules.slice(0, MAX_CUSTOM_INSTRUCTIONS);
  }
  persistStorePayload(payload);

  const conflicts = detectCustomInstructionConflicts(payload.rules);
  const conflictingRules = payload.rules.filter(
    (r) => r.id !== rule.id && conflicts.get(r.id)?.overriddenById === rule.id,
  );

  return {
    rule,
    created,
    bumped,
    totalCount: payload.rules.length,
    enabledCount: payload.rules.filter((r) => r.enabled).length,
    conflictingRules,
  };
}

export function updateCustomInstruction(
  id: string,
  patch: UpdateCustomInstructionPatch,
): CustomInstructionRule | null {
  const payload = loadStorePayload();
  const idx = payload.rules.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const prev = payload.rules[idx]!;
  const now = Date.now();

  let nextContent = prev.content;
  let contentChanged = false;
  if (patch.content !== undefined) {
    const cleaned = cleanRuleContent(patch.content);
    if (!cleaned) {
      throw new Error("附加指令内容不能为空");
    }
    contentChanged = cleaned !== prev.content;
    nextContent = cleaned;
  }

  const nextTopic =
    patch.topic !== undefined
      ? patch.topic.trim().slice(0, 24) || inferInstructionTopic(nextContent)
      : contentChanged
        ? inferInstructionTopic(nextContent)
        : prev.topic;

  const shouldBump = patch.bumpPriority === true || (contentChanged && patch.bumpPriority !== false);
  const nextPriority = shouldBump ? payload.nextPriority++ : prev.priority;

  const updated: CustomInstructionRule = {
    ...prev,
    content: nextContent,
    topic: nextTopic,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
    priority: nextPriority,
    updatedAt: now,
  };
  payload.rules[idx] = updated;
  persistStorePayload(payload);
  return updated;
}

export function setCustomInstructionEnabled(
  id: string,
  enabled: boolean,
): CustomInstructionRule | null {
  return updateCustomInstruction(id, { enabled: Boolean(enabled), bumpPriority: false });
}

export function deleteCustomInstruction(id: string): CustomInstructionRule | null {
  const payload = loadStorePayload();
  const idx = payload.rules.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const [removed] = payload.rules.splice(idx, 1);
  persistStorePayload(payload);
  return removed ?? null;
}

export function deleteLatestCustomInstruction(): CustomInstructionRule | null {
  const payload = loadStorePayload();
  if (payload.rules.length === 0) return null;
  const [removed] = payload.rules.splice(0, 1);
  persistStorePayload(payload);
  return removed ?? null;
}

export function deleteCustomInstructionsByQuery(query: string): CustomInstructionRule[] {
  const q = query.trim();
  if (!q) return [];
  const payload = loadStorePayload();
  const normQ = normalizeInstructionKey(q);
  const inferredTopic = inferInstructionTopic(q);

  // 1. 优先精确 ID 或内容关键词匹配（例如“删除关于智洗烘的附加指令”只删含“智洗烘”的规则，不误删同主题其他规则）
  const directHits = new Set<string>();
  for (const rule of payload.rules) {
    if (
      rule.id === q ||
      rule.content.includes(q) ||
      (normQ.length > 0 && normalizeInstructionKey(rule.content).includes(normQ)) ||
      rule.topic === q
    ) {
      directHits.add(rule.id);
    }
  }

  // 2. 无直接内容命中时，再按推断主题兜底匹配（例如“删除关于洗衣机的规则”或“删掉洗衣服的规则”）
  if (directHits.size === 0 && inferredTopic !== "通用") {
    for (const rule of payload.rules) {
      if (rule.topic === inferredTopic) {
        directHits.add(rule.id);
      }
    }
  }

  if (directHits.size === 0) return [];

  const matched: CustomInstructionRule[] = [];
  const kept: CustomInstructionRule[] = [];
  for (const rule of payload.rules) {
    if (directHits.has(rule.id)) {
      matched.push(rule);
    } else {
      kept.push(rule);
    }
  }

  payload.rules = kept;
  persistStorePayload(payload);
  return matched;
}

export function clearCustomInstructions(): number {
  const payload = loadStorePayload();
  const count = payload.rules.length;
  if (count === 0) return 0;
  payload.rules = [];
  persistStorePayload(payload);
  return count;
}

// ==================== 语音/自然语言附加指令意图解析 ====================

const RE_CLEAR_INSTRUCTIONS =
  /^(?:请|帮我|帮忙|给我|麻烦)?(?:(?:清空|清除|删光)(?:全部|所有)?|(?:删除|删掉|取消)(?:全部|所有))(?:的)?(?:附加指令|自定义指令|指令规则|偏好规则|自定义规则)(?:吧|呀|哦|了)?$/i;

const RE_DELETE_LATEST_INSTRUCTION =
  /^(?:请|帮我|帮忙|给我|麻烦)?(?:(?:删除|删掉|撤销|取消|移除)(?:最新|最后|刚才|刚刚|上一|刚保存|刚添加)(?:那|这)?(?:一条|条|个)?(?:的)?(?:附加指令|自定义指令|指令规则|偏好规则|规则)|(?:把|将)(?:最新|最后|刚才|刚刚|上一|刚保存|刚添加)(?:那|这)?(?:一条|条|个)?(?:的)?(?:附加指令|自定义指令|指令规则|偏好规则|规则)(?:删除|删掉|撤销|取消|移除))(?:吧|呀|哦|了)?$/i;

const RE_DELETE_MATCH_INSTRUCTION =
  /^(?:请|帮我|帮忙|给我|麻烦)?(?:(?:删除|删掉|移除|取消|忘掉|忘记)(?:关于|有关)?(.+?)(?:那条|这条|的)?(?:附加指令|自定义指令|指令规则|偏好规则|规则)|(?:把|将)(?:关于|有关)?(.+?)(?:那条|这条|的)?(?:附加指令|自定义指令|指令规则|偏好规则|规则)(?:删除|删掉|移除|取消|忘掉))(?:吧|呀|哦|了)?$/i;

const RE_LIST_INSTRUCTIONS =
  /^(?:请|帮我|帮忙|给我|麻烦)?(?:(?:查看|看看|列出|显示|查询|告诉我|念一下)(?:我)?(?:现在|当前)?(?:保存的|已保存的|设置的|所有|全部)?(?:附加指令|自定义指令|指令规则|偏好规则)(?:列表)?|(?:现在|当前|我)?(?:保存了|设置了|有)(?:哪些|什么|几条)(?:附加指令|自定义指令|指令规则|偏好规则)|(?:附加指令|自定义指令|指令规则)(?:列表|有哪些|有什么))(?:吗|呢|吧|呀)?$/i;

const RE_EXPLICIT_SAVE_ZH =
  /^(?:请|帮我|帮忙|给我|麻烦|你可以|帮)?(?:保存|添加|新增|加上|加|记录|记下|写入|设置|设定)(?:一条|一个|新的|新)?(?:附加指令|自定义指令|指令规则|偏好规则|控制规则)[：:，,\s]*(.+)$/i;

const RE_FUTURE_RULE_ZH =
  /^(?:请|帮我|帮忙|给我|麻烦|你)?(?:以后|今后|往后|之后|从现在开始|从今以后|从今往后|以后每次|每次以后|下次开始)[，,：:\s]*(.+)$/i;

const RE_REMEMBER_RULE_ZH =
  /^(?:请|帮我|帮忙|给我|麻烦|你)?(?:记住|记一下|记下来|牢记|切记|记好|别忘了以后|不要忘了以后|记得以后)[，,：:\s]*(.+)$/i;

const RE_EXPLICIT_SAVE_EN =
  /^(?:please\s+)?(?:save|add)\s+(?:a\s+)?(?:new\s+)?(?:custom\s+)?(?:instruction|rule)\s*[:,\-]?\s*(.+)$/i;

const RE_FUTURE_RULE_EN =
  /^(?:please\s+)?(?:remember(?:\s+that|\s+to)?|from\s+now\s+on)\s*[,:]?\s*(.+)$/i;

const RE_RULE_SUBSTANCE_HINT =
  /(?:记得|记住|默认|优先|统一|一律|都要|必须|需要|自动|我说|我让|我叫|我要|我想|只要|如果|当|每次|都用|就用|就开|就关|就调|别|不要|超过|低于|保持|选择|判断|开启|打开|关闭|调到|调成|设为|设置为|洗衣|洗烘|智洗烘|空调|灯|音箱|音响|窗帘|喂食|除湿|模式|温度|湿度|亮度|色温|音量|习惯|规则|指令|always|default|when\s+i\s+say|prefer|mode|temp|light|ac|washer|laundry)/i;

const RE_THIRD_PERSON_OR_QUESTION_REJECT =
  /^(?:别理|别管|不用管|不要管|你记得.*吗|我记得|会下雨吗|天气怎么样|怎么办)/i;

function extractSavedRuleContentFromFuture(raw: string, afterPrefix: string): string {
  // 若是“以后记得洗衣默认用智洗烘模式” -> 提取干净规则 “洗衣默认用智洗烘模式”；
  // 若是“以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。” -> 保留完整条件句式。
  const remMatch = /^(?:你)?(?:要|都|请)?(?:记得|记住|记着|牢记|切记)[，,：:\s]*(.+)$/.exec(
    afterPrefix.trim(),
  );
  if (remMatch?.[1]) {
    const inner = cleanRuleContent(remMatch[1]);
    if (inner.length >= 3) {
      return inner;
    }
  }
  return cleanRuleContent(raw.replace(/^(?:请|帮我|帮忙|给我|麻烦|你)+[，,\s]*/, ""));
}

/**
 * 解析用户的语音或文字语句是否属于「保存 / 查看 / 删除附加指令规则」意图。
 * 严格避免把普通即时设备控制指令（如“打开空调”、“洗衣服”）误判为保存规则。
 */
export function parseCustomInstructionVoiceIntent(
  rawText: string,
): ParsedCustomInstructionIntent | null {
  const trimmed = rawText
    .trim()
    .replace(/^[，,。．.、!！?？:：;；\s]+/, "")
    .replace(/[。！!？?]+$/, "")
    .trim();
  if (trimmed.length < 4) return null;

  if (RE_CLEAR_INSTRUCTIONS.test(trimmed)) {
    return { kind: "clear" };
  }

  if (RE_DELETE_LATEST_INSTRUCTION.test(trimmed)) {
    return { kind: "delete_latest" };
  }

  const delMatch = RE_DELETE_MATCH_INSTRUCTION.exec(trimmed);
  if (delMatch) {
    const query = (delMatch[1] ?? delMatch[2] ?? "").replace(/^(?:一条|那条|这条|所有|全部)+/, "").trim();
    if (query) {
      return { kind: "delete_match", query };
    }
  }

  if (RE_LIST_INSTRUCTIONS.test(trimmed)) {
    const topic = inferInstructionTopic(trimmed);
    return { kind: "list", ...(topic !== "通用" ? { topic } : {}) };
  }

  const explicitZh = RE_EXPLICIT_SAVE_ZH.exec(trimmed);
  if (explicitZh?.[1]) {
    const content = cleanRuleContent(explicitZh[1]);
    if (content.length >= 2) {
      return {
        kind: "save",
        content,
        rawText: rawText.trim(),
        topic: inferInstructionTopic(content),
      };
    }
  }

  const explicitEn = RE_EXPLICIT_SAVE_EN.exec(trimmed);
  if (explicitEn?.[1]) {
    const content = cleanRuleContent(explicitEn[1]);
    if (content.length >= 3) {
      return {
        kind: "save",
        content,
        rawText: rawText.trim(),
        topic: inferInstructionTopic(content),
      };
    }
  }

  const futureZh = RE_FUTURE_RULE_ZH.exec(trimmed);
  if (futureZh?.[1]) {
    const after = futureZh[1].trim();
    if (
      after.length >= 4 &&
      !RE_THIRD_PERSON_OR_QUESTION_REJECT.test(after) &&
      !/[吗嘛么]$/.test(after) &&
      RE_RULE_SUBSTANCE_HINT.test(trimmed)
    ) {
      const content = extractSavedRuleContentFromFuture(trimmed, after);
      if (content.length >= 4) {
        return {
          kind: "save",
          content,
          rawText: rawText.trim(),
          topic: inferInstructionTopic(content),
        };
      }
    }
  }

  const rememberZh = RE_REMEMBER_RULE_ZH.exec(trimmed);
  if (rememberZh?.[1]) {
    const after = rememberZh[1].trim();
    if (
      after.length >= 4 &&
      !/[吗嘛么]$/.test(after) &&
      !RE_THIRD_PERSON_OR_QUESTION_REJECT.test(trimmed) &&
      RE_RULE_SUBSTANCE_HINT.test(after)
    ) {
      const content = cleanRuleContent(after);
      if (content.length >= 4) {
        return {
          kind: "save",
          content,
          rawText: rawText.trim(),
          topic: inferInstructionTopic(content),
        };
      }
    }
  }

  const futureEn = RE_FUTURE_RULE_EN.exec(trimmed);
  if (futureEn?.[1]) {
    const after = futureEn[1].trim();
    if (after.length >= 6 && !/\?$/.test(after) && RE_RULE_SUBSTANCE_HINT.test(trimmed)) {
      const content = cleanRuleContent(after);
      if (content.length >= 6) {
        return {
          kind: "save",
          content,
          rawText: rawText.trim(),
          topic: inferInstructionTopic(content),
        };
      }
    }
  }

  return null;
}

export function isCustomInstructionVoiceCommand(rawText: string): boolean {
  return parseCustomInstructionVoiceIntent(rawText) !== null;
}

// ==================== 规则适用性与冲突裁决（最新优先） ====================

/**
 * 判断某条用户实时控制/查询指令是否受当前已启用的附加指令规则影响。
 * 用于：
 * 1. `preferLocalIntents` 本地快路径开启时，若命中附加指令则回退云端大模型严格按规则执行；
 * 2. 检查历史沉淀 Skill 是否已被更新的附加指令规则覆盖。
 */
export function hasApplicableCustomInstructions(
  userText: string,
  rules: readonly CustomInstructionRule[] = loadEnabledCustomInstructions(),
  legacyExtra = "",
  sinceTimestamp = 0,
): boolean {
  const normUser = normalizeInstructionKey(userText);
  if (!normUser) return false;
  const userTopic = inferInstructionTopic(userText);

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (sinceTimestamp > 0 && rule.updatedAt <= sinceTimestamp) continue;

    // 1. 触发短语直接命中（如规则写“我说打开空调...”，当前说了“打开空调”）
    const triggerKey = extractExplicitTriggerKey(rule.content);
    if (triggerKey) {
      const trig = triggerKey.slice("trigger:".length);
      if (trig.length >= 2 && (normUser.includes(trig) || trig.includes(normUser))) {
        return true;
      }
    }

    // 2. 同设备主题命中（如规则主题为“空调”或“洗衣机”，当前语句也涉及“空调”或“洗衣机”）
    if (userTopic !== "通用" && rule.topic === userTopic) {
      return true;
    }

    // 3. 通用规则（无特定设备主题，如“我说睡了就关客厅和餐厅所有灯”）关键词重合
    if (rule.topic === "通用") {
      const normRule = normalizeInstructionKey(rule.content);
      if (normRule.length >= 2 && (normRule.includes(normUser) || normUser.includes(normRule))) {
        return true;
      }
    }
  }

  const trimmedLegacy = legacyExtra.trim();
  if (trimmedLegacy && sinceTimestamp === 0) {
    const legacyTopic = inferInstructionTopic(trimmedLegacy);
    if (userTopic !== "通用" && legacyTopic === userTopic) {
      return true;
    }
    const legacyTrigger = extractExplicitTriggerKey(trimmedLegacy);
    if (legacyTrigger) {
      const trig = legacyTrigger.slice("trigger:".length);
      if (trig.length >= 2 && (normUser.includes(trig) || trig.includes(normUser))) {
        return true;
      }
    }
  }

  return false;
}

const WASHER_PROGRAM_RULES: ReadonlyArray<{ pattern: RegExp; programKey: string; label: string }> = [
  { pattern: /智洗烘|智能洗烘/, programKey: "smart_wash_dry", label: "智洗烘" },
  { pattern: /空气洗/, programKey: "air_wash", label: "空气洗" },
  { pattern: /筒自洁|桶自洁/, programKey: "drum_clean", label: "筒自洁" },
  { pattern: /单烘干|烘干模式|纯烘干/, programKey: "dry", label: "单烘干" },
  { pattern: /单脱水|脱水模式/, programKey: "spin", label: "单脱水" },
  { pattern: /漂洗脱水/, programKey: "rinse_spin", label: "漂洗脱水" },
  { pattern: /快速洗|快洗|速洗/, programKey: "fast_wash", label: "快洗" },
  { pattern: /轻柔洗|轻柔/, programKey: "delicate", label: "轻柔洗" },
  { pattern: /大件洗|大件/, programKey: "big", label: "大件" },
  { pattern: /羊毛洗|羊毛/, programKey: "wool", label: "羊毛" },
  { pattern: /羽绒服|羽绒/, programKey: "down_jacket", label: "羽绒服" },
  { pattern: /棉麻洗|棉麻/, programKey: "cotton", label: "棉麻" },
  { pattern: /除菌洗|除菌/, programKey: "sterilize", label: "除菌洗" },
  { pattern: /强力洗|强力/, programKey: "heavy", label: "强力洗" },
  { pattern: /婴童洗|婴儿|童装/, programKey: "baby_clothes", label: "婴童洗" },
  { pattern: /混合洗|标准洗|日常洗/, programKey: "mix", label: "混合洗" },
];

/**
 * 按「最新规则优先」解析当前生效的洗衣机默认程序规则。
 * 遍历已启用规则（priority 从高到低），第一条命中洗衣程序偏好的即为生效规则，自动覆盖旧冲突规则。
 */
export function resolveWasherDefaultProgramFromRules(
  rules: readonly CustomInstructionRule[] = loadEnabledCustomInstructions(),
): { programKey: string; label: string; rule: CustomInstructionRule } | null {
  const sorted = [...rules]
    .filter((r) => r.enabled && (r.topic === "洗衣机" || inferInstructionTopic(r.content) === "洗衣机"))
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);

  for (const rule of sorted) {
    for (const def of WASHER_PROGRAM_RULES) {
      if (def.pattern.test(rule.content)) {
        return { programKey: def.programKey, label: def.label, rule };
      }
    }
  }
  return null;
}

export interface ResolvedLightDefaultPreference {
  brightness?: number;
  temperaturePreset?: "warm" | "cool" | "neutral";
  colorTemperature?: number;
  color?: string;
  appliedRuleIds: string[];
}

/**
 * 按「最新规则优先」解析针对指定灯具的默认灯光偏好（亮度 / 色温 / 颜色）。
 * 同一维度（如亮度）以最新规则为准，不同维度（如亮度 + 色温）可合并生效。
 */
export function resolveLightDefaultPreferenceFromRules(
  targetName: string,
  targetRoom: string,
  rules: readonly CustomInstructionRule[] = loadEnabledCustomInstructions(),
): ResolvedLightDefaultPreference | null {
  const sorted = [...rules]
    .filter((r) => r.enabled && (r.topic === "灯光" || inferInstructionTopic(r.content) === "灯光"))
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);

  let brightness: number | undefined;
  let temperaturePreset: "warm" | "cool" | "neutral" | undefined;
  let colorTemperature: number | undefined;
  let color: string | undefined;
  const appliedRuleIds: string[] = [];

  for (const rule of sorted) {
    const ruleRoom = detectRoomScope(rule.content);
    if (
      ruleRoom !== "*" &&
      !targetRoom.includes(ruleRoom) &&
      !targetName.includes(ruleRoom)
    ) {
      continue;
    }

    let used = false;
    if (brightness === undefined) {
      const m =
        /(?:亮度(?:默认|调到|调至|设为|为|不超过|保持在?)?\s*(\d{1,3})\s*%?|默认\s*(\d{1,3})\s*%)/.exec(
          rule.content,
        );
      const rawNum = m?.[1] ?? m?.[2];
      if (rawNum) {
        const val = Number(rawNum);
        if (Number.isFinite(val) && val >= 1 && val <= 100) {
          brightness = Math.round(val);
          used = true;
        }
      }
    }

    if (temperaturePreset === undefined && colorTemperature === undefined) {
      const kMatch = /(\d{4})\s*k/i.exec(rule.content);
      if (kMatch) {
        colorTemperature = Number(kMatch[1]);
        used = true;
      } else if (/(?:暖光|暖色|暖白光)/.test(rule.content)) {
        temperaturePreset = "warm";
        used = true;
      } else if (/(?:冷光|冷色|冷白光|白光)/.test(rule.content)) {
        temperaturePreset = "cool";
        used = true;
      } else if (/(?:自然光|中性光)/.test(rule.content)) {
        temperaturePreset = "neutral";
        used = true;
      }
    }

    if (color === undefined) {
      const cMatch = /(红色|橙色|橘色|黄色|暖黄|绿色|青色|蓝色|紫色|粉色|白色|暖白|冷白|#[0-9a-f]{6})/i.exec(
        rule.content,
      );
      if (cMatch) {
        color = cMatch[1]!;
        used = true;
      }
    }

    if (used) {
      appliedRuleIds.push(rule.id);
    }
  }

  if (appliedRuleIds.length === 0) return null;
  return {
    ...(brightness !== undefined ? { brightness } : {}),
    ...(temperaturePreset !== undefined ? { temperaturePreset } : {}),
    ...(colorTemperature !== undefined ? { colorTemperature } : {}),
    ...(color !== undefined ? { color } : {}),
    appliedRuleIds,
  };
}

// ==================== 系统提示词段拼装 ====================

function formatRuleTimestamp(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function sourceLabelZh(source: CustomInstructionSource): string {
  if (source === "voice") return "语音";
  if (source === "text") return "对话";
  return "手动";
}

/**
 * 构建注入系统提示词的多条用户附加指令段落：
 * - 严格按 priority 从新到旧排序；
 * - 明确声明“多条规则有冲突时，必须严格以最新（序号更小 / 优先级更高）的规则为准”；
 * - 对被更新规则覆盖冲突项的旧规则附加醒目覆盖标注；
 * - 兼容旧版自由文本 systemPromptExtra（优先级低于结构化新规则）。
 */
export function buildCustomInstructionsPromptSection(
  rules: readonly CustomInstructionRule[],
  legacyExtra = "",
  maxItems = 30,
): string {
  const enabled = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
    .slice(0, maxItems);

  const trimmedLegacy = legacyExtra.trim();
  if (enabled.length === 0 && !trimmedLegacy) {
    return "";
  }

  const lines: string[] = [];

  if (enabled.length > 0) {
    const conflicts = detectCustomInstructionConflicts(enabled);
    const rankById = new Map<string, number>();
    enabled.forEach((r, idx) => rankById.set(r.id, idx + 1));

    lines.push(
      `用户附加指令规则（共 ${enabled.length} 条已启用；【冲突裁决铁律】以下规则按保存时间从新到旧排列，序号越小越新、优先级越高。若多条规则之间存在任何冲突或覆盖关系，必须严格执行最新/优先级更高的规则，自动忽略较早规则中与之冲突的部分；互不冲突的规则需同时遵守）：`,
    );

    enabled.forEach((rule, idx) => {
      const rank = idx + 1;
      const recencyTag = rank === 1 ? "最新 · 最高优先" : `优先级 #${rank}`;
      const conflict = conflicts.get(rule.id);
      const conflictTag = conflict
        ? ` | ⚠ 若与上方更新规则 #${rankById.get(conflict.overriddenById) ?? 1} 冲突，必须以 #${rankById.get(conflict.overriddenById) ?? 1} 为准`
        : "";
      lines.push(
        `${rank}. [${recencyTag} | ${formatRuleTimestamp(rule.updatedAt)} | 主题:${rule.topic} | 来源:${sourceLabelZh(rule.source)}${conflictTag}] ${rule.content}`,
      );
    });
  }

  if (trimmedLegacy) {
    if (lines.length > 0) {
      lines.push("");
      lines.push("用户补充附加说明（优先级低于上方最新保存的附加指令规则，冲突时以上方最新规则为准）：");
    } else {
      lines.push("用户附加指令：");
    }
    lines.push(trimmedLegacy);
  }

  return lines.join("\n");
}
