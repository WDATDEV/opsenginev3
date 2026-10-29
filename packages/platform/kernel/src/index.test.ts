import { describe, expect, it } from "vitest";
import { assertClientVisible, authorize, can, ForbiddenError, type Principal } from "./index.js";

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

  it("lets client services manage their own jobs and keeps them off the floor", () => {
    const services: Principal = { ...manager, role: "client_services", clientIds: ["ice"] };
    expect(can(services, "job.manage")).toBe(true);
    expect(can(services, "billing.read")).toBe(true);
    expect(can(services, "tracking.read")).toBe(false);
    expect(can(services, "billing.approve")).toBe(false);
    expect(() => authorize({ principal: services }, "tracking.read")).toThrow(ForbiddenError);
  });

  it("lets an external customer read one client's jobs", () => {
    const guest: Principal = { ...manager, role: "external_customer", clientIds: ["ice"] };
    expect(can(guest, "job.read")).toBe(true);
    expect(can(guest, "job.manage")).toBe(false);
    expect(() => assertClientVisible(guest, "ice")).not.toThrow();
    expect(() => assertClientVisible(guest, "jacob")).toThrow(ForbiddenError);
  });

  it("lets the warehouse see every client", () => {
    expect(() => assertClientVisible(manager, "jacob")).not.toThrow();
  });
});
