// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业设备状态解析与指令编码（忠实对应 stackia/libdeye device_state.py & device_command.py）

import {
  DeyeDeviceMode,
  DeyeFanSpeed,
  FOG_PROTOCOL_V0_COMPANIONS,
  FOG_SETTABLE_PROPERTY_ALIASES,
  FOG_SETTABLE_PROPERTY_ORDER,
} from "./constants.ts";

/** Classic 状态字位掩码（bytes[2..4] 大端 16 位） */
export const DeyeDeviceStateFlag = {
  ANION_SWITCH: 1 << 0,
  WATER_PUMP_SWITCH: 1 << 1,
  ELECTROMAGNETIC_STATE: 1 << 2,
  PRESS_STATE: 1 << 3,
  ENVIRONMENT_DEGREE: 1 << 4,
  POWER_SWITCH: 1 << 8,
  OSCILLATING_SWITCH: 1 << 9,
  CHILD_LOCK_SWITCH: 1 << 10,
  POWEROFF_SWITCH: 1 << 11,
  POWERON_SWITCH: 1 << 12,
  DEFROSTING_STATE: 1 << 13,
  WATER_TANK_FULL_STATE: 1 << 14,
  FAN_RUNNING_STATE: 1 << 15,
} as const;

/** Classic 指令位掩码（对应 libdeye DeyeDeviceCommandFlag） */
export const DeyeDeviceCommandFlag = {
  POWER_SWITCH: 1 << 0,
  OSCILLATING_SWITCH: 1 << 1,
  CHILD_LOCK_SWITCH: 1 << 2,
  POWEROFF_SWITCH: 1 << 3,
  POWERON_SWITCH: 1 << 4,
  WATER_PUMP_SWITCH: 1 << 5,
  ANION_SWITCH: 1 << 6,
} as const;

/** Combo 单属性控制指令操作码（CommandManger.sendSingleCommand -> {2, 17, cmd, value}） */
export enum DeyeFogComboCommand {
  POWER = 1,
  OSCILLATING = 2,
  CHILD_LOCK = 3,
  WATER_PUMP = 6,
  ANION = 7,
  MODE = 8,
  FAN_SPEED = 9,
  HUMIDITY_OR_TEMP = 10,
  SLEEP = 15,
}

export const FOG_COMBO_FRAME_PREFIX = 2;
export const FOG_COMBO_COMMAND_HEADER = 17;

export const FOG_COMBO_PROPERTY_COMMANDS: Readonly<Record<string, DeyeFogComboCommand>> = {
  Power: DeyeFogComboCommand.POWER,
  SwingingWind: DeyeFogComboCommand.OSCILLATING,
  KeyLock: DeyeFogComboCommand.CHILD_LOCK,
  WaterPump: DeyeFogComboCommand.WATER_PUMP,
  NegativeIon: DeyeFogComboCommand.ANION,
  Mode: DeyeFogComboCommand.MODE,
  WindSpeed: DeyeFogComboCommand.FAN_SPEED,
  SetHumidity: DeyeFogComboCommand.HUMIDITY_OR_TEMP,
  Sleep: DeyeFogComboCommand.SLEEP,
};

export interface DeyeDeviceState {
  anionSwitch: boolean | null;
  waterPumpSwitch: boolean | null;
  powerSwitch: boolean | null;
  oscillatingSwitch: boolean | null;
  childLockSwitch: boolean | null;
  defrosting: boolean;
  waterTankFull: boolean;
  fanRunning: boolean;
  fanSpeed: DeyeFanSpeed;
  mode: DeyeDeviceMode;
  targetHumidity: number;
  environmentTemperature: number;
  environmentHumidity: number;
  uvSwitch: boolean | null;
  promptSound: boolean | null;
  screenDisplay: boolean | null;
  timedOffHour: number | null;
  // 诊断/扩展状态字段
  electromagneticState: boolean;
  pressState: boolean;
  environmentDegree: boolean;
  poweroffSwitch: boolean;
  poweronSwitch: boolean;
  coilTemperature: number;
  exhaustTemperature: number;
  protocolVersion: number | null;
  rawFogProperties?: Record<string, unknown>;
}

export interface DeyeDeviceCommand {
  anionSwitch?: boolean | null;
  waterPumpSwitch?: boolean | null;
  powerSwitch?: boolean | null;
  oscillatingSwitch?: boolean | null;
  childLockSwitch?: boolean | null;
  fanSpeed?: DeyeFanSpeed | null;
  mode?: DeyeDeviceMode | null;
  targetHumidity?: number | null;
  uvSwitch?: boolean | null;
  promptSound?: boolean | null;
  screenDisplay?: boolean | null;
  timedOffHour?: number | null;
}

