import { describe, expect, it } from "vitest";
import { authorize, can, ForbiddenError, type Principal } from "./index.js";

const manager: Principal = {
  id: "1",
  email: "nora@opsengine.local",
  name: "Nora Ellis",
  role: "warehouse_manager",
  clientIds: null,
};

describe("kernel authorize", () => {
  it("lets a warehouse manager record and manage tracking", () => {
    expect(can(manager, "tracking.manage")).toBe(true);
    expect(() => authorize({ principal: manager }, "tracking.record")).not.toThrow();
  });

  it("keeps client services out of labor tracking", () => {
    const services: Principal = { ...manager, role: "client_services" };
    expect(can(services, "tracking.read")).toBe(false);
    expect(() => authorize({ principal: services }, "tracking.read")).toThrow(ForbiddenError);
  });
});
