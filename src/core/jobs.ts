// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 串行任务执行器：所有米家网络调用都排进这一个优先级队列依次执行。
 *
 * 不采用并发的原因：上游会话及防限流策略要求严格串行，并发只会带来竞态而
 * 不会更快。单通道队列天然节流，高优先级刷新任务可插队到低优先级装饰任务前。
 */

import type { IJobExecutor, JobSubmitOptions } from "./contracts.ts";

interface QueuedTask {
  priority: number;
  sequence: number;
  generation: number;
  fn: () => unknown | Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

function compareTasks(a: QueuedTask, b: QueuedTask): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return a.sequence - b.sequence;
}

class TaskPriorityQueue {
  private readonly items: QueuedTask[] = [];

  get size(): number {
    return this.items.length;
  }

  push(task: QueuedTask): void {
    this.items.push(task);
    let idx = this.items.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (compareTasks(this.items[idx]!, this.items[parent]!) >= 0) {
        break;
      }
      const tmp = this.items[idx]!;
      this.items[idx] = this.items[parent]!;
      this.items[parent] = tmp;
      idx = parent;
    }
  }

  pop(): QueuedTask | undefined {
    const count = this.items.length;
    if (count === 0) {
      return undefined;
    }
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (count > 1) {
      this.items[0] = last;
      let idx = 0;
      const len = this.items.length;
      while (true) {
        const left = 2 * idx + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < len && compareTasks(this.items[left]!, this.items[smallest]!) < 0) {
          smallest = left;
        }
        if (right < len && compareTasks(this.items[right]!, this.items[smallest]!) < 0) {
          smallest = right;
        }
        if (smallest === idx) {
          break;
        }
        const tmp = this.items[idx]!;
        this.items[idx] = this.items[smallest]!;
        this.items[smallest] = tmp;
        idx = smallest;
      }
    }
    return top;
  }

  clear(): void {
    this.items.length = 0;
  }
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

export class JobExecutor implements IJobExecutor {
  private readonly _queue = new TaskPriorityQueue();
  private _sequence = 0;
  private _generation = 0;
  private _running = false;
  private _scheduled = false;
  private _closed = false;
  private _activeTask: Promise<void> | null = null;

  get pendingCount(): number {
    return this._queue.size;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    if (this._closed) {
      return;
    }
    const priority = options?.priority ?? 10;
    this._queue.push({
      priority,
      sequence: this._sequence++,
      generation: this._generation,
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
    this._schedule();
  }

  /**
   * Discard queued work and callbacks belonging to the previous account.
   *
   * An in-flight request finishes normally; subsequent work (such as logout)
   * runs after it in this same serial queue, without forcibly interrupting I/O.
   */
  cancelPending(): void {
    this._generation += 1;
    this._queue.clear();
  }

  async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this._closed = true;
    this._generation += 1;
    this._queue.clear();

    const active = this._activeTask;
    if (!active) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`后台任务在 ${timeoutMs}ms 内未退出，放弃继续等待`);
        resolve();
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      await Promise.race([active, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private _schedule(): void {
    if (this._scheduled || this._running || this._closed) {
      return;
    }
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      if (!this._running && !this._closed && this._queue.size > 0) {
        void this._drain();
      }
    });
  }

  private async _drain(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;
    try {
      while (!this._closed) {
        const task = this._queue.pop();
        if (!task) {
          break;
        }
        let resolveActive!: () => void;
        this._activeTask = new Promise<void>((resolve) => {
          resolveActive = resolve;
        });
        try {
          const result = await task.fn();
          if (task.generation === this._generation && !this._closed && task.onSuccess) {
            try {
              task.onSuccess(result);
            } catch (cbErr) {
              console.warn("后台任务成功回调异常:", cbErr);
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.warn("后台任务失败:", error.message);
          if (task.generation === this._generation && !this._closed && task.onError) {
            try {
              task.onError(error);
            } catch (cbErr) {
              console.warn("后台任务失败回调异常:", cbErr);
            }
          }
        } finally {
          resolveActive();
          this._activeTask = null;
        }
      }
    } finally {
      this._running = false;
      if (!this._closed && this._queue.size > 0) {
        this._schedule();
      }
    }
  }
}
