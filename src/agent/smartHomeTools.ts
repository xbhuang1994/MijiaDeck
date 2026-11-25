// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 注册到内置 Pi Agent (@earendil-works/pi-agent-core) 的米家智能家居工具集。
 * 所有工具通过真实的 IMijiaService + JobExecutor 执行设备控制并实时同步回主窗口和 WebSocket。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, bool, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { speakerHint } from "../core/availability.ts";
import type { IJobExecutor, IMijiaService } from "../core/contracts.ts";
import {
  isCamera,
  isLight,
  isSwitch,
  lightControls,
  supportsCardPower,
} from "../core/deviceControls.ts";
import { coercePropWriteValue, deviceCategoryLabel } from "../core/deviceDetailModel.ts";
import { JobExecutor } from "../core/jobs.ts";
import {
  createSceneInfo,
  isSpeaker,
  type ActionInfo,
  type DeviceInfo,
  type PropInfo,
  type SceneInfo,
} from "../core/models.ts";
import { formatMetricsText, ServiceError } from "../core/service.ts";
import type * as settingsStoreModule from "../core/settingsStore.ts";
import { isSensitivePropertyName } from "../core/specZh.ts";
import type { MainWindowController } from "../ui/controllers/mainWindowController.ts";

export interface SmartHomeToolDeps {
  service: IMijiaService;
  jobs: IJobExecutor;
  mainWindow: MainWindowController;
  settingsStore: typeof settingsStoreModule;
  broadcastState: () => void;
}

function runJob<T>(jobs: IJobExecutor, fn: () => T | Promise<T>, priority = 1): Promise<T> {
  if (jobs instanceof JobExecutor && jobs.isClosed) {
    return Promise.reject(new ServiceError("后台任务执行器已关闭"));
  }
  return new Promise<T>((resolve, reject) => {
    jobs.submit(fn, {
      priority,
      onSuccess: (res) => resolve(res),
      onError: (err) => reject(err),
    });
  });
}

function textResult<T = Record<string, unknown>>(
  text: string,
  details: T,
  isError = false,
): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeQuery(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[的\s\-_·.,，。！？!?“”"'`（）()]/g, "");
}

function deviceMatchesCategory(device: DeviceInfo, category: string): boolean {
  const cat = category.trim().toLowerCase();
  if (!cat || cat === "all" || cat === "全部") {
    return true;
  }
  if (cat === "light" || cat === "灯" || cat === "灯光" || cat === "照明") {
    if (isLight(device)) return true;
    // 多路开关子路名称含“灯”时（如餐厅主灯、吧台射灯、餐边灯带）也归类为灯光控制目标
    if (device.switch_channels.length === 0 && /灯/.test(device.name)) {
      return true;
    }
    return false;
  }
  if (cat === "switch" || cat === "开关" || cat === "插座") {
    return isSwitch(device) || device.model.includes("plug") || device.model.includes("outlet");
  }
  if (cat === "sensor" || cat === "传感器" || cat === "温湿度") {
    return (
      (Array.isArray(device.metric_features) && device.metric_features.length > 0) ||
      device.model.includes("sensor") ||
      device.spec_type.includes("sensor")
    );
  }
  if (cat === "speaker" || cat === "音箱" || cat === "音响" || cat === "小爱") {
    return isSpeaker(device);
  }
  if (cat === "camera" || cat === "摄像头" || cat === "摄像机") {
    return isCamera(device);
  }
  if (cat === "feeder" || cat === "喂食器") {
    return device.model.includes("feeder") || device.spec_type.includes("feeder") || device.name.includes("喂食");
  }
  if (cat === "appliance" || cat === "家电") {
    return supportsCardPower(device) && !isLight(device) && !isSwitch(device);
  }
  return deviceCategoryLabel(device).toLowerCase().includes(cat);
}

/**
 * 按 did / 名称 / 房间 / 类别灵活解析目标设备（支持单个精确匹配与多设备筛选）。
 */
export function resolveDevices(
  devices: readonly DeviceInfo[],
  options: { target?: string; room?: string; category?: string; controllableOnly?: boolean } = {},
): DeviceInfo[] {
  const roomFilter = options.room?.trim() ?? "";
  const category = options.category?.trim() ?? "";
  const target = options.target?.trim() ?? "";

  let pool = [...devices];
  if (roomFilter && roomFilter !== "全屋" && roomFilter !== "全部") {
    const normRoom = normalizeQuery(roomFilter);
    pool = pool.filter((d) => {
      const dr = normalizeQuery(d.room_name);
      return dr === normRoom || dr.includes(normRoom) || normRoom.includes(dr);
    });
  }

  if (category && category !== "all" && category !== "全部") {
    pool = pool.filter((d) => deviceMatchesCategory(d, category));
  }

  if (options.controllableOnly) {
    pool = pool.filter(
      (d) =>
        d.switch_channels.length === 0 &&
        (supportsCardPower(d) || isCamera(d)),
    );
  }

  if (!target) {
    return pool;
  }

  // 1. 精确 did 匹配
  const byDid = pool.find((d) => d.did === target);
  if (byDid) return [byDid];

  // 2. 精确名称匹配
  const normTarget = normalizeQuery(target);
  const exactName = pool.filter((d) => normalizeQuery(d.name) === normTarget);
  if (exactName.length > 0) return exactName;

  // 3. 批量关键词（全部/所有灯/房间全部设备）
  const isAllLights = /^(全部|所有|全屋)?(灯光?|电灯|照明)$/.test(normTarget);
  if (isAllLights) {
    return pool.filter((d) => deviceMatchesCategory(d, "light"));
  }
  if (/^(全部|所有|全屋)(设备|开关|电器)?$/.test(normTarget)) {
    return pool;
  }

  // 4. “房间名 + 设备关键词” 组合匹配（如“客厅吸顶灯”、“客厅的灯”、“餐厅所有灯”）
  const scored: Array<{ device: DeviceInfo; score: number }> = [];
  for (const d of pool) {
    const dName = normalizeQuery(d.name);
    const dRoom = normalizeQuery(d.room_name);
    const dCat = normalizeQuery(deviceCategoryLabel(d));
    const combined = `${dRoom}${dName}`;
    let score = 0;

    if (combined === normTarget) {
      score = 100;
    } else if (dName.includes(normTarget)) {
      score = 85;
    } else if (normTarget.includes(dName) && dName.length >= 2) {
      score = 80;
    } else {
      const roomHit = dRoom.length > 0 && normTarget.includes(dRoom);
      const rest = roomHit ? normTarget.replace(dRoom, "").replace(/^(所有|全部)/, "") : normTarget;
      const lightHit =
        (rest === "灯" || rest === "灯光" || rest === "吸顶灯" || rest === "台灯" || rest === "射灯") &&
        deviceMatchesCategory(d, "light");
      const speakerHit =
        (rest.includes("音箱") || rest.includes("小爱") || rest.includes("音响")) && isSpeaker(d);
      const sensorHit =
        (rest.includes("温度") || rest.includes("湿度") || rest.includes("温湿度") || rest.includes("传感器")) &&
        deviceMatchesCategory(d, "sensor");
      const feederHit =
        (rest.includes("喂食") || rest.includes("猫粮") || rest.includes("狗粮") || rest.includes("宠粮")) &&
        deviceMatchesCategory(d, "feeder");
      const cameraHit =
        (rest.includes("摄像") || rest.includes("监控") || rest.includes("相机")) && isCamera(d);

      if (roomHit && (!rest || rest === "设备" || lightHit || speakerHit || sensorHit || feederHit || cameraHit)) {
        score = 75;
      } else if (roomHit && rest.length >= 1 && dName.includes(rest)) {
        score = 82;
      } else if (!roomHit && (lightHit || speakerHit || sensorHit || feederHit || cameraHit)) {
        score = 65;
      } else if (dCat && (dCat.includes(normTarget) || normTarget.includes(dCat))) {
        score = 60;
      }
    }

    if (score > 0) {
      scored.push({ device: d, score });
    }
  }

  if (scored.length === 0) {
    return [];
  }

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]!.score;
  // 若有高分精确/子串命中且明显优于其他候选，则只返回高分组；若是同类批量（如“餐厅所有灯”）返回同分项
  if (topScore >= 80) {
    return scored.filter((s) => s.score >= topScore - 5).map((s) => s.device);
  }
  return scored.filter((s) => s.score === topScore).map((s) => s.device);
}