export type FogCommandBaseline = DeyeDeviceCommand | DeyeDeviceState;

function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    const stripped = value.trim();
    if (/^-?\d+$/.test(stripped)) {
      return Number.parseInt(stripped, 10);
    }
  }
  return null;
}

function optionalFlag(value: unknown): boolean | null {
  const parsed = optionalInt(value);
  if (parsed === null) {
    return null;
  }
  return parsed !== 0;
}

function statusFlag(value: unknown): boolean {
  return optionalFlag(value) === true;
}

function isDeviceState(value: FogCommandBaseline): value is DeyeDeviceState {
  return "environmentTemperature" in value && "waterTankFull" in value;
}

function hexToBytes(hexStr: string): Uint8Array {
  const cleaned = hexStr.replace(/\s+/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error(`无效的德业 Classic 状态十六进制字符串（长度=${cleaned.length}）`);
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 解析德业 Classic MQTT `/status/hex` 二进制十六进制状态报文。
 * 至少需要 18 字节（36 个十六进制字符）。
 */
export function parseClassicStateHex(hexStr: string): DeyeDeviceState {
  const cleaned = hexStr.replace(/\s+/g, "");
  const stateBytes = hexToBytes(cleaned);
  if (stateBytes.length < 18) {
    throw new Error(
      `德业 Classic 状态帧过短：期望至少 18 字节，实际 ${stateBytes.length} 字节`,
    );
  }

  const stateFlag = ((stateBytes[2]! << 8) | stateBytes[3]!) >>> 0;
  const fanSpeed = Number.parseInt(cleaned[8]!, 16) as DeyeFanSpeed;
  const mode = Number.parseInt(cleaned[9]!, 16) as DeyeDeviceMode;

  return {
    anionSwitch: (stateFlag & DeyeDeviceStateFlag.ANION_SWITCH) !== 0,
    waterPumpSwitch: (stateFlag & DeyeDeviceStateFlag.WATER_PUMP_SWITCH) !== 0,
    powerSwitch: (stateFlag & DeyeDeviceStateFlag.POWER_SWITCH) !== 0,
    oscillatingSwitch: (stateFlag & DeyeDeviceStateFlag.OSCILLATING_SWITCH) !== 0,
    childLockSwitch: (stateFlag & DeyeDeviceStateFlag.CHILD_LOCK_SWITCH) !== 0,
    defrosting: (stateFlag & DeyeDeviceStateFlag.DEFROSTING_STATE) !== 0,
    waterTankFull: (stateFlag & DeyeDeviceStateFlag.WATER_TANK_FULL_STATE) !== 0,
    fanRunning: (stateFlag & DeyeDeviceStateFlag.FAN_RUNNING_STATE) !== 0,
    fanSpeed,
    mode,
    targetHumidity: stateBytes[5]!,
    coilTemperature: stateBytes[14]! - 40,
    environmentTemperature: stateBytes[15]! - 40,
    environmentHumidity: stateBytes[16]!,
    exhaustTemperature: stateBytes[17]! - 40,
    uvSwitch: null,
    promptSound: null,
    screenDisplay: null,
    timedOffHour: null,
    electromagneticState: (stateFlag & DeyeDeviceStateFlag.ELECTROMAGNETIC_STATE) !== 0,
    pressState: (stateFlag & DeyeDeviceStateFlag.PRESS_STATE) !== 0,
    environmentDegree: (stateFlag & DeyeDeviceStateFlag.ENVIRONMENT_DEGREE) !== 0,
    poweroffSwitch: (stateFlag & DeyeDeviceStateFlag.POWEROFF_SWITCH) !== 0,
    poweronSwitch: (stateFlag & DeyeDeviceStateFlag.POWERON_SWITCH) !== 0,
    protocolVersion: null,
  };
}

/**
 * 解析德业 Fog 平台设备属性字典（GET `/get/properties/` 或 Fog MQTT `thing_property`）。
 */
export function parseFogState(props: Record<string, unknown>): DeyeDeviceState {
  const timedOffRaw =
    props["TimedOffHour"] !== undefined
      ? props["TimedOffHour"]
      : props["TimedShutdownHourSetting"];

  return {
    anionSwitch: optionalFlag(props["NegativeIon"]),
    waterPumpSwitch: optionalFlag(props["WaterPump"]),
    powerSwitch: optionalFlag(props["Power"]),
    oscillatingSwitch: optionalFlag(props["SwingingWind"]),
    childLockSwitch: optionalFlag(props["KeyLock"]),
    defrosting: statusFlag(props["Demisting"]),
    waterTankFull: statusFlag(props["WaterTank"]),
    fanRunning: statusFlag(props["Fan"]),
    fanSpeed: (optionalInt(props["WindSpeed"]) ?? DeyeFanSpeed.STOPPED) as DeyeFanSpeed,
    mode: (optionalInt(props["Mode"]) ?? DeyeDeviceMode.SLEEP_MODE) as DeyeDeviceMode,
    targetHumidity: optionalInt(props["SetHumidity"]) ?? 60,
    environmentTemperature: optionalInt(props["CurrentAmbientTemperature"]) ?? 27,
    environmentHumidity: optionalInt(props["CurrentEnvironmentalHumidity"]) ?? 27,
    uvSwitch: optionalFlag(props["UV"]),
    promptSound: optionalFlag(props["PromptSound"]),
    screenDisplay: optionalFlag(props["Screendisplay"]),
    timedOffHour: optionalInt(timedOffRaw),
    electromagneticState: statusFlag(props["SolenoidValve"]),
    pressState: statusFlag(props["CompressorStatus"]),
    environmentDegree: false,
    poweroffSwitch: statusFlag(props["TimedOff"]),
    poweronSwitch: statusFlag(props["TimedOn"]),
    coilTemperature: optionalInt(props["CurrentCoilTemperature"]) ?? 27,
    exhaustTemperature: optionalInt(props["CurrentExhaustTemperature"]) ?? 27,
    protocolVersion: optionalInt(props["ProtocolVersion"]),
    rawFogProperties: { ...props },
  };
}

/** 将当前设备状态转换为等价控制指令对象 */
export function stateToCommand(state: DeyeDeviceState): DeyeDeviceCommand {
  return {
    anionSwitch: state.anionSwitch,
    waterPumpSwitch: state.waterPumpSwitch,
    powerSwitch: state.powerSwitch,
    oscillatingSwitch: state.oscillatingSwitch,
    childLockSwitch: state.childLockSwitch,
    fanSpeed: state.fanSpeed,
    mode: state.mode,
    targetHumidity: state.targetHumidity,
    uvSwitch: state.uvSwitch,
    promptSound: state.promptSound,
    screenDisplay: state.screenDisplay,
    timedOffHour: state.timedOffHour,
  };
}

/** 比较两个指令对象是否语义一致 */
export function commandsEqual(a: DeyeDeviceCommand, b: DeyeDeviceCommand): boolean {
  return (
    (a.anionSwitch ?? null) === (b.anionSwitch ?? null) &&
    (a.waterPumpSwitch ?? null) === (b.waterPumpSwitch ?? null) &&
    (a.powerSwitch ?? null) === (b.powerSwitch ?? null) &&
    (a.oscillatingSwitch ?? null) === (b.oscillatingSwitch ?? null) &&
    (a.childLockSwitch ?? null) === (b.childLockSwitch ?? null) &&
    (a.fanSpeed ?? null) === (b.fanSpeed ?? null) &&
    (a.mode ?? null) === (b.mode ?? null) &&
    (a.targetHumidity ?? null) === (b.targetHumidity ?? null) &&
    (a.uvSwitch ?? null) === (b.uvSwitch ?? null) &&
    (a.promptSound ?? null) === (b.promptSound ?? null) &&
    (a.screenDisplay ?? null) === (b.screenDisplay ?? null) &&
    (a.timedOffHour ?? null) === (b.timedOffHour ?? null)
  );
}

/**
 * 编码德业 Classic MQTT 10 字节控制命令帧：
 * `[0x08, 0x02, commandFlag, (fanSpeed << 4) | mode, targetHumidity, timedOffHour & 0xFF, 0, 0, 0, 0]`
 */
export function encodeClassicCommand(cmd: DeyeDeviceCommand): Uint8Array {
  let commandFlag = 0;
  if (cmd.anionSwitch) {
    commandFlag |= DeyeDeviceCommandFlag.ANION_SWITCH;
  }
  if (cmd.waterPumpSwitch) {
    commandFlag |= DeyeDeviceCommandFlag.WATER_PUMP_SWITCH;
  }
  if (cmd.powerSwitch) {
    commandFlag |= DeyeDeviceCommandFlag.POWER_SWITCH;
  }
  if (cmd.oscillatingSwitch) {
    commandFlag |= DeyeDeviceCommandFlag.OSCILLATING_SWITCH;
  }
  if (cmd.childLockSwitch) {
    commandFlag |= DeyeDeviceCommandFlag.CHILD_LOCK_SWITCH;
  }

  const fanSpeed = cmd.fanSpeed !== undefined && cmd.fanSpeed !== null ? cmd.fanSpeed : DeyeFanSpeed.LOW;
  const mode = cmd.mode !== undefined && cmd.mode !== null ? cmd.mode : DeyeDeviceMode.MANUAL_MODE;
  const targetHumidity =
    cmd.targetHumidity !== undefined && cmd.targetHumidity !== null ? cmd.targetHumidity : 60;
  const timedOffHour =
    cmd.timedOffHour !== undefined && cmd.timedOffHour !== null ? cmd.timedOffHour : 0;

  return new Uint8Array([
    0x08,
    0x02,
    commandFlag & 0xff,
    (((fanSpeed & 0x0f) << 4) | (mode & 0x0f)) & 0xff,
    targetHumidity & 0xff,
    timedOffHour & 0xff,
    0,
    0,
    0,
    0,
  ]);
}

/** 将指令序列化为 Fog JSON 字段字典（跳过 null / undefined 字段） */
export function commandToFogJson(cmd: DeyeDeviceCommand): Record<string, number> {
  const payload: Record<string, number> = {};
  if (cmd.childLockSwitch !== undefined && cmd.childLockSwitch !== null) {
    payload["KeyLock"] = cmd.childLockSwitch ? 1 : 0;
  }
  if (cmd.mode !== undefined && cmd.mode !== null) {
    payload["Mode"] = Number(cmd.mode);
  }
  if (cmd.powerSwitch !== undefined && cmd.powerSwitch !== null) {
    payload["Power"] = cmd.powerSwitch ? 1 : 0;
  }
  if (cmd.uvSwitch !== undefined && cmd.uvSwitch !== null) {
    payload["UV"] = cmd.uvSwitch ? 1 : 0;
  }
  if (cmd.fanSpeed !== undefined && cmd.fanSpeed !== null) {
    payload["WindSpeed"] = Number(cmd.fanSpeed);
  }
  if (cmd.targetHumidity !== undefined && cmd.targetHumidity !== null) {
    payload["SetHumidity"] = Math.trunc(cmd.targetHumidity);
  }
  if (cmd.anionSwitch !== undefined && cmd.anionSwitch !== null) {
    payload["NegativeIon"] = cmd.anionSwitch ? 1 : 0;
  }
  if (cmd.oscillatingSwitch !== undefined && cmd.oscillatingSwitch !== null) {
    payload["SwingingWind"] = cmd.oscillatingSwitch ? 1 : 0;
  }
  if (cmd.waterPumpSwitch !== undefined && cmd.waterPumpSwitch !== null) {
    payload["WaterPump"] = cmd.waterPumpSwitch ? 1 : 0;
  }
  if (cmd.promptSound !== undefined && cmd.promptSound !== null) {
    payload["PromptSound"] = cmd.promptSound ? 1 : 0;
  }
  if (cmd.screenDisplay !== undefined && cmd.screenDisplay !== null) {
    payload["Screendisplay"] = cmd.screenDisplay ? 1 : 0;
  }
  if (cmd.timedOffHour !== undefined && cmd.timedOffHour !== null) {
    payload["TimedOffHour"] = Math.trunc(cmd.timedOffHour);
  }
  return payload;
}

/** 仅计算相对基线状态发生变化的 Fog JSON 属性 */
export function commandToFogJsonDiff(
  cmd: DeyeDeviceCommand,
  baseline: FogCommandBaseline,
): Record<string, number> {
  const baselineCmd = isDeviceState(baseline) ? stateToCommand(baseline) : baseline;
  const cmdJson = commandToFogJson(cmd);
  const baseJson = commandToFogJson(baselineCmd);
  const diff: Record<string, number> = {};
  for (const [key, value] of Object.entries(cmdJson)) {
    if (baseJson[key] !== value) {
      diff[key] = value;
    }
  }
  return diff;
}

/** 将缓存的 Fog GET/MQTT 属性归一化为可写 SET 属性快照 */
export function fogFullSnapshotFromProperties(
  properties: Record<string, unknown>,
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [sourceKey, destKey] of FOG_SETTABLE_PROPERTY_ALIASES) {
    const parsed = optionalInt(properties[sourceKey]);
    if (parsed !== null) {
      snapshot[destKey] = parsed;
    }
  }
  return snapshot;
}

function buildFogV0PayloadForKey(
  primary: string,
  value: number,
  cmd: DeyeDeviceCommand,
  lastProperties: Record<string, unknown>,
): Record<string, number> {
  const companions = FOG_PROTOCOL_V0_COMPANIONS[primary];
  if (!companions) {
    return { [primary]: value };
  }

  const values: Record<string, number> = {
    ...fogFullSnapshotFromProperties(lastProperties),
    ...commandToFogJson(cmd),
  };

  const payload: Record<string, number> = { [primary]: value };
  for (const key of companions) {
    if (key in values) {
      payload[key] = values[key]!;
    }
  }
  payload[primary] = value;
  return payload;
}

export interface ResolveFogCommandOptions {
  properties?: Record<string, number> | null;
  baseline?: FogCommandBaseline | null;
  protocolVersion?: number | null;
  lastProperties?: Record<string, unknown> | null;
}

/**
 * 构建符合官方 FogDeviceManager 规则的 `set/properties` 请求体列表。
 * - `protocolVersion === 0` 且存在基线/缓存属性时，每个变更主键按 `FOG_PROTOCOL_V0_COMPANIONS` 组装伴随快照。
 * - 其他协议版本仅下发增量变更键。
 */
export function resolveFogCommandPayloads(
  cmd: DeyeDeviceCommand,
  options: ResolveFogCommandOptions = {},
): Array<Record<string, number>> {
  const { properties, baseline, protocolVersion } = options;

  let changed: Record<string, number>;
  if (baseline) {
    const baselineCmd = isDeviceState(baseline) ? stateToCommand(baseline) : baseline;
    if (commandsEqual(cmd, baselineCmd) && !properties) {
      return [];
    }
    changed = properties ? { ...properties } : commandToFogJsonDiff(cmd, baselineCmd);
  } else {
    changed = properties ? { ...properties } : commandToFogJson(cmd);
  }

  if (Object.keys(changed).length === 0) {
    return [];
  }

  let effectiveLastProps: Record<string, unknown> | null = options.lastProperties ?? null;
  if (effectiveLastProps === null && baseline) {
    if (isDeviceState(baseline)) {
      effectiveLastProps = baseline.rawFogProperties ?? commandToFogJson(stateToCommand(baseline));
    } else {
      effectiveLastProps = commandToFogJson(baseline);
    }
  }

  const effectiveVersion =
    protocolVersion !== undefined
      ? protocolVersion
      : baseline && isDeviceState(baseline)
        ? baseline.protocolVersion
        : null;

  if (effectiveVersion !== 0 || effectiveLastProps === null) {
    return [changed];
  }

  const payloads: Array<Record<string, number>> = [];
  const remaining: Record<string, number> = { ...changed };

  for (const key of FOG_SETTABLE_PROPERTY_ORDER) {
    if (!(key in remaining)) {
      continue;
    }
    const val = remaining[key]!;
    delete remaining[key];
    payloads.push(buildFogV0PayloadForKey(key, val, cmd, effectiveLastProps));
  }
  for (const [key, val] of Object.entries(remaining)) {
    payloads.push(buildFogV0PayloadForKey(key, val, cmd, effectiveLastProps));
  }

  return payloads;
}

/**
 * 编码单条 Fog 控制指令 JSON 载荷（便捷入口，兼容 ProtocolVersion === 0 伴随属性）。
 */
export function encodeFogCommand(
  cmd: DeyeDeviceCommand,
  baseline?: FogCommandBaseline | null,
  protocolVersion?: number | null,
  lastProperties?: Record<string, unknown> | null,
): Record<string, number> {
  const payloads = resolveFogCommandPayloads(cmd, {
    baseline: baseline ?? null,
    protocolVersion: protocolVersion ?? undefined,
    lastProperties: lastProperties ?? null,
  });
  return payloads[0] ?? {};
}

/** 编码单个官方 FogCombo MQTT 指令帧：`{2, 17, cmd, value}` */
export function encodeFogComboFrame(command: number, value: number): Uint8Array {
  return new Uint8Array([
    FOG_COMBO_FRAME_PREFIX,
    FOG_COMBO_COMMAND_HEADER,
    command & 0xff,
    value & 0xff,
  ]);
}

/** 将 Fog 属性字典转换为对应的 FogCombo MQTT 4 字节指令帧列表 */
export function fogComboFramesFromProperties(properties: Record<string, number>): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const opcode = FOG_COMBO_PROPERTY_COMMANDS[name];
    if (opcode !== undefined) {
      frames.push(encodeFogComboFrame(opcode, value));
    }
  }
  return frames;
}
