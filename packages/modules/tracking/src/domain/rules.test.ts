import { describe, expect, it } from "vitest";
import {
  assertCanJoinShipment,
  assertDeviceLocation,
  assertCrewSource,
  assertSortPlacement,
  normalizeDevice,
  planTaskSwitch,
  resolvePacker,
  resolvePicker,
} from "./rules.js";

const amina = "amina";
const luis = "luis";

describe("packing identity", () => {
  it("uses the Warehance user on an individual login", () => {
    const result = resolvePacker({
      loginMode: "individual",
      warehanceMappedEmployeeId: amina,
    });
    expect(result).toMatchObject({
      ok: true,
      employeeId: amina,
      attribution: "warehance_user",
      loginMismatch: false,
    });
  });

  it("requires a badge when the packing computer is a shared login", () => {
    const result = resolvePacker({ loginMode: "shared" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shared Warehance login/);
  });

  it("records the badged packer on a shared computer even when Warehance has no person", () => {
    const result = resolvePacker({
      loginMode: "shared",
      badgeEmployeeId: luis,
    });
    expect(result).toMatchObject({
      ok: true,
      employeeId: luis,
      attribution: "station_badge",
    });
  });

  it("keeps the badge when an individual login belongs to someone else", () => {
    const result = resolvePacker({
      loginMode: "individual",
      warehanceMappedEmployeeId: amina,
      badgeEmployeeId: luis,
    });
    expect(result).toMatchObject({
      ok: true,
      employeeId: luis,
      attribution: "station_badge",
      loginMismatch: true,
    });
  });

  it("uses an open station session when the shared computer was already claimed", () => {
    const result = resolvePacker({
      loginMode: "shared",
      stationSessionEmployeeId: luis,
    });
    expect(result).toMatchObject({ ok: true, employeeId: luis, attribution: "station_badge" });
  });
});

describe("picking devices", () => {
  it("counts a pick on a personal scanner without a second login", () => {
    const result = resolvePicker({
      kind: "barcode_scanner",
      ownership: "personal",
      assignedEmployeeId: "priya",
    });
    expect(result).toMatchObject({ ok: true, employeeId: "priya", via: "personal_device" });
  });

  it("refuses someone else's personal scanner", () => {
    const result = resolvePicker({
      kind: "barcode_scanner",
      ownership: "personal",
      assignedEmployeeId: "priya",
      badgeEmployeeId: "jonah",
    });
    expect(result.ok).toBe(false);
  });

  it("requires a checkout or badge on a shared handheld", () => {
    expect(
      resolvePicker({ kind: "handheld", ownership: "shared_pool" }).ok,
    ).toBe(false);

    expect(
      resolvePicker({
        kind: "handheld",
        ownership: "shared_pool",
        checkoutEmployeeId: "jonah",
      }),
    ).toMatchObject({ ok: true, employeeId: "jonah", via: "shared_device" });
  });

  it("does not accept a packing computer as a pick device", () => {
    const result = resolvePicker({
      kind: "packing_computer",
      ownership: "personal",
      assignedEmployeeId: amina,
    });
    expect(result.ok).toBe(false);
  });
});

describe("receiving and unloading", () => {
  it("lets a second employee join a shipment that already has someone on it", () => {
    const result = assertCanJoinShipment({
      status: "receiving",
      activeWorkerIds: ["mei"],
      employeeId: "andre",
    });
    expect(result).toMatchObject({ ok: true, concurrent: true });
  });

  it("blocks joining a closed shipment", () => {
    expect(
      assertCanJoinShipment({
        status: "closed",
        activeWorkerIds: [],
        employeeId: "mei",
      }).ok,
    ).toBe(false);
  });

  it("lets a badge join a truck, and keeps paper crew lists for a lead", () => {
    expect(assertCrewSource({ source: "badge", actorCanManage: false })).toMatchObject({
      ok: true,
    });
    expect(assertCrewSource({ source: "paper", actorCanManage: false }).ok).toBe(false);
    expect(assertCrewSource({ source: "lead_added", actorCanManage: true })).toMatchObject({
      ok: true,
    });
  });
});

describe("sorting, task changes, and equipment", () => {
  it("requires a reason when a package is placed in a gaylord without a scan", () => {
    expect(
      assertSortPlacement({ method: "manual_place", gaylordStatus: "open" }).ok,
    ).toBe(false);
    expect(
      assertSortPlacement({
        method: "manual_place",
        gaylordStatus: "open",
        reason: "Label unreadable, verified by lead",
      }).ok,
    ).toBe(true);
  });

  it("refuses a second scan of a tracking number", () => {
    const result = assertSortPlacement({
      method: "scan",
      gaylordStatus: "open",
      duplicateGaylordCode: "GL-USPS-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/GL-USPS-1/);
  });

  it("closes the previous task immediately when the employee switches", () => {
    const plan = planTaskSwitch({
      open: { id: "seg-1", department: "packing", taskCode: "pack_orders" },
      next: { department: "sorting", taskCode: "sort_gaylord" },
    });
    expect(plan).toEqual({ closeId: "seg-1", start: true });
  });

  it("keeps the same open task when the work has not changed", () => {
    const plan = planTaskSwitch({
      open: { id: "seg-1", department: "picking", taskCode: "pick_batch" },
      next: { department: "picking", taskCode: "pick_batch" },
    });
    expect(plan).toEqual({ closeId: null, start: false });
  });

  it("registers both personal scanners and shared packing computers", () => {
    expect(
      normalizeDevice({
        kind: "barcode_scanner",
        ownership: "personal",
        warehanceLoginMode: "none",
        assignedEmployeeId: "priya",
      }).ok,
    ).toBe(true);

    expect(
      normalizeDevice({
        kind: "packing_computer",
        ownership: "shared_pool",
        warehanceLoginMode: "shared",
      }).ok,
    ).toBe(true);

    expect(
      normalizeDevice({
        kind: "packing_computer",
        ownership: "personal",
        warehanceLoginMode: "individual",
      }).ok,
    ).toBe(false);
  });
});

describe("device location", () => {
  const now = 1_700_000_000_000;
  const warehouse = { latitude: 6.9, longitude: 79.86, radiusMeters: 250 };

  it("accepts a fresh precise reading inside the warehouse", () => {
    const result = assertDeviceLocation({
      latitude: 6.9004,
      longitude: 79.8602,
      accuracy: 18,
      capturedAt: now - 2_000,
      now,
      site: warehouse,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a scan with no device location", () => {
    const result = assertDeviceLocation({ now, site: warehouse });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/did not share its location/);
  });

  it("refuses a vague or stale reading", () => {
    expect(
      assertDeviceLocation({
        latitude: 6.9,
        longitude: 79.86,
        accuracy: 5_000,
        capturedAt: now,
        now,
        site: warehouse,
      }).ok,
    ).toBe(false);
    expect(
      assertDeviceLocation({
        latitude: 6.9,
        longitude: 79.86,
        accuracy: 12,
        capturedAt: now - 60_000,
        now,
        site: warehouse,
      }).ok,
    ).toBe(false);
  });

  it("refuses a precise reading that is away from the warehouse", () => {
    const result = assertDeviceLocation({
      latitude: 34.05,
      longitude: -118.24,
      accuracy: 10,
      capturedAt: now,
      now,
      site: warehouse,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not at the warehouse/);
      expect(result.distanceMeters).toBeGreaterThan(250);
    }
  });
});