function resolveSingleDevice(devices: readonly DeviceInfo[], target: string): DeviceInfo | null {
  const matched = resolveDevices(devices, { target });
  if (matched.length === 0) return null;
  // 优先在线设备
  return matched.find((d) => d.online) ?? matched[0] ?? null;
}

function findPowerProp(props: readonly PropInfo[]): PropInfo | null {
  return (
    props.find(
      (p) =>
        p.type === "bool" &&
        p.writable &&
        (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
    ) ?? null
  );
}

const NAMED_COLORS: Readonly<Record<string, number>> = {
  红: 0xff3b30,
  红色: 0xff3b30,
  red: 0xff3b30,
  橙: 0xff9500,
  橙色: 0xff9500,
  橘色: 0xff9500,
  orange: 0xff9500,
  黄: 0xffcc00,
  黄色: 0xffcc00,
  暖黄: 0xffb86c,
  yellow: 0xffcc00,
  绿: 0x34c759,
  绿色: 0x34c759,
  green: 0x34c759,
  青: 0x00c7be,
  青色: 0x00c7be,
  cyan: 0x00c7be,
  蓝: 0x007aff,
  蓝色: 0x007aff,
  blue: 0x007aff,
  紫: 0xaf52de,
  紫色: 0xaf52de,
  purple: 0xaf52de,
  粉: 0xff2d55,
  粉色: 0xff2d55,
  pink: 0xff2d55,
  白: 0xffffff,
  白色: 0xffffff,
  white: 0xffffff,
  暖白: 0xffe4b5,
  冷白: 0xe6f2ff,
};

export function parseColorToRgbInt(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned in NAMED_COLORS) {
    return NAMED_COLORS[cleaned]!;
  }
  const hexMatch = /^#?([0-9a-f]{6})$/i.exec(cleaned);
  if (hexMatch) {
    return Number.parseInt(hexMatch[1]!, 16) & 0xffffff;
  }
  return null;
}

function clampToPropRange(prop: PropInfo, value: number): number {
  let out = value;
  if (prop.range && prop.range.length >= 2) {
    const [low, high, step] = prop.range;
    out = Math.max(low, Math.min(high, out));
    if (step && step > 0) {
      out = low + Math.round((out - low) / step) * step;
      out = Math.max(low, Math.min(high, out));
    }
  }
  return prop.type === "float" ? Number(out.toFixed(2)) : Math.round(out);
}

function formatDeviceSummary(d: DeviceInfo, mw: MainWindowController): Record<string, unknown> {
  const power = mw.knownPower[d.did];
  const metric = mw.metrics[d.did];
  return {
    did: d.did,
    name: d.name,
    room: d.room_name || "未分配房间",
    home: d.home_name || "",
    category: deviceCategoryLabel(d),
    model: d.model,
    online: d.online,
    power: typeof power === "boolean" ? (power ? "on" : "off") : null,
    metrics: metric ?? null,
    light_features: d.light_features,
    switch_channels: d.switch_channels,
  };
}

function ensureAccessReady(deps: SmartHomeToolDeps): string | null {
  const state = deps.mainWindow.accessState();
  if (state === "offline" || state === "unavailable") {
    return "当前网络不可用，无法连接米家设备服务。";
  }
  if (state === "signed_out") {
    return "尚未登录小米账号，请先在 MijiaDeck 中扫码登录后再控制设备。";
  }
  return null;
}

function findSpeakerAudioProps(props: readonly PropInfo[]): {
  volumeProp: PropInfo | null;
  speakerMuteProp: PropInfo | null;
  micMuteProp: PropInfo | null;
} {
  const volumeProp =
    props.find((p) => p.name === "volume" && p.writable) ??
    props.find((p) => p.name.startsWith("volume") && p.writable) ??
    null;

  const speakerMuteProp =
    props.find((p) => p.service === "speaker" && p.name.startsWith("mute") && p.writable) ??
    props.find((p) => p.name === "mute-2" && p.writable) ??
    props.find((p) => p.name === "mute" && p.writable) ??
    props.find((p) => p.name.startsWith("mute") && p.writable && p.name !== "mute-4") ??
    null;

  const micMuteProp =
    props.find((p) => p.service === "microphone" && p.name.startsWith("mute") && p.writable) ??
    props.find((p) => p.name === "mute-4" && p.writable) ??
    null;

  return { volumeProp, speakerMuteProp, micMuteProp };
}

function formatPropUnitSuffix(unit?: string | null): string {
  if (unit === "celsius") return "°C";
  if (unit === "percentage") return "%";
  if (unit === "kelvin") return "K";
  return unit ? ` ${unit}` : "";
}

function joinDeviceLabel(name: string, tail: string): string {
  if (!tail) return name;
  const needsSpace = /[A-Za-z0-9]$/.test(name) || /^[A-Za-z0-9]/.test(tail);
  return needsSpace ? `${name} ${tail}` : `${name}${tail}`;
}

