export {
  TrackingError,
  assertBillableJob,
  assertCanJoinShipment,
  assertDeviceLocation,
  assertCrewSource,
  assertSortPlacement,
  normalizeDevice,
  planPause,
  planTaskSwitch,
  resolvePacker,
  resolvePicker,
  taskFor,
  throwIfRejected,
  trackingPolicy,
} from "./domain/rules.js";

export type {
  Department,
  DeviceKind,
  LoginMode,
  Ownership,
  PackAttribution,
} from "./domain/rules.js";

export const tracking = {
  events: {
    PACK_RECORDED: "tracking.pack_recorded",
    PICK_RECORDED: "tracking.pick_recorded",
    TASK_SWITCHED: "tracking.task_switched",
    SHIPMENT_JOINED: "tracking.shipment_joined",
    CREW_JOINED: "tracking.crew_joined",
    SORT_SCANNED: "tracking.sort_scanned",
  },
} as const;
