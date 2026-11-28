import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface AudioProcess {
  readonly pid: number | undefined;
  kill(signal: "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL"): boolean;
  onExit(listener: (code: number | null) => void): void;
}

export interface PlayerDeps {
  readonly spawnPlayer: (file: string) => AudioProcess;
  readonly nowMs: () => number;
}

class NodeAudioProcess implements AudioProcess {
  constructor(private readonly child: ChildProcess) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  kill(signal: "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL"): boolean {
    return this.child.kill(signal);
  }

  onExit(listener: (code: number | null) => void): void {
    this.child.on("exit", (code) => {
      listener(code);
    });
  }
}

export type TimelineState = "playing" | "paused" | "stopped" | "done";

export class AudioTimeline {
  private process: AudioProcess | undefined;
  private accumulatedMs = 0;
  private segmentStartMs = 0;
  private state: TimelineState = "stopped";
  private pauses = 0;

  constructor(
    private readonly deps: PlayerDeps,
    private readonly file: string,
  ) {}

  get timelineState(): TimelineState {
    return this.state;
  }

  get pauseCount(): number {
    return this.pauses;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.process = this.deps.spawnPlayer(this.file);
    this.process.onExit(() => {
      if (this.state === "playing" || this.state === "paused") {
        this.freeze();
        this.state = "done";
      }
    });
    this.segmentStartMs = this.deps.nowMs();
    this.state = "playing";
  }

  pause(): void {
    if (this.state !== "playing" || this.process === undefined) return;
    this.process.kill("SIGSTOP");
    this.freeze();
    this.state = "paused";
    this.pauses += 1;
  }

  resume(): void {
    if (this.state !== "paused" || this.process === undefined) return;
    this.segmentStartMs = this.deps.nowMs();
    this.process.kill("SIGCONT");
    this.state = "playing";
  }

  stop(): void {
    if (this.state === "stopped" || this.state === "done") return;
    this.freeze();
    this.process?.kill("SIGTERM");
    this.state = "stopped";
  }

  positionMs(): number {
    if (this.state === "playing") {
      return this.accumulatedMs + (this.deps.nowMs() - this.segmentStartMs);
    }
    return this.accumulatedMs;
  }

  private freeze(): void {
    if (this.state === "playing") {
      this.accumulatedMs += this.deps.nowMs() - this.segmentStartMs;
    }
  }
}

export function nodePlayerDeps(): PlayerDeps {
  return {
    spawnPlayer: (file) => new NodeAudioProcess(nodeSpawn("afplay", [file])),
    nowMs: () => performance.now(),
  };
}