function formatDeviceDetailUiSummary(
  device: DeviceInfo,
  values: Record<string, unknown>,
  props: readonly PropInfo[],
): string {
  if (!device.online) {
    return joinDeviceLabel(device.name, "离线");
  }

  const temp = values["temperature"];
  const hum = values["relative-humidity"] ?? values["humidity"];
  const bat = values["battery-level"] ?? values["battery"];
  if (typeof temp === "number" || typeof hum === "number") {
    const sensorParts: string[] = [];
    if (typeof temp === "number") sensorParts.push(`${temp}°C`);
    if (typeof hum === "number") sensorParts.push(`湿度 ${hum}%`);
    if (typeof bat === "number" && bat < 20) sensorParts.push(`电量 ${bat}%`);
    return `${device.name} ${sensorParts.join("，")}`;
  }

  const hasLightVal =
    isLight(device) ||
    typeof values["brightness"] === "number" ||
    typeof values["color-temperature"] === "number";
  if (hasLightVal && typeof values["on"] === "boolean") {
    if (!values["on"]) {
      return joinDeviceLabel(device.name, "已关");
    }
    const parts: string[] = [];
    if (typeof values["brightness"] === "number") parts.push(`亮度 ${values["brightness"]}%`);
    if (typeof values["color-temperature"] === "number") parts.push(`${values["color-temperature"]}K`);
    return parts.length > 0
      ? joinDeviceLabel(device.name, `已开，${parts.join("，")}`)
      : joinDeviceLabel(device.name, "已开");
  }

  if (isSpeaker(device)) {
    const parts: string[] = [];
    if (typeof values["volume"] === "number") parts.push(`音量 ${values["volume"]}%`);
    const muted = values["mute"] === true || values["mute-2"] === true;
    if (muted) parts.push("已静音");
    return parts.length > 0 ? `${device.name} ${parts.join("，")}` : joinDeviceLabel(device.name, "在线");
  }

  if (typeof values["on"] === "boolean") {
    return joinDeviceLabel(device.name, values["on"] ? "已开" : "已关");
  }

  const propParts: string[] = [];
  for (const p of props) {
    if (isSensitivePropertyName(p.name)) continue;
    const val = values[p.name];
    if (val === undefined || val === null) continue;
    let formatted: string;
    if (typeof val === "boolean") {
      formatted = val ? "开" : "关";
    } else if (p.value_list) {
      const optItem = p.value_list.find((o) => o.value === val);
      formatted = optItem?.desc_zh_cn ?? optItem?.description ?? String(val);
    } else {
      formatted = `${String(val)}${formatPropUnitSuffix(p.unit)}`;
    }
    propParts.push(`${p.desc || p.name} ${formatted}`);
    if (propParts.length >= 2) break;
  }

  return propParts.length > 0
    ? `${device.name} ${propParts.join("，")}`
    : joinDeviceLabel(device.name, "在线");
}

function formatListUiSummary(names: readonly string[], unitLabel: string): string {
  if (names.length === 0) return `未找到${unitLabel}`;
  if (names.length <= 4) {
    return `共 ${names.length} ${unitLabel}：${names.join("、")}`;
  }
  return `共 ${names.length} ${unitLabel}：${names.slice(0, 3).join("、")}等`;
}

function findSpeakerPlaybackAction(
  actions: readonly ActionInfo[],
  target: "play" | "pause" | "stop" | "next" | "previous",
): ActionInfo | null {
  return (
    actions.find((a) => a.name === target && (!a.service || a.service === "play-control")) ??
    actions.find((a) => a.name === target) ??
    actions.find(
      (a) => a.service === "play-control" && a.name.replace(/-\d+$/, "") === target,
    ) ??
    null
  );
}

async function executeSpeakerPlayback(
  deps: SmartHomeToolDeps,
  did: string,
  actions: readonly ActionInfo[],
  pb: "play" | "pause" | "stop" | "next" | "previous",
): Promise<void> {
  // 兼容极简 mock（detail.actions 为空时直接透传动作名）
  if (actions.length === 0) {
    await runJob(deps.jobs, () => deps.service.runAction(did, pb), 1);
    return;
  }

  const primary = findSpeakerPlaybackAction(actions, pb);
  const fallbackAction =
    pb === "stop"
      ? findSpeakerPlaybackAction(actions, "pause")
      : pb === "pause"
        ? findSpeakerPlaybackAction(actions, "stop")
        : null;

  if (primary) {
    try {
      await runJob(deps.jobs, () => deps.service.runAction(did, primary.name), 1);
      return;
    } catch (err) {
      if (fallbackAction && fallbackAction.name !== primary.name) {
        await runJob(deps.jobs, () => deps.service.runAction(did, fallbackAction.name), 1);
        return;
      }
      throw err;
    }
  }

  if (fallbackAction) {
    await runJob(deps.jobs, () => deps.service.runAction(did, fallbackAction.name), 1);
    return;
  }

  // 部分音箱型号规格未暴露 stop/pause 时，通过静默文本指令兜底
  if (
    (pb === "stop" || pb === "pause") &&
    actions.some((a) => a.name === "execute-text-directive")
  ) {
    const directive = pb === "stop" ? "停止播放" : "暂停播放";
    await runJob(
      deps.jobs,
      () => deps.service.runAction(did, "execute-text-directive", [directive, 1]),
      1,
    );
    return;
  }

  await runJob(deps.jobs, () => deps.service.runAction(did, pb), 1);
}

async function applySpeakerPower(
  deps: SmartHomeToolDeps,
  device: DeviceInfo,
  state: "on" | "off" | "toggle",
): Promise<{ on: boolean; note: string; values: Record<string, unknown> }> {
  const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
  const { speakerMuteProp } = findSpeakerAudioProps(detail.props);

  let targetOn: boolean;
  if (state === "toggle") {
    let currentlyMuted = false;
    if (speakerMuteProp?.readable) {
      try {
        const vals = await runJob(
          deps.jobs,
          () => deps.service.readProps(device.did, [speakerMuteProp.name]),
          2,
        );
        currentlyMuted = vals[speakerMuteProp.name] === true;
      } catch {
        currentlyMuted = false;
      }
    }
    targetOn = currentlyMuted;
  } else {
    targetOn = state === "on";
  }

  let paused = false;
  let muted = false;
  if (!targetOn) {
    // 关闭小爱音箱：暂停/停止播放并开启扬声器静音（智能音箱无物理断电开关，采用暂停+静音待机）
    const pauseAction =
      findSpeakerPlaybackAction(detail.actions, "pause") ??
      findSpeakerPlaybackAction(detail.actions, "stop");
    if (pauseAction) {
      try {
        await runJob(deps.jobs, () => deps.service.runAction(device.did, pauseAction.name), 1);
        paused = true;
      } catch {
        // 未在播放时暂停可能报错，不阻断静音
      }
    }
    if (speakerMuteProp) {
      await runJob(deps.jobs, () => deps.service.writeProp(device.did, speakerMuteProp.name, true), 1);
      muted = true;
    }
  } else {
    // 打开小爱音箱：解除扬声器静音，并唤醒/恢复
    if (speakerMuteProp) {
      await runJob(deps.jobs, () => deps.service.writeProp(device.did, speakerMuteProp.name, false), 1);
    }
    const wakeAction =
      detail.actions.find((a) => a.name === "wake-up") ??
      detail.actions.find((a) => a.name === "play");
    if (wakeAction) {
      try {
        await runJob(deps.jobs, () => deps.service.runAction(device.did, wakeAction.name), 1);
      } catch {
        // 唤醒或播放失败不影响取消静音成功
      }
    }
  }

  let values: Record<string, unknown> = {};
  const toRead = ["volume", speakerMuteProp?.name, "playing-state"].filter((n): n is string => Boolean(n));
  if (toRead.length > 0) {
    try {
      values = await runJob(deps.jobs, () => deps.service.readProps(device.did, toRead), 2);
    } catch {
      values = {};
    }
  }

  if (deps.mainWindow.tray) {
    deps.mainWindow.tray.refreshAudioAfterCommand(device.did);
  }
  const note = targetOn
    ? "已唤醒"
    : muted && paused
      ? "已静音暂停"
      : muted
        ? "已静音"
        : paused
          ? "已暂停"
          : "已静音暂停";
  return { on: targetOn, note, values };
}

/**
 * 构建完整智能家居 Pi Agent 工具列表。
 */
