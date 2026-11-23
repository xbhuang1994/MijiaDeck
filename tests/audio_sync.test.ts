// SPDX-License-Identifier: GPL-3.0-or-later
/** Audio state follows external changes without overwriting local edits. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import type { DeviceDetail } from "../src/core/models.ts";
import {
  AudioBarController,
  type AudioBarService,
  type AudioBarTimers,
} from "../src/ui/controllers/audioBarController.ts";

interface PendingJob {
  fn: () => unknown | Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class ManualJobs implements IJobExecutor {
  readonly pending: PendingJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
  }

  finish(): void {
    const job = this.pending.shift();
    if (!job) {
      throw new Error("No pending job to finish");
    }
    try {
      const result = job.fn();
      job.onSuccess?.(result);
    } catch (err) {
      job.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

interface ScheduledTimer {
  id: number;
  kind: "timeout" | "interval";
  delayMs: number;
  nextRunMs: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeClock {
  now = 1000;
  private nextId = 1;
  private readonly entries = new Map<number, ScheduledTimer>();
  readonly scheduledTimeouts: number[] = [];
  readonly scheduledIntervals: number[] = [];

  readonly timers: AudioBarTimers = {
    setInterval: (fn, ms) => {
      const id = this.nextId++;
      this.scheduledIntervals.push(ms);
      this.entries.set(id, {
        id,
        kind: "interval",
        delayMs: ms,
        nextRunMs: this.now + ms,
        fn,
        cancelled: false,
      });
      return id;
    },
    clearInterval: (handle) => {
      const entry = this.entries.get(handle as number);
      if (entry) {
        entry.cancelled = true;
        this.entries.delete(handle as number);
      }
    },
    setTimeout: (fn, ms) => {
      const id = this.nextId++;
      this.scheduledTimeouts.push(ms);
      this.entries.set(id, {
        id,
        kind: "timeout",
        delayMs: ms,
        nextRunMs: this.now + ms,
        fn,
        cancelled: false,
      });
      return id;
    },
    clearTimeout: (handle) => {
      const entry = this.entries.get(handle as number);
      if (entry) {
        entry.cancelled = true;
        this.entries.delete(handle as number);
      }
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let next: ScheduledTimer | null = null;
      for (const entry of this.entries.values()) {
        if (entry.cancelled || entry.nextRunMs > target) {
          continue;
        }
        if (
          next === null ||
          entry.nextRunMs < next.nextRunMs ||
          (entry.nextRunMs === next.nextRunMs && entry.id < next.id)
        ) {
          next = entry;
        }
      }
      if (next === null) {
        break;
      }
      this.now = next.nextRunMs;
      if (next.kind === "timeout") {
        this.entries.delete(next.id);
      } else {
        next.nextRunMs += next.delayMs;
      }
      next.fn();
    }
    this.now = target;
  }

  get activeCount(): number {
    return this.entries.size;
  }
}

describe("AudioSyncTest", () => {
  let volume: number;
  let jobs: ManualJobs;
  let clock: FakeClock;
  let service: AudioBarService;
  let bar: AudioBarController;

  beforeEach(() => {
    volume = 64;
    jobs = new ManualJobs();
    clock = new FakeClock();
    service = {
      deviceDetail: (did): DeviceDetail => ({
        did,
        name: "音箱 A",
        model: "xiaomi.wifispeaker.test",
        props: [],
        actions: [],
      }),
      readProps: () => ({ volume, "mute-2": false }),
      writeProp: (_did, _name, value) => {
        volume = Number(value);
      },
    };
    bar = new AudioBarController(service, jobs, {
      nowMs: () => clock.now,
      timers: clock.timers,
    });
    bar.setSpeaker("speaker-a", "音箱 A");
    jobs.finish();
  });

  afterEach(() => {
    bar.dispose();
    expect(clock.activeCount).toBe(0);
  });

  it("visible poll reads external volume and stops when hidden, resumes on show", () => {
    volume = 50;
    clock.advance(2150);
    expect(jobs.pending.length).toBe(1);
    jobs.finish();
    expect(bar.volumeLabel).toBe("50");
    expect(bar.sliderValue).toBe(50);

    bar.hide();
    expect(bar.pollActive).toBe(false);
    clock.advance(2500);
    expect(jobs.pending.length).toBe(0);

    volume = 35;
    bar.show();
    expect(bar.pollActive).toBe(true);
    expect(jobs.pending.length).toBe(1);
    jobs.finish();
    expect(bar.volumeLabel).toBe("35");
    expect(bar.sliderValue).toBe(35);
  });

  it("refreshState is single-flight", () => {
    bar.refreshState();
    bar.refreshState();
    expect(jobs.pending.length).toBe(1);
    jobs.finish();
  });

  it("old read does not override slider drag or pending write", () => {
    bar.refreshState();
    bar.setSliderDown(true);
    bar.setSliderValue(75);
    jobs.finish();
    expect(bar.volumeLabel).toBe("75");
    expect(bar.sliderValue).toBe(75);

    bar.refreshState();
    expect(jobs.pending.length).toBe(0);

    bar.setSliderDown(false);
    bar.refreshState();
    expect(jobs.pending.length).toBe(1); // write only
    jobs.finish();
    expect(bar.pendingVolume).toBeNull();
    expect(volume).toBe(75);
  });

  it("text command schedules readback (700ms/2200ms) only for selected speaker", () => {
    bar.refreshAfterCommand("another-speaker");
    expect(bar.commandRefreshActive).toBe(false);
    expect(bar.commandRefreshCount).toBe(0);

    volume = 50;
    clock.scheduledTimeouts.length = 0;
    bar.refreshAfterCommand("speaker-a");
    expect(bar.allCommandRefreshesActive).toBe(true);
    expect(bar.commandRefreshCount).toBe(2);
    expect(clock.scheduledTimeouts).toEqual([700, 2200]);

    clock.advance(800);
    expect(jobs.pending.length).toBe(1);
    jobs.finish();
    expect(bar.volumeLabel).toBe("50");
    expect(bar.sliderValue).toBe(50);

    // Advance past poll at t=3000 and second command readback at t=3200.
    clock.advance(1200);
    jobs.finish(); // poll at t=3000
    volume = 42;
    clock.advance(200);
    expect(jobs.pending.length).toBe(1); // second command readback at t=3200
    jobs.finish();
    expect(bar.volumeLabel).toBe("42");
    expect(bar.sliderValue).toBe(42);
    expect(bar.commandRefreshActive).toBe(false);
  });

  it("missing cloud value preserves last known volume", () => {
    service.readProps = () => ({ volume: null, "mute-2": null });
    bar.refreshState();
    jobs.finish();
    expect(bar.volumeLabel).toBe("64");
    expect(bar.volume).toBe(64);
  });

  it("stale cloud read after write does not make slider jump back", () => {
    bar.setSliderValue(40);
    bar.commitSlider();
    jobs.finish();

    // 服务已接受 40，但云端短时间仍返回旧的 64。
    volume = 64;
    bar.refreshState();
    jobs.finish();
    expect(bar.sliderValue).toBe(40);
    expect(bar.volumeLabel).toBe("40");

    // 读到目标值 40 后解除确认保护。
    volume = 40;
    bar.refreshState();
    jobs.finish();
    expect(bar.volumeConfirmation).toBeNull();

    // 确认后，外部音量变化继续正常同步。
    volume = 25;
    bar.refreshState();
    jobs.finish();
    expect(bar.sliderValue).toBe(25);
    expect(bar.volumeLabel).toBe("25");
  });

  it("unconfirmed write expires and new voice command cancels guard", () => {
    bar.setSliderValue(40);
    bar.commitSlider();
    jobs.finish();

    bar.volumeConfirmation = { target: 40, deadlineMs: 0 };
    volume = 60;
    bar.refreshState();
    jobs.finish();
    expect(bar.sliderValue).toBe(60);
    expect(bar.volumeLabel).toBe("60");
    expect(bar.volumeConfirmation).toBeNull();

    bar.volumeConfirmation = { target: 40, deadlineMs: Number.POSITIVE_INFINITY };
    bar.refreshAfterCommand("speaker-a");
    expect(bar.volumeConfirmation).toBeNull();
  });
});
