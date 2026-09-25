// A queue for the server's slow work: exports, drawings, nesting, prebuilt
// files for the mobile viewer. Each job has
//
// - a key naming its result (typically the document revision plus what is
//   being made): asking for a key that is already queued or running joins
//   that job instead of starting it twice;
// - a lane: jobs in one lane run one after another (for example everything
//   that writes into one build directory), different lanes run side by side,
//   up to `concurrency` at once.
//
// Progress is reported to a listener, which the server forwards to pages over
// server-sent events.

export interface JobProgress {
  /** From 0 to 1, when the work can tell. */
  readonly fraction?: number;
  readonly message: string;
}

export interface JobSnapshot {
  readonly key: string;
  readonly lane: string;
  readonly label: string;
  readonly state: "queued" | "running";
  readonly progress: JobProgress;
}

export interface JobSpec<T> {
  readonly key: string;
  /** Jobs sharing a lane never overlap. Defaults to the key. */
  readonly lane?: string;
  /** Shown to people waiting on the job. */
  readonly label: string;
  readonly work: (report: (progress: JobProgress) => void) => Promise<T>;
}

interface Job {
  readonly spec: JobSpec<unknown>;
  readonly lane: string;
  state: "queued" | "running";
  progress: JobProgress;
  readonly promise: Promise<unknown>;
  start(): void;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly busyLanes = new Set<string>();
  private running = 0;

  constructor(
    private readonly options: {
      readonly concurrency: number;
      readonly onChange?: () => void;
    },
  ) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
      throw new RangeError("concurrency must be a positive integer");
  }

  /** Queues the work, or joins the job already queued or running under the
   * same key. Settles with the work's result once it has run. */
  run<T>(spec: JobSpec<T>): Promise<T> {
    const existing = this.jobs.get(spec.key);
    if (existing) return existing.promise as Promise<T>;
    const lane = spec.lane ?? spec.key;
    let start!: () => void;
    const promise = new Promise<T>((resolve, reject) => {
      start = () => {
        job.state = "running";
        job.progress = { fraction: 0, message: spec.label };
        this.running++;
        this.busyLanes.add(lane);
        this.changed();
        let settled: Promise<T>;
        try {
          settled = spec.work((progress) => {
            job.progress = progress;
            this.changed();
          });
        } catch (error) {
          settled = Promise.reject(error);
        }
        // Clean up before settling, so a caller that reacts to the result
        // by asking for the same key again starts a new job.
        settled
          .finally(() => {
            this.running--;
            this.busyLanes.delete(lane);
            this.jobs.delete(spec.key);
            this.changed();
            this.pump();
          })
          .then(resolve, reject);
      };
    });
    const job: Job = {
      spec: spec as JobSpec<unknown>,
      lane,
      state: "queued",
      progress: { message: `Waiting · ${spec.label}` },
      promise,
      start,
    };
    this.jobs.set(spec.key, job);
    this.changed();
    this.pump();
    return promise;
  }

  /** The jobs that are queued or running, oldest first. */
  snapshot(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => ({
      key: job.spec.key,
      lane: job.lane,
      label: job.spec.label,
      state: job.state,
      progress: job.progress,
    }));
  }

  /** Starts queued jobs, oldest first, while there is capacity and their
   * lane is free. */
  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.running >= this.options.concurrency) return;
      if (job.state === "queued" && !this.busyLanes.has(job.lane)) job.start();
    }
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