export function createSmartHomeTools(deps: SmartHomeToolDeps): AgentTool<any>[] {
  const listDevicesTool: AgentTool<any> = {
    name: "list_devices",
    label: "查看设备列表",
    description:
      "查询 MijiaDeck 中已同步的智能设备列表，支持按房间、家庭、名称关键词、设备类型或在线状态过滤。",
    parameters: obj({
      room: opt(str({ description: "房间名称过滤，例如：客厅、卧室、餐厅、阳台" })),
      home: opt(str({ description: "家庭名称过滤（可选）" })),
      keyword: opt(str({ description: "设备名称或型号关键词（可选）" })),
      category: opt(
        oneOf(["all", "light", "switch", "sensor", "speaker", "camera", "feeder", "appliance"] as const, {
          description: "设备类型筛选",
        }),
      ),
      online_only: opt(bool({ description: "是否仅返回在线设备" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let list = deps.mainWindow.allDevices;
      if (params.home) {
        const h = normalizeQuery(params.home);
        list = list.filter((d) => normalizeQuery(d.home_name).includes(h));
      }
      list = resolveDevices(list, {
        target: params.keyword,
        room: params.room,
        category: params.category,
      });
      if (params.online_only) {
        list = list.filter((d) => d.online);
      }
      const items = list.map((d) => formatDeviceSummary(d, deps.mainWindow));
      const uiSummary =
        items.length === 0
          ? "未找到匹配设备"
          : formatListUiSummary(
              items.map((it) => String(it.name)),
              "台",
            );
      const summary =
        items.length === 0
          ? "未找到符合条件的智能设备。"
          : `共找到 ${items.length} 台设备：\n` +
            items
              .map(
                (it) =>
                  `- ${it.name}（${it.room} · ${it.category} · ${it.online ? "在线" : "离线"}${
                    it.power ? ` · 开关:${it.power === "on" ? "开" : "关"}` : ""
                  }${it.metrics ? ` · ${it.metrics}` : ""}）[did=${it.did}]`,
              )
              .join("\n");
      return textResult(summary, { ok: true, count: items.length, devices: items, uiSummary });
    },
  };

  const getDeviceDetailTool: AgentTool<any> = {
    name: "get_device_detail",
    label: "读取设备详情与状态",
    description:
      "读取指定设备的完整实时状态、温湿度/电量等传感器读数、可写属性和可执行动作列表。",
    parameters: obj({
      target: str({ description: "设备 did 或设备名称（支持模糊匹配，如“卧室米家温湿度计”、“客厅吸顶灯”）" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const device = resolveSingleDevice(deps.mainWindow.allDevices, params.target);
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const readableNames = detail.props
        .filter((p) => p.readable && !isSensitivePropertyName(p.name))
        .map((p) => p.name);

      let values: Record<string, unknown> = {};
      if (device.online && readableNames.length > 0) {
        try {
          values = await runJob(deps.jobs, () => deps.service.readProps(device.did, readableNames), 2);
        } catch {
          values = {};
        }
      }

      // 同步回主窗口状态
      let mutated = false;
      const powerProp = findPowerProp(detail.props);
      if (powerProp && typeof values[powerProp.name] === "boolean") {
        const nextPower = values[powerProp.name] as boolean;
        if (deps.mainWindow.knownPower[device.did] !== nextPower) {
          deps.mainWindow.applyPowerState(device.did, nextPower);
          deps.mainWindow.updateTrayDevices();
          mutated = true;
        }
      }
      const freshMetrics = formatMetricsText(
        values["temperature"],
        values["relative-humidity"] ?? values["humidity"],
      );
      if (freshMetrics && deps.mainWindow.metrics[device.did] !== freshMetrics) {
        deps.mainWindow.metrics[device.did] = freshMetrics;
        mutated = true;
      }
      if (mutated) {
        deps.broadcastState();
      }

      const readableLines = detail.props
        .filter((p) => !isSensitivePropertyName(p.name))
        .map((p) => {
          const val = values[p.name];
          let formattedVal = val === undefined || val === null ? "—" : String(val);
          if (p.value_list && val !== undefined && val !== null) {
            const matchedOpt = p.value_list.find((optItem) => optItem.value === val);
            if (matchedOpt) {
              formattedVal = `${matchedOpt.desc_zh_cn ?? matchedOpt.description ?? val}(${val})`;
            }
          }
          if (typeof val === "boolean") {
            formattedVal = val ? "开启" : "关闭";
          }
          const unit =
            p.unit === "celsius"
              ? "°C"
              : p.unit === "percentage"
                ? "%"
                : p.unit === "kelvin"
                  ? "K"
                  : p.unit
                    ? ` ${p.unit}`
                    : "";
          return `- ${p.desc || p.name} (${p.name}): ${formattedVal}${unit}${p.writable ? " [可写]" : ""}`;
        });

      const actionLines = detail.actions.map(
        (a) => `- ${a.desc || a.name} (${a.name})${a.in?.length ? ` 参数: ${a.in.map((i) => `${i.desc || i.name}:${i.type}`).join(", ")}` : ""}`,
      );

      const publicProps = detail.props.filter((p) => !isSensitivePropertyName(p.name));
      const uiSummary = formatDeviceDetailUiSummary(device, values, publicProps);

      const text = [
        `设备：${device.name}（${device.room_name} · ${deviceCategoryLabel(device)} · ${device.online ? "在线" : "离线"}）[did=${device.did}]`,
        readableLines.length > 0 ? `属性状态：\n${readableLines.join("\n")}` : "无公开属性。",
        actionLines.length > 0 ? `可执行动作：\n${actionLines.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return textResult(text, {
        ok: true,
        did: device.did,
        name: device.name,
        room: device.room_name,
        category: deviceCategoryLabel(device),
        online: device.online,
        values,
        props: publicProps,
        actions: detail.actions,
        uiSummary,
      });
    },
  };

    const setDevicePowerTool: AgentTool<any> = {
    name: "set_device_power",
    label: "开关设备",
    description:
      "打开、关闭或切换一个或多个智能设备的电源开关。支持按设备名、did、房间或设备类别（如关闭餐厅所有灯）批量操作；若目标为小爱/小米音箱，会自动切换音箱播放与静音待机状态。",
    parameters: obj({
      state: oneOf(["on", "off", "toggle"] as const, {
        description: "目标开关状态：on 打开、off 关闭、toggle 切换",
      }),
      target: opt(str({ description: "目标设备名称、did 或关键词，例如：客厅吸顶灯、餐厅主灯、小米音箱、全部灯" })),
      room: opt(str({ description: "可选房间名，例如：客厅、餐厅、卧室" })),
      category: opt(
        oneOf(["all", "light", "switch", "appliance", "camera", "speaker"] as const, {
          description: "可选类别过滤，批量开关时推荐使用",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let candidates = resolveDevices(deps.mainWindow.allDevices, {
        target: params.target,
        room: params.room,
        category: params.category,
        controllableOnly: true,
      });

      // 若用户明确点名了音箱/音响（如“关闭小米音响”、“打开小爱音箱”），允许通过软开关控制音箱（关闭=暂停+静音，打开=取消静音+播放/唤醒）
      if (candidates.length === 0 && (params.target || params.category === "speaker")) {
        const speakerCandidates = resolveDevices(deps.mainWindow.allDevices, {
          target: params.target,
          room: params.room,
          category: "speaker",
        }).filter((d) => isSpeaker(d));
        if (speakerCandidates.length > 0) {
          candidates = speakerCandidates;
        }
      }

      if (candidates.length === 0) {
        const desc = [params.room, params.target, params.category].filter(Boolean).join(" ") || "指定条件";
        const msg = `未找到可控设备：${desc}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const succeeded: Array<{ did: string; name: string; state: boolean; note?: string }> = [];
      const failed: Array<{ did: string; name: string; reason: string }> = [];

      for (const dev of candidates) {
        if (!dev.online) {
          failed.push({ did: dev.did, name: dev.name, reason: "离线" });
          continue;
        }
        try {
          if (isSpeaker(dev)) {
            const spRes = await applySpeakerPower(deps, dev, params.state);
            succeeded.push({ did: dev.did, name: dev.name, state: spRes.on, note: spRes.note });
            continue;
          }
          let newState: boolean;
          if (params.state === "toggle") {
            newState = await runJob(deps.jobs, () => deps.service.togglePower(dev.did), 1);
          } else {
            const targetBool = params.state === "on";
            await runJob(deps.jobs, () => deps.service.setPowerState(dev.did, targetBool), 1);
            newState = targetBool;
          }
          deps.mainWindow.applyPowerState(dev.did, newState);
          succeeded.push({ did: dev.did, name: dev.name, state: newState });
        } catch (err) {
          failed.push({
            did: dev.did,
            name: dev.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (succeeded.length > 0) {
        deps.mainWindow.updateTrayDevices();
        deps.broadcastState();
      }

      let okSummary = "";
      if (succeeded.length === 1) {
        const s = succeeded[0]!;
        okSummary = s.note ? `${s.name} ${s.note}` : joinDeviceLabel(s.name, s.state ? "已开" : "已关");
      } else if (succeeded.length > 1) {
        const allPlain = succeeded.every((s) => !s.note);
        const allSameState = succeeded.every((s) => s.state === succeeded[0]!.state);
        if (allPlain && allSameState) {
          const verb = succeeded[0]!.state ? "已开" : "已关";
          if (succeeded.length <= 3) {
            okSummary = `${verb}：${succeeded.map((s) => s.name).join("、")}`;
          } else {
            okSummary = `${verb} ${succeeded.length} 台（${succeeded.slice(0, 3).map((s) => s.name).join("、")}等）`;
          }
        } else {
          const itemLabels = succeeded.map((s) =>
            s.note ? `${s.name} ${s.note}` : joinDeviceLabel(s.name, s.state ? "已开" : "已关"),
          );
          okSummary =
            itemLabels.length <= 3
              ? itemLabels.join("，")
              : `${itemLabels.slice(0, 3).join("，")}等 ${itemLabels.length} 台`;
        }
      }

      const failSummary = failed
        .map((f) =>
          f.reason === "离线" || f.reason === "设备已离线"
            ? joinDeviceLabel(f.name, "离线")
            : `${f.name}失败（${f.reason}）`,
        )
        .join("，");

      const summary = [okSummary, failSummary].filter(Boolean).join("；") || "未执行任何开关操作";

      return textResult(
        summary,
        {
          ok: succeeded.length > 0,
          succeeded,
          failed,
          ...(params.room ? { room: params.room } : {}),
          ...(params.category ? { category: params.category } : {}),
          uiSummary: summary,
        },
        succeeded.length === 0,
      );
    },
  };

  const controlLightTool: AgentTool<any> = {
    name: "control_light",
    label: "调光调色控制",
    description:
      "调节智能灯具的开关、亮度（1-100%）、色温（开尔文 K 或 warm/neutral/cool）、颜色（#RRGGBB 或中文颜色名）或灯光模式。",
    parameters: obj({
      target: str({ description: "目标灯具的 did 或名称，例如：客厅吸顶灯" }),
      on: opt(bool({ description: "是否开启或关闭灯光" })),
      brightness: opt(num({ description: "目标亮度百分比（1-100）", minimum: 1, maximum: 100 })),
      color_temperature: opt(num({ description: "目标色温（K），常见范围 2700-6500" })),
      temperature_preset: opt(
        oneOf(["warm", "neutral", "cool"] as const, {
          description: "快捷色温预设：warm 暖光(~3000K)、neutral 自然光(~4300K)、cool 冷白光(~6000K)",
        }),
      ),
      color: opt(str({ description: "目标颜色，支持 #RRGGBB 或中文/英文颜色名（如 红色、蓝色、暖白）" })),
      mode: opt(str({ description: "灯光模式名称或编号（如 日光、月光、阅读、影院）" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const device = resolveSingleDevice(
        deps.mainWindow.allDevices.filter((d) => isLight(d)),
        params.target,
      ) ?? resolveSingleDevice(deps.mainWindow.allDevices, params.target);

      if (!device) {
        const msg = `未找到灯具：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法调节`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const controls = lightControls(detail.props);
      const powerProp = findPowerProp(detail.props);
      const changes: string[] = [];

      // 若指定调亮度/色温/颜色/模式且未明确要求关灯，先确保开灯
      const hasVisualAdjust =
        params.brightness !== undefined ||
        params.color_temperature !== undefined ||
        params.temperature_preset !== undefined ||
        params.color !== undefined ||
        params.mode !== undefined;

      if (params.on === false) {
        await runJob(deps.jobs, () => deps.service.setPowerState(device.did, false), 1);
        deps.mainWindow.applyPowerState(device.did, false);
        deps.mainWindow.updateTrayDevices();
        deps.broadcastState();
        const msg = joinDeviceLabel(device.name, "已关");
        return textResult(msg, { ok: true, did: device.did, name: device.name, on: false, uiSummary: msg });
      }

      let turnedOn = false;
      if (params.on === true || (hasVisualAdjust && deps.mainWindow.knownPower[device.did] === false)) {
        await runJob(deps.jobs, () => deps.service.setPowerState(device.did, true), 1);
        deps.mainWindow.applyPowerState(device.did, true);
        turnedOn = true;
      }

      let appliedBrightness: number | undefined;
      if (params.brightness !== undefined) {
        const bProp = controls.brightness;
        if (!bProp) {
          const msg = `${device.name}不支持亮度调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        const high = bProp.range && bProp.range.length >= 2 ? bProp.range[1] : 100;
        const scaled = high === 100 ? params.brightness : (params.brightness / 100) * high;
        const val = clampToPropRange(bProp, scaled);
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, bProp.name, val), 1);
        appliedBrightness = Math.round(params.brightness);
        changes.push(`亮度 ${appliedBrightness}%`);
      }

      let appliedColorTemp: number | undefined;
      if (params.color_temperature !== undefined || params.temperature_preset !== undefined) {
        const tProp = controls.temperature;
        if (!tProp) {
          const msg = `${device.name}不支持色温调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        const low = tProp.range && tProp.range.length >= 2 ? tProp.range[0] : 2700;
        const high = tProp.range && tProp.range.length >= 2 ? tProp.range[1] : 6500;
        let targetK = params.color_temperature;
        if (targetK === undefined) {
          if (params.temperature_preset === "warm") targetK = Math.round(low + (high - low) * 0.12);
          else if (params.temperature_preset === "cool") targetK = Math.round(low + (high - low) * 0.88);
          else targetK = Math.round((low + high) / 2);
        }
        const val = clampToPropRange(tProp, targetK);
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, tProp.name, val), 1);
        appliedColorTemp = val;
        changes.push(`色温 ${val}K`);
      }

      let appliedColor: string | undefined;
      if (params.color !== undefined) {
        const cProp = controls.color;
        if (!cProp) {
          const msg = `${device.name}不支持颜色调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        const rgb = parseColorToRgbInt(params.color);
        if (rgb === null) {
          const msg = `无法识别颜色：${params.color}，请使用常见颜色名或 #RRGGBB`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, cProp.name, rgb), 1);
        appliedColor = params.color;
        changes.push(`颜色 ${params.color}`);
      }

      let appliedModeLabel: string | undefined;
      if (params.mode !== undefined) {
        const modeProp = detail.props.find((p) => p.name === "mode" && p.writable);
        if (modeProp) {
          let modeVal: number | string = params.mode;
          if (modeProp.value_list) {
            const normMode = normalizeQuery(params.mode);
            const found = modeProp.value_list.find(
              (o) =>
                String(o.value) === params.mode.trim() ||
                normalizeQuery(o.desc_zh_cn ?? "").includes(normMode) ||
                normalizeQuery(o.description ?? "").includes(normMode),
            );
            if (found) modeVal = found.value;
          }
          const coerced = coercePropWriteValue(modeProp, modeVal);
          if (coerced.ok) {
            await runJob(deps.jobs, () => deps.service.writeProp(device.did, modeProp.name, coerced.value), 1);
            const modeLabel = params.mode.endsWith("模式") ? params.mode : `${params.mode}模式`;
            appliedModeLabel = modeLabel;
            changes.push(modeLabel);
          }
        }
      }

      // 回读灯光状态并广播
      const toRead = [powerProp?.name, controls.brightness?.name, controls.temperature?.name, controls.color?.name].filter(
        (n): n is string => Boolean(n),
      );
      let readback: Record<string, unknown> = {};
      if (toRead.length > 0) {
        try {
          readback = await runJob(deps.jobs, () => deps.service.readProps(device.did, toRead), 2);
          if (powerProp && typeof readback[powerProp.name] === "boolean") {
            deps.mainWindow.applyPowerState(device.did, readback[powerProp.name] as boolean);
          }
        } catch {
          // ignore readback failure
        }
      }
      deps.mainWindow.updateTrayDevices();
      deps.broadcastState();

      const allChanges = turnedOn ? ["已开", ...changes] : changes;
      const msg =
        turnedOn && changes.length > 0
          ? joinDeviceLabel(device.name, `已开，${changes.join("，")}`)
          : turnedOn
            ? joinDeviceLabel(device.name, "已开")
            : changes.length > 0
              ? joinDeviceLabel(device.name, changes.join("，"))
              : `${device.name}未指定调节参数`;
      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        turnedOn,
        ...(appliedBrightness !== undefined ? { brightness: appliedBrightness } : {}),
        ...(params.temperature_preset !== undefined ? { temperaturePreset: params.temperature_preset } : {}),
        ...(appliedColorTemp !== undefined ? { colorTemperature: appliedColorTemp } : {}),
        ...(appliedColor !== undefined ? { color: appliedColor } : {}),
        ...(appliedModeLabel !== undefined ? { mode: appliedModeLabel } : {}),
        changes: allChanges,
        values: readback,
        uiSummary: msg,
      });
    },
  };

  const setDevicePropertyTool: AgentTool<any> = {
    name: "set_device_property",
    label: "设置设备属性",
    description:
      "修改任意智能设备的可写 MIoT 属性（如音箱音量 volume、静音 mute、空调目标温度、风扇档位、定时倒计时等）。",
    parameters: obj({
      target: str({ description: "设备 did 或名称" }),
      property: str({ description: "属性名（如 volume、mute、mode）或中文描述（如 音量、静音）" }),
      value: unknown({ description: "要设置的属性值（布尔、数值或字符串）" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const device = resolveSingleDevice(deps.mainWindow.allDevices, params.target);
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法设置属性`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const rawKey = params.property.trim();
      const normKey = normalizeQuery(rawKey);
      let prop: PropInfo | undefined;
      if (isSpeaker(device) && (normKey === "mute" || normKey === "静音" || normKey === "扬声器静音")) {
        prop = findSpeakerAudioProps(detail.props).speakerMuteProp ?? undefined;
      } else if (isSpeaker(device) && (normKey === "micmute" || normKey === "麦克风静音" || normKey === "闭麦")) {
        prop = findSpeakerAudioProps(detail.props).micMuteProp ?? undefined;
      }
      if (!prop) {
        prop =
          detail.props.find((p) => p.name === rawKey || p.name === rawKey.replaceAll("_", "-")) ??
          detail.props.find((p) => p.writable && (normalizeQuery(p.name) === normKey || normalizeQuery(p.desc) === normKey)) ??
          detail.props.find((p) => p.writable && (normalizeQuery(p.desc).includes(normKey) || normalizeQuery(p.name).includes(normKey)));
      }

      if (!prop) {
        const msg = `${device.name}未找到可写属性：${rawKey}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      let rawVal = params.value;
      // 支持按中文枚举描述匹配 value_list
      if (prop.value_list && typeof rawVal === "string") {
        const normVal = normalizeQuery(rawVal);
        const optHit = prop.value_list.find(
          (o) =>
            normalizeQuery(o.desc_zh_cn ?? "") === normVal ||
            normalizeQuery(o.description ?? "") === normVal,
        );
        if (optHit) {
          rawVal = optHit.value;
        }
      }

      const coerced = coercePropWriteValue(prop, rawVal);
      if (!coerced.ok) {
        const msg = `属性 ${prop.desc || prop.name} 参数无效：${coerced.error}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      await runJob(deps.jobs, () => deps.service.writeProp(device.did, prop.name, coerced.value), 1);

      const powerProp = findPowerProp(detail.props);
      if (powerProp && prop.name === powerProp.name && typeof coerced.value === "boolean") {
        deps.mainWindow.applyPowerState(device.did, coerced.value);
        deps.mainWindow.updateTrayDevices();
      }
      if (deps.mainWindow.tray && deps.mainWindow.tray.quick.audioBar.did === device.did) {
        deps.mainWindow.tray.quick.audioBar.refreshAfterCommand(device.did);
      }
      deps.broadcastState();

      let displayVal: string;
      if (typeof coerced.value === "boolean") {
        displayVal = coerced.value ? "开" : "关";
      } else if (prop.value_list) {
        const matchedOpt = prop.value_list.find((o) => o.value === coerced.value);
        displayVal =
          matchedOpt?.desc_zh_cn ??
          matchedOpt?.description ??
          `${String(coerced.value)}${formatPropUnitSuffix(prop.unit)}`;
      } else {
        displayVal = `${String(coerced.value)}${formatPropUnitSuffix(prop.unit)}`;
      }
      const msg = joinDeviceLabel(device.name, `${prop.desc || prop.name}已设为 ${displayVal}`);

      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        property: prop.name,
        propLabel: prop.desc || prop.name,
        value: coerced.value,
        displayVal,
        uiSummary: msg,
      });
    },
  };

  const runDeviceActionTool: AgentTool<any> = {
    name: "run_device_action",
    label: "执行设备动作",
    description:
      "执行智能设备的 MIoT 动作，例如宠物喂食器出粮（pet-food-out）、音箱播放/暂停/上一首/下一首/朗读文本、灯具延时关灯等。",
    parameters: obj({
      target: str({ description: "设备 did 或名称" }),
      action: str({ description: "动作名（如 pet-food-out、play、pause、next、previous、play-text）或中文描述（如 立即出粮、暂停、下一首）" }),
      params: opt(arr(unknown(), { description: "可选动作参数数组，例如出粮份数 [2] 或朗读文本 [\"你好\"]" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const device = resolveSingleDevice(deps.mainWindow.allDevices, params.target);
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法执行`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const rawAction = params.action.trim();
      const normAct = normalizeQuery(rawAction);
      const matched =
        detail.actions.find((a) => a.name === rawAction || a.name === rawAction.replaceAll("_", "-")) ??
        detail.actions.find(
          (a) =>
            normalizeQuery(a.desc) === normAct ||
            normalizeQuery(a.desc).includes(normAct) ||
            normalizeQuery(a.name).includes(normAct),
        );

      const actionName = matched?.name ?? rawAction;
      const actionLabel = matched?.desc || actionName;
      await runJob(deps.jobs, () => deps.service.runAction(device.did, actionName, params.params), 1);

      if (deps.mainWindow.tray && deps.mainWindow.tray.quick.audioBar.did === device.did) {
        deps.mainWindow.tray.quick.audioBar.refreshAfterCommand(device.did);
      }
      deps.broadcastState();

      const isFeederAction = actionName === "pet-food-out" || normAct.includes("出粮");
      let msg: string;
      if (isFeederAction) {
        const portions = params.params?.[0];
        msg =
          portions !== undefined && portions !== null
            ? joinDeviceLabel(device.name, `已出粮 ${portions} 份`)
            : joinDeviceLabel(device.name, "已出粮");
      } else {
        const paramNote =
          params.params && params.params.length > 0 ? `（${params.params.join("、")}）` : "";
        msg = joinDeviceLabel(device.name, `已执行${actionLabel}${paramNote}`);
      }
      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        action: actionName,
        actionLabel,
        isFeederAction,
        params: params.params ?? [],
        uiSummary: msg,
      });
    },
  };

  const listScenesTool: AgentTool<any> = {
    name: "list_scenes",
    label: "查看手动场景",
    description: "列出米家 APP 中同步的手动场景列表，可用于确认场景名称后执行。",
    parameters: obj({
      home: opt(str({ description: "可选家庭名称筛选" })),
      keyword: opt(str({ description: "可选场景名称关键词" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let scenes: SceneInfo[] = deps.mainWindow.scenes ? [...deps.mainWindow.scenes] : [];
      if (scenes.length === 0) {
        try {
          scenes = await runJob(deps.jobs, () => deps.service.sceneList(), 2);
        } catch {
          scenes = [];
        }
      }
      if (params.home) {
        const h = normalizeQuery(params.home);
        scenes = scenes.filter((s) => normalizeQuery(s.home_name).includes(h));
      }
      if (params.keyword) {
        const kw = normalizeQuery(params.keyword);
        scenes = scenes.filter((s) => normalizeQuery(s.name).includes(kw));
      }

      const uiSummary =
        scenes.length === 0
          ? "暂无手动场景"
          : formatListUiSummary(
              scenes.map((s) => s.name),
              "个场景",
            );
      const text =
        scenes.length === 0
          ? "当前没有匹配的手动场景。"
          : `共有 ${scenes.length} 个手动场景：\n` +
            scenes.map((s) => `- ${s.name}${s.home_name ? `（${s.home_name}）` : ""} [id=${s.scene_id}]`).join("\n");
      return textResult(text, { ok: true, count: scenes.length, scenes, uiSummary });
    },
  };

  const runSceneTool: AgentTool<any> = {
    name: "run_scene",
    label: "执行手动场景",
    description: "按场景 ID 或名称执行指定的米家手动场景，并在执行后刷新设备开关状态。",
    parameters: obj({
      target: str({ description: "场景 scene_id 或场景名称，例如：回家模式、离家全关" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const scenes = deps.mainWindow.scenes ?? [];
      const raw = params.target.trim();
      const norm = normalizeQuery(raw);
      const found =
        scenes.find((s) => s.scene_id === raw) ??
        scenes.find((s) => normalizeQuery(s.name) === norm) ??
        scenes.find((s) => normalizeQuery(s.name).includes(norm) || norm.includes(normalizeQuery(s.name)));

      if (!found) {
        const msg = `未找到场景：${raw}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const scene = createSceneInfo(found);
      await runJob(deps.jobs, () => deps.service.runScene(scene), 1);

      const onlineDids = deps.mainWindow.allDevices.filter((d) => d.online).map((d) => d.did);
      if (onlineDids.length > 0) {
        try {
          const states = await runJob(deps.jobs, () => deps.service.powerStates(onlineDids), 5);
          for (const [did, st] of Object.entries(states)) {
            if (typeof st === "boolean") {
              deps.mainWindow.applyPowerState(did, st);
            }
          }
          deps.mainWindow.updateTrayDevices();
        } catch {
          // ignore readback failure
        }
      }
      deps.broadcastState();

      const msg = `已执行：${scene.name}`;
      return textResult(msg, {
        ok: true,
        scene_id: scene.scene_id,
        name: scene.name,
        uiSummary: msg,
      });
    },
  };

  const sendXiaoAiTool: AgentTool<any> = {
    name: "send_xiaoai_command",
    label: "发送小爱语音指令",
    description:
      "将自然语言指令转发给在线小爱音箱执行（execute-text-directive），适合放歌、查询天气或小爱生态特有指令。",
    parameters: obj({
      text: str({ description: "发送给小爱同学的指令文本" }),
      speaker: opt(str({ description: "可选指定小爱音箱名称或 did；留空使用默认在线音箱" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const directive = params.text.trim();
      if (!directive) {
        return textResult("指令文本不能为空。", { ok: false }, true);
      }
      const devices = deps.mainWindow.allDevices;
      const onlineSpeakers = devices.filter((d) => isSpeaker(d) && d.online);
      let targetSpeaker: DeviceInfo | null = null;
      if (params.speaker) {
        targetSpeaker = resolveSingleDevice(onlineSpeakers, params.speaker);
      }
      if (!targetSpeaker) {
        const prefDid = deps.settingsStore.getDefaultSpeakerDid();
        if (prefDid) {
          targetSpeaker = onlineSpeakers.find((d) => d.did === prefDid) ?? null;
        }
      }
      if (!targetSpeaker) {
        targetSpeaker = onlineSpeakers[0] ?? null;
      }
      if (!targetSpeaker) {
        return textResult(speakerHint(devices) || "当前没有可用的在线小爱音箱。", { ok: false }, true);
      }

      await runJob(
        deps.jobs,
        () => deps.service.runAction(targetSpeaker!.did, "execute-text-directive", [directive]),
        1,
      );
      if (deps.mainWindow.tray) {
        deps.mainWindow.tray.refreshAudioAfterCommand(targetSpeaker.did);
      }
      deps.broadcastState();

      const msg = `已发给小爱：${directive}`;
      return textResult(msg, {
        ok: true,
        did: targetSpeaker.did,
        speaker: targetSpeaker.name,
        text: directive,
        uiSummary: msg,
      });
    },
  };

  const controlSpeakerTool: AgentTool<any> = {
    name: "control_speaker",
    label: "控制小米/小爱音箱",
    description:
      "专用小米/小爱音箱综合控制工具：支持开关音箱（打开=取消静音并唤醒，关闭=暂停播放并静音待机）、播放指定音乐/歌曲/歌手、播放控制（播放/暂停/停止/上一首/下一首）、设置绝对音量（0-100）或相对增减音量（volume_delta）、扬声器静音/取消静音、麦克风静音以及朗读文本。",
    parameters: obj({
      target: opt(str({ description: "目标音箱名称或 did；留空自动选择默认在线小爱/小米音箱" })),
      power: opt(
        oneOf(["on", "off", "toggle"] as const, {
          description: "开关音箱：on 打开（取消静音并唤醒），off 关闭（暂停并静音待机），toggle 切换",
        }),
      ),
      play_music: opt(str({ description: "播放指定音乐、歌曲、歌手或歌单，例如：周杰伦的晴天、轻音乐、林俊杰的江南" })),
      playback: opt(
        oneOf(["play", "pause", "stop", "next", "previous"] as const, {
          description: "播放控制：play 继续播放、pause 暂停、stop 停止、next 下一首、previous 上一首",
        }),
      ),
      volume: opt(num({ description: "设置目标绝对音量（0-100）", minimum: 0, maximum: 100 })),
      volume_delta: opt(
        num({
          description: "相对调整音量增减值，例如 +10 表示调大 10%，-15 表示调小 15%",
          minimum: -100,
          maximum: 100,
        }),
      ),
      mute: opt(bool({ description: "扬声器静音（true）或取消静音（false）" })),
      mic_mute: opt(bool({ description: "麦克风静音（true）或开启麦克风（false）" })),
      speak_text: opt(str({ description: "让音箱直接朗读指定文本内容" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const devices = deps.mainWindow.allDevices;
      const onlineSpeakers = devices.filter((d) => isSpeaker(d) && d.online);
      let speaker: DeviceInfo | null = null;
      if (params.target) {
        speaker = resolveSingleDevice(onlineSpeakers, params.target);
      }
      if (!speaker) {
        const prefDid = deps.settingsStore.getDefaultSpeakerDid();
        if (prefDid) {
          speaker = onlineSpeakers.find((d) => d.did === prefDid) ?? null;
        }
      }
      if (!speaker) {
        speaker = onlineSpeakers[0] ?? null;
      }
      if (!speaker) {
        return textResult(speakerHint(devices) || "当前没有可用的在线小米/小爱音箱。", { ok: false }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(speaker!.did), 2);
      const { volumeProp, speakerMuteProp, micMuteProp } = findSpeakerAudioProps(detail.props);
      const changes: string[] = [];
      let powerNote: string | undefined;
      let appliedVolume: number | undefined;
      let appliedSong: string | undefined;

      if (params.power) {
        const pwRes = await applySpeakerPower(deps, speaker, params.power);
        powerNote = pwRes.note;
        changes.push(pwRes.note);
      }

      if (typeof params.mute === "boolean") {
        if (!speakerMuteProp) {
          const msg = `${speaker.name}不支持静音控制`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, speakerMuteProp.name, params.mute), 1);
        changes.push(params.mute ? "已静音" : "已取消静音");
      }

      if (typeof params.mic_mute === "boolean") {
        if (!micMuteProp) {
          const msg = `${speaker.name}不支持麦克风静音控制`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, micMuteProp.name, params.mic_mute), 1);
        changes.push(params.mic_mute ? "麦克风已静音" : "麦克风已开启");
      }

      if (params.volume !== undefined || params.volume_delta !== undefined) {
        if (!volumeProp) {
          const msg = `${speaker.name}不支持音量调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        let targetVol: number;
        if (params.volume !== undefined) {
          targetVol = params.volume;
        } else {
          let curVol = 50;
          try {
            const cur = await runJob(deps.jobs, () => deps.service.readProp(speaker!.did, volumeProp.name), 2);
            if (typeof cur === "number" && Number.isFinite(cur)) {
              curVol = cur;
            }
          } catch {
            // fallback 50
          }
          targetVol = curVol + Number(params.volume_delta ?? 0);
        }
        const clamped = clampToPropRange(volumeProp, targetVol);
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, volumeProp.name, clamped), 1);
        appliedVolume = clamped;
        changes.push(`音量 ${clamped}%`);
      }

      if (params.play_music && params.play_music.trim()) {
        const song = params.play_music.trim();
        // 播放音乐前如处于静音，自动取消静音确保能听见
        if (speakerMuteProp && params.mute === undefined && params.power !== "off") {
          try {
            const mVal = await runJob(deps.jobs, () => deps.service.readProp(speaker!.did, speakerMuteProp.name), 2);
            if (mVal === true) {
              await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, speakerMuteProp.name, false), 1);
            }
          } catch {
            // ignore
          }
        }
        const songClean = song.replace(/^播放\s*/, "");
        const directive = /^播放/.test(song) ? song : `播放${song}`;
        await runJob(
          deps.jobs,
          () => deps.service.runAction(speaker!.did, "execute-text-directive", [directive, 0]),
          1,
        );
        appliedSong = songClean;
        changes.push(`播放${songClean}`);
      }

      if (params.playback) {
        const pb = params.playback;
        const labelMap: Record<string, string> = {
          play: "继续播放",
          pause: "已暂停",
          stop: "已停止",
          next: "下一首",
          previous: "上一首",
        };
        await executeSpeakerPlayback(deps, speaker.did, detail.actions, pb);
        changes.push(labelMap[pb] ?? pb);
      }

      if (params.speak_text && params.speak_text.trim()) {
        const txt = params.speak_text.trim();
        await runJob(deps.jobs, () => deps.service.runAction(speaker!.did, "play-text", [txt]), 1);
        changes.push("已播报");
      }

      // 回读音箱实时音量与静音状态
      const toRead = [volumeProp?.name, speakerMuteProp?.name, micMuteProp?.name, "playing-state"].filter(
        (n): n is string => Boolean(n),
      );
      let readback: Record<string, unknown> = {};
      if (toRead.length > 0) {
        try {
          readback = await runJob(deps.jobs, () => deps.service.readProps(speaker!.did, toRead), 2);
        } catch {
          readback = {};
        }
      }

      if (deps.mainWindow.tray) {
        deps.mainWindow.tray.refreshAudioAfterCommand(speaker.did);
      }
      deps.broadcastState();

      const summary =
        changes.length > 0
          ? `${speaker.name} ${changes.join("，")}`
          : `${speaker.name}未指定操作`;

      return textResult(summary, {
        ok: true,
        did: speaker.did,
        name: speaker.name,
        changes,
        values: readback,
        ...(powerNote ? { powerNote } : {}),
        ...(typeof params.mute === "boolean" ? { mute: params.mute } : {}),
        ...(typeof params.mic_mute === "boolean" ? { micMute: params.mic_mute } : {}),
        ...(appliedVolume !== undefined ? { volume: appliedVolume } : {}),
        ...(appliedSong ? { playMusic: appliedSong } : {}),
        ...(params.playback ? { playback: params.playback } : {}),
        ...(params.speak_text?.trim() ? { speak_text: params.speak_text.trim() } : {}),
        uiSummary: summary,
      });
    },
  };

  return [
    listDevicesTool,
    getDeviceDetailTool,
    setDevicePowerTool,
    controlLightTool,
    controlSpeakerTool,
    setDevicePropertyTool,
    runDeviceActionTool,
    listScenesTool,
    runSceneTool,
    sendXiaoAiTool,
  ];
}
