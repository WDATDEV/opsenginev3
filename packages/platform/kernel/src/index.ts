import {
  type Permission,
  type Role,
  rolePermissions,
} from "@opsengine/contracts";

export type Principal = {
  id: string;
  email: string;
  name: string;
  role: Role;
  clientIds: string[] | null;
};

export type RequestContext = {
  principal: Principal;
};

export class ForbiddenError extends Error {
  constructor(message = "You do not have access to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function can(principal: Principal, permission: Permission): boolean {
  return rolePermissions[principal.role]?.includes(permission) ?? false;
}

export function authorize(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx.principal, permission)) {
    throw new ForbiddenError();
  }
}

const warehouseWide: Role[] = ["owner", "warehouse_manager", "hr_finance", "warehouse_employee"];

export function visibleClientIds(principal: Principal): string[] | null {
  if (warehouseWide.includes(principal.role)) return null;
  return principal.clientIds ?? [];
}

export function canSeeClient(principal: Principal, clientId: string): boolean {
  const ids = visibleClientIds(principal);
  return ids === null || ids.includes(clientId);
}

export function assertClientVisible(principal: Principal, clientId: string): void {
  if (!canSeeClient(principal, clientId)) {
    throw new ForbiddenError("That client is outside your accounts.");
  }
}
