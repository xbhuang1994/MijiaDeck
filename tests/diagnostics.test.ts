// SPDX-License-Identifier: GPL-3.0-or-later
/** Reports must preserve useful capabilities while excluding all private data. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCameraSource } from "../src/core/cameraAccess.ts";
import { CameraPreviewError } from "../src/core/cameraPreview.ts";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { buildReport, fetchPublicSpec, regionFromUrl, safeObservation } from "../src/core/diagnostics.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import { MijiaService } from "../src/core/service.ts";
import type { MijiaApiClient } from "../src/mijia/index.ts";
import { DiagnosticDialogController } from "../src/ui/controllers/diagnosticDialogController.ts";

const URN = "urn:miot-spec-v2:device:motion-sensor:00000000:example-presence:1";
const DEVICE = createDeviceInfo({
  did: "PRIVATE-DID",
  name: "PRIVATE-NAME",
  model: "example.sensor.presence",
  home_name: "PRIVATE-HOME",
  room_name: "PRIVATE-ROOM",
  online: true,
  spec_type: URN,
  firmware: "1.2.3_456",
});

const SPEC: Record<string, unknown> = {
  services: [
    {
      iid: 2,
      type: "urn:miot-spec-v2:service:motion-sensor:00000000:example:1",
      description: "Presence",
      properties: [
        {
          iid: 1,
          type: "urn:miot-spec-v2:property:occupancy-status:00000000:example:1",
          description: "Occupancy",
          format: "uint8",
          access: ["read", "notify"],
          "value-range": [0, 1, 1],
          "value-list": [
            { value: 0, description: "Absent" },
            { value: 1, description: "Present" },
          ],
          value: "PRIVATE-CURRENT-VALUE",
          token: "PRIVATE-TOKEN",
        },
      ],
      actions: [
        {
          iid: 1,
          type: "urn:miot-spec-v2:action:play:00000000:example:1",
          description: "Play",
          in: [1],
          out: [2],
        },
      ],
      events: [
        {
          iid: 1,
          type: "urn:miot-spec-v2:event:motion-detected:00000000:example:1",
          description: "Motion",
          arguments: [1],
          history: "PRIVATE-HISTORY",
        },
      ],
    },
  ],
  auth: "PRIVATE-AUTH",
};

interface DiagnosticPayload {
  device: {
    model: string | null;
    spec_type: string | null;
    firmware: string | null;
    online: boolean;
    kinds: string[];
    cloud_region: string;
  };
  capabilities: {
    source: string;
    fetch_status: string;
    declared_only: boolean;
    definitions:
      | Array<{
          properties: Array<{ access: string[] }>;
          actions: Array<{ inputs: number[]; outputs: number[] }>;
          events: Array<{ arguments: number[] }>;
        }>
      | {
          properties: unknown[];
          actions: unknown[];
          events: string;
        };
  };
  observation: Record<string, unknown>;
}

function parsePayload(report: string): DiagnosticPayload {
  const afterFence = report.split("```json\n")[1];
  if (!afterFence) {
    throw new Error("Report does not contain fenced json payload");
  }
  const jsonText = afterFence.split("\n```")[0] ?? "";
  return JSON.parse(jsonText) as DiagnosticPayload;
}

interface PendingJob {
  fn: () => unknown;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class Jobs implements IJobExecutor {
  pending: PendingJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

describe("DiagnosticCoreTest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-diagnostics-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name: string) => path.join(tempDir, name),
    });
  });

  afterEach(() => {
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("sample preserves notify, events, action inputs/outputs, firmware, error_code while stripping all private data", () => {
    const observation: Record<string, unknown> = {
      attempted: true,
      stage: "relay",
      error_code: "RELAY",
      vendor_id: 4,
      protocol: "CS2",
      cloud_code: 0,
      http_status: 200,
      authorization_fields_present: { sign: true, private_key: "PRIVATE-KEY" },
      url: "PRIVATE-MEDIA-URL",
      exception: "PRIVATE-EXCEPTION",
      timeline: [
        { stage: "authorization", elapsed_ms: 0 },
        { stage: "relay", elapsed_ms: 325, code: "RELAY", did: "PRIVATE-DID" },
      ],
    };

    const report = buildReport(DEVICE, {
      spec: SPEC,
      specStatus: "ok",
      observation,
    });

    expect(report).not.toContain("PRIVATE-");
    const data = parsePayload(report);
    expect(Array.isArray(data.capabilities.definitions)).toBe(true);
    const definitions = data.capabilities.definitions as Array<{
      properties: Array<{ access: string[] }>;
      actions: Array<{ inputs: number[]; outputs: number[] }>;
      events: Array<{ arguments: number[] }>;
    }>;
    const definition = definitions[0]!;
    expect(definition.properties[0]!.access).toEqual(["read", "notify"]);
    expect(definition.events[0]!.arguments).toEqual([1]);
    expect(definition.actions[0]!.inputs).toEqual([1]);
    expect(definition.actions[0]!.outputs).toEqual([2]);
    expect(data.capabilities.declared_only).toBe(true);
    expect(data.device.firmware).toBe("1.2.3_456");
    expect(data.observation["error_code"]).toBe("RELAY");
  });

  test("no attempt is reported as NOT_ATTEMPTED without protocol and malformed observation falls back safely", () => {
    const data = parsePayload(buildReport(DEVICE));
    expect(data.observation["error_code"]).toBe("NOT_ATTEMPTED");
    expect("protocol" in data.observation).toBe(false);
    expect(data.capabilities.source).toBe("unavailable");
    expect(
      safeObservation({ error_code: ["PRIVATE"], stage: {}, timeline: null })["stage"],
    ).toBe("idle");
  });

  test("metadata collection never reads properties or attempts video and respects offline access", async () => {
    const api = {
      authDataPath: path.join(tempDir, "auth.json"),
      apiBaseUrl: "https://de.api.io.mi.com/app",
      available: true,
      authData: {},
      getDevicesProp: mock(async () => []),
      setDevicesProp: mock(async () => []),
      postEncrypted: mock(async () => ({})),
    };
    const publicSpecFetcher = mock(
      async (): Promise<[Record<string, unknown> | null, string]> => [SPEC, "ok"],
    );
    const service = new MijiaService({
      api: api as unknown as MijiaApiClient,
      publicSpecFetcher,
    });

    const data = parsePayload(await service.deviceDiagnosticReport(DEVICE));
    expect(publicSpecFetcher).toHaveBeenCalledTimes(1);
    expect(publicSpecFetcher).toHaveBeenCalledWith(URN);
    expect(api.getDevicesProp).not.toHaveBeenCalled();
    expect(api.setDevicesProp).not.toHaveBeenCalled();
    expect(api.postEncrypted).not.toHaveBeenCalled();
    expect(data.device.cloud_region).toBe("de");

    service.setControlAccess("offline");
    publicSpecFetcher.mockClear();
    const offlineData = parsePayload(await service.deviceDiagnosticReport(DEVICE));
    expect(publicSpecFetcher).not.toHaveBeenCalled();
    expect(offlineData.capabilities.fetch_status).toBe("offline_or_not_authorized");
  });

  test("public lookup is bounded and has no credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const asFetch = (
      fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    ): typeof fetch => Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;

    const okFetcher = asFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(SPEC), { status: 200 });
    });

    const [spec, status] = await fetchPublicSpec(URN, okFetcher);
    expect(status).toBe("ok");
    expect(spec).toEqual(SPEC);
    expect(calls).toHaveLength(1);
    const parsedUrl = new URL(calls[0]!.url);
    expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe(
      "https://miot-spec.org/miot-spec-v2/instance",
    );
    expect(parsedUrl.searchParams.get("type")).toBe(URN);
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect(calls[0]!.init?.credentials).toBeUndefined();
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    const timeoutFetcher = asFetch(async () => {
      throw new DOMException("PRIVATE-URL", "TimeoutError");
    });
    expect(await fetchPublicSpec(URN, timeoutFetcher)).toEqual([null, "public_spec_timeout"]);

    // Oversized responses are bounded and aborted without loading unbounded bytes
    const oversizedFetcher = asFetch(async () => {
      const chunk = new Uint8Array(600_000);
      let count = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (count < 5) {
            count += 1;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200 });
    });
    expect(await fetchPublicSpec(URN, oversizedFetcher)).toEqual([null, "public_spec_too_large"]);

    const unusedFetcher = mock(async () => new Response("{}", { status: 200 }));
    const [invalidSpec, invalidStatus] = await fetchPublicSpec(
      "https://PRIVATE-URL",
      asFetch(unusedFetcher),
    );
    expect(invalidSpec).toBeNull();
    expect(invalidStatus).toBe("no_public_spec_type");
    expect(unusedFetcher).not.toHaveBeenCalled();
  });

  test("vendor probe only records protocol number and boolean field presence", async () => {
    const values: Record<string, unknown> = {};
    let caught: unknown = null;
    try {
      await buildCameraSource(
        "PRIVATE-DID",
        "example.camera.1",
        async () => ({
          vendor: {
            vendor: 7,
            vendor_params: {
              p2p_id: "PRIVATE-P2P",
              init_string: "PRIVATE-INIT",
            },
          },
          public_key: "PRIVATE-KEY",
          sign: "PRIVATE-SIGN",
        }),
        (fields) => {
          Object.assign(values, fields);
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CameraPreviewError);
    expect((caught as CameraPreviewError).code).toBe("VENDOR_UNSUPPORTED");
    expect(values["vendor_id"]).toBe(7);
    expect(values["authorization_fields_present"]).toEqual({
      p2p_id: true,
      init_string: true,
      public_key: true,
      sign: true,
    });
    expect(JSON.stringify(values)).not.toContain("PRIVATE-");
  });

  test("cache fallback does not invent event support", () => {
    const data = parsePayload(
      buildReport(DEVICE, {
        cachedSpec: { properties: [], actions: [] },
        specStatus: "public_spec_timeout",
      }),
    );
    expect(data.capabilities.source).toBe("sdk_cache");
    const defs = data.capabilities.definitions as { events: string };
    expect(defs.events).toBe("unavailable_in_sdk_cache");
  });

  test("regionFromUrl recognizes both api.mijia.tech and api.io.mi.com hosts", () => {
    expect(regionFromUrl("https://api.mijia.tech/app")).toBe("cn");
    expect(regionFromUrl("https://de.api.mijia.tech/app")).toBe("de");
    expect(regionFromUrl("https://api.io.mi.com/app")).toBe("cn");
    expect(regionFromUrl("https://us.api.io.mi.com/app")).toBe("us");
    expect(regionFromUrl("")).toBe("unknown");
  });
});

describe("DiagnosticDialogTest", () => {
  let jobs: Jobs;
  let clipboard: string;
  let clipboardWrite: ReturnType<typeof mock>;
  let service: { deviceDiagnosticReport: ReturnType<typeof mock> };
  let dialog: DiagnosticDialogController;

  beforeEach(() => {
    clipboard = "initial-clipboard-content";
    clipboardWrite = mock((text: string) => {
      clipboard = text;
    });
    jobs = new Jobs();
    service = {
      deviceDiagnosticReport: mock(async () => "safe report"),
    };
    const second = createDeviceInfo({ ...DEVICE, model: "example.speaker.1" });
    dialog = new DiagnosticDialogController(service, jobs, [DEVICE, second]);
  });

  afterEach(() => {
    dialog.close();
  });

  test("clipboard requires explicit copy and switching device ignores old in-flight report", async () => {
    const firstJob = jobs.pending.shift();
    expect(firstJob).toBeDefined();
    const result = await firstJob!.fn();

    dialog.selectDevice(1);
    firstJob!.onSuccess?.(result);
    expect(dialog.previewText).toBe("");
    expect(dialog.copyEnabled).toBe(false);

    dialog.generate();
    const secondJob = jobs.pending.shift();
    expect(secondJob).toBeDefined();
    secondJob!.onSuccess?.(await secondJob!.fn());

    expect(dialog.previewText).toBe("safe report");
    expect(dialog.copyEnabled).toBe(true);
    expect(clipboard).toBe("initial-clipboard-content");
    expect(clipboardWrite).not.toHaveBeenCalled();

    expect(dialog.copy(clipboardWrite)).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith("safe report");
    expect(clipboard).toBe("safe report");
  });

  test("closed dialog ignores pending late report and error", () => {
    const pendingJob = jobs.pending.shift();
    expect(pendingJob).toBeDefined();
    dialog.close();

    pendingJob!.onSuccess?.("late report");
    pendingJob!.onError?.(new Error("PRIVATE-ERROR"));

    expect(dialog.previewText).toBe("");
    expect(dialog.copyEnabled).toBe(false);
    expect(dialog.statusText).not.toContain("PRIVATE-ERROR");
  });
});
