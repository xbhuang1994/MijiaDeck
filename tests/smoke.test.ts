// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 升级/重构 Mijia SDK 后的兼容性自检（移植自 tests/smoke_test.py）。
 *
 * 静态检查适配层依赖的全部核心 SDK 接口、数据结构与异常类是否均已导出且可调用。
 */

import { describe, expect, test } from "bun:test";
import { MijiaService, ServiceError } from "../src/core/service.ts";
import {
  DevAction,
  DevProp,
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
  LoginError,
  MIJIA_API_VERSION,
  MijiaApiClient,
  MijiaApiError,
  MijiaDevice,
  type FlattenedSpec,
  type MijiaDeviceApi,
} from "../src/mijia/index.ts";

describe("SDK & Service smoke compatibility", () => {
  test("MijiaApiClient exports version, available getter, and all required methods", () => {
    expect(typeof MIJIA_API_VERSION).toBe("string");
    expect(MIJIA_API_VERSION.length).toBeGreaterThan(0);
    expect(MijiaService.apiVersion()).toBe(MIJIA_API_VERSION);

    const availableDesc = Object.getOwnPropertyDescriptor(MijiaApiClient.prototype, "available");
    expect(availableDesc).toBeDefined();
    expect(typeof availableDesc?.get).toBe("function");

    const requiredApiMethods = [
      "getQrLoginData",
      "completeQrLogin",
      "refreshToken",
      "getHomesList",
      "getDevicesList",
      "getSharedDevicesList",
      "getDevicesProp",
      "setDevicesProp",
      "runAction",
      "getScenesList",
      "runScene",
      "postEncrypted",
      "fetchIconRedirect",
      "close",
    ] as const;

    const proto = MijiaApiClient.prototype as unknown as Record<string, unknown>;
    for (const methodName of requiredApiMethods) {
      expect(typeof proto[methodName]).toBe("function");
    }
  });

  test("MijiaDevice, DevProp, and DevAction expose control methods and metadata fields", () => {
    const deviceProto = MijiaDevice.prototype as unknown as Record<string, unknown>;
    for (const methodName of ["get", "set", "runAction"] as const) {
      expect(typeof deviceProto[methodName]).toBe("function");
    }
    expect(typeof MijiaDevice.fromSpec).toBe("function");
    expect(typeof MijiaDevice.create).toBe("function");

    const prop = new DevProp({
      name: "mode",
      description: "Operating Mode",
      type: "uint",
      rw: "rw",
      unit: "none",
      range: [0, 3, 1],
      "value-list": [{ value: 0, description: "Auto", desc_zh_cn: "自动" }],
      method: { siid: 2, piid: 2 },
    });
    expect(prop.name).toBe("mode");
    expect(prop.desc).toBe("Operating Mode");
    expect(prop.description).toBe("Operating Mode");
    expect(prop.type).toBe("uint");
    expect(prop.rw).toBe("rw");
    expect(prop.range).toEqual([0, 3, 1]);
    expect(prop.valueList).toEqual([{ value: 0, description: "Auto", desc_zh_cn: "自动" }]);
    expect(prop.value_list).toEqual([{ value: 0, description: "Auto", desc_zh_cn: "自动" }]);
    expect(prop.method).toEqual({ siid: 2, piid: 2 });

    const action = new DevAction({
      name: "toggle",
      description: "Toggle Switch",
      method: { siid: 2, aiid: 1 },
    });
    expect(action.name).toBe("toggle");
    expect(action.desc).toBe("Toggle Switch");
    expect(action.description).toBe("Toggle Switch");
    expect(action.method).toEqual({ siid: 2, aiid: 1 });

    const stubApi: MijiaDeviceApi = {
      authDataPath: "unused/auth.json",
      getDevicesList: async () => [],
      getDevicesProp: async () => [],
      setDevicesProp: async () => [],
      runAction: async () => ({ code: 0 }),
    };
    const spec: FlattenedSpec = {
      name: "Smoke Lamp",
      properties: [
        {
          name: "on",
          description: "Switch Status",
          type: "bool",
          rw: "rw",
          range: null,
          "value-list": null,
          method: { siid: 2, piid: 1 },
        },
      ],
      actions: [
        {
          name: "toggle",
          description: "Toggle",
          method: { siid: 2, aiid: 1 },
        },
      ],
    };

    const dev = MijiaDevice.fromSpec(stubApi, {
      did: "smoke-1",
      model: "xiaomi.light.smoke",
      name: "Smoke Lamp",
      spec,
    });
    // Shared-device construction relies on writable instance fields.
    expect(dev.api).toBe(stubApi);
    expect(dev.did).toBe("smoke-1");
    expect(dev.model).toBe("xiaomi.light.smoke");
    expect(dev.name).toBe("Smoke Lamp");
    expect(typeof dev.sleepTime).toBe("number");
    expect(dev.propList["on"]).toBeInstanceOf(DevProp);
    expect(dev.actionList["toggle"]).toBeInstanceOf(DevAction);
  });

  test("all 6 SDK error classes and base MijiaApiError are exported and instantiable", () => {
    const errorClasses = [
      ["LoginError", LoginError],
      ["DeviceGetError", DeviceGetError],
      ["DeviceSetError", DeviceSetError],
      ["DeviceActionError", DeviceActionError],
      ["DeviceNotFoundError", DeviceNotFoundError],
      ["GetDeviceInfoError", GetDeviceInfoError],
    ] as const;

    for (const [expectedName, ErrorCtor] of errorClasses) {
      const err = new ErrorCtor(`${expectedName} message`, -100);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MijiaApiError);
      expect(err).toBeInstanceOf(ErrorCtor);
      expect(err.name).toBe(expectedName);
      expect(err.message).toBe(`${expectedName} message`);
      expect(err.code).toBe(-100);
    }
  });

  test("MijiaService and ServiceError are exported with all service contract methods", () => {
    const serviceErr = new ServiceError("操作失败");
    expect(serviceErr).toBeInstanceOf(Error);
    expect(serviceErr).toBeInstanceOf(ServiceError);
    expect(serviceErr.name).toBe("ServiceError");
    expect(serviceErr.message).toBe("操作失败");

    const requiredServiceMethods = [
      "setControlAccess",
      "apiVersion",
      "accountId",
      "logout",
      "loginStatus",
      "qrLoginBegin",
      "qrLoginWait",
      "listDevices",
      "deviceDetail",
      "readProp",
      "readProps",
      "writeProp",
      "runAction",
      "powerState",
      "togglePower",
      "setPowerState",
      "powerStates",
      "readMetrics",
      "specsFor",
      "sceneList",
      "runScene",
      "iconUrls",
      "iconFile",
      "hasProductPageName",
      "cachedProductPageNames",
      "productPageName",
      "specHasPublishedFunctions",
      "localizedProductNames",
      "prepareCameraSource",
      "recordDeviceObservation",
      "deviceDiagnosticReport",
    ] as const;

    const proto = MijiaService.prototype as unknown as Record<string, unknown>;
    for (const methodName of requiredServiceMethods) {
      expect(typeof proto[methodName]).toBe("function");
    }
  });
});
