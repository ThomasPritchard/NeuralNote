export type MockScheduledTask = number;

interface PendingTask {
  readonly id: MockScheduledTask;
  readonly run: () => void;
  readonly autoEligible: boolean;
  cancelled: boolean;
}

/** Deterministic test scheduler. No wall clock is consulted: tests decide when
 * queued channel frames, cancellation tails, and download completions run. */
export class MockScheduler {
  readonly #tasks: PendingTask[] = [];
  #nextId = 1;
  #autoFlushQueued = false;

  constructor(private readonly autoFlush = false) {}

  schedule(run: () => void): MockScheduledTask {
    const id = this.enqueue(run, true);
    this.queueAutoFlush();
    return id;
  }

  /** Queue a deliberately late native/provider event. Auto-flushing journeys
   * must explicitly advance these tasks, which makes cancellation races
   * deterministic and observable. */
  scheduleManual(run: () => void): MockScheduledTask {
    return this.enqueue(run, false);
  }

  private enqueue(run: () => void, autoEligible: boolean): MockScheduledTask {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.push({ id, run, autoEligible, cancelled: false });
    return id;
  }

  private queueAutoFlush(): void {
    if (!this.autoFlush || this.#autoFlushQueued) return;
    this.#autoFlushQueued = true;
    queueMicrotask(() => {
      this.#autoFlushQueued = false;
      this.runAutoEligible();
    });
  }

  private runAutoEligible(): void {
    let index = this.#tasks.findIndex((task) => task.autoEligible);
    while (index >= 0) {
      const [task] = this.#tasks.splice(index, 1);
      if (!task.cancelled) task.run();
      index = this.#tasks.findIndex((candidate) => candidate.autoEligible);
    }
  }

  cancel(id: MockScheduledTask): boolean {
    const task = this.#tasks.find((candidate) => candidate.id === id && !candidate.cancelled);
    if (!task) return false;
    task.cancelled = true;
    return true;
  }

  runNext(): boolean {
    while (this.#tasks.length > 0) {
      const task = this.#tasks.shift()!;
      if (task.cancelled) continue;
      task.run();
      return true;
    }
    return false;
  }

  runAll(): number {
    let executed = 0;
    while (this.runNext()) executed += 1;
    return executed;
  }

  get pending(): number {
    return this.#tasks.filter((task) => !task.cancelled).length;
  }
}
