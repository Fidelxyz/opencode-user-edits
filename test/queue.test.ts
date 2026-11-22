import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "../src/queue.ts";

describe("KeyedQueue", () => {
  it("runs the next task after a failed one", async () => {
    const queue = createKeyedQueue();

    const failed = queue.run("key", () => Promise.reject(new Error("boom")));
    const next = queue.run("key", async () => "done");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("done");
  });

  it("idle resolves after the key's submitted tasks settle", async () => {
    const queue = createKeyedQueue();
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));

    void queue.run("key", async () => {
      await gate;
      events.push("task");
    });
    const idle = queue.idle("key").then(() => events.push("idle"));
    release();
    await idle;

    expect(events).toEqual(["task", "idle"]);
  });
});
