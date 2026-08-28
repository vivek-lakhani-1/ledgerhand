import { describe, expect, it } from "vitest";
import { InterventionStore } from "../src/escalation/intervention-store.js";
import { startOperatorServer } from "../src/escalation/operator-server.js";
import { startConsoleServer } from "../src/console/console-server.js";
import { Redactor } from "../src/policy/redact.js";

// Express 5.1 invokes the listen callback error-first. The regression this pins down: a failed
// bind (port already taken) must reject, not resolve with a URL nothing is serving - with two
// concurrent replay runs, the second run's operator link silently pointed at the first run's
// server before this was caught.
const makeStore = (): InterventionStore =>
  new InterventionStore({ redactor: new Redactor({ secrets: [], piiValues: [] }) });

describe("server binds fail loudly", () => {
  it("operator server rejects with EADDRINUSE instead of reporting a dead server", async () => {
    const first = await startOperatorServer({ store: makeStore(), port: 4658 });
    try {
      await expect(startOperatorServer({ store: makeStore(), port: 4658 }))
        .rejects.toMatchObject({ code: "EADDRINUSE" });
      // An explicit ephemeral bind still works while the fixed port is held - the fallback
      // RunHost relies on.
      const second = await startOperatorServer({ store: makeStore(), port: 0 });
      expect(second.port).not.toBe(4658);
      expect(second.url).toContain(String(second.port));
      await second.close();
    } finally {
      await first.close();
    }
  });

  it("console server rejects when its port is taken", async () => {
    const first = await startConsoleServer({ port: 0 });
    try {
      await expect(startConsoleServer({ port: first.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
