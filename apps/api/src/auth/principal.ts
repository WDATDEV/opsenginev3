import { resolveSections, type Role } from "@opsengine/contracts";
import type { Principal } from "@opsengine/kernel";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  clientIds: string[] | null;
  sections?: string[] | null;
};

export function principalFromUser(row: UserRow): Principal {
  const role = row.role as Role;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    clientIds: Array.isArray(row.clientIds) ? row.clientIds : null,
    sections: resolveSections(role, row.sections),
  };
}
