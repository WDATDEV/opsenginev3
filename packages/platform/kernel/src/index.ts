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
