// People and roles: the roster and the role tags people and shift types carry.
// Every command needs the managePeople capability.
//
// Each command takes the data, a context of { actor, today } and its input,
// and returns an Outcome (./outcome.ts, ADR 0003). Commands mutate the passed
// db but never persist: the route adapter runs them in a transaction, which a
// refusal rolls back. Credentials, invites and the auth tables live outside
// the data, so the routes handle them after the command commits.

import { newId } from './db.js';
import { can } from './capabilities.js';
import { ok, refuse, type CommandContext, type Outcome, type Refused } from './outcome.js';
import { bumpVersion, staleRefusal } from './staleness.js';
import { isDate } from '../shared/blocks.js';
import type { Db, RoleTag, User } from '../shared/types.js';

const EMPLOYEE_ROLE = 'role-employee';

// Pastel assignment colors. Each pairs with near-black chip text at >= 7:1
// (WCAG AAA) — see client/src/contrast.ts (safeBg/CHIP_INK) and the chip styles.
const PALETTE = [
  '#fca5a5', '#fdba74', '#fcd34d', '#bef264', '#86efac',
  '#5eead4', '#67e8f9', '#7dd3fc', '#93c5fd', '#a5b4fc',
  '#c4b5fd', '#d8b4fe', '#f0abfc', '#f9a8d4', '#fda4af',
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const forbidden = (actor: User): Refused | null =>
  can(actor, 'managePeople') ? null : refuse('forbidden', 'Admin access required.');

// The one role fix-up: keep only roles that exist, and always the Employee role.
function fixRoles(db: Db, roles: unknown): string[] {
  const valid = new Set(db.roles.map((r) => r.id));
  const next = (Array.isArray(roles) ? roles : []).filter((id): id is string => valid.has(id));
  if (!next.includes(EMPLOYEE_ROLE)) next.push(EMPLOYEE_ROLE);
  return next;
}

// A trimmed, lower-cased email no one else (but `selfId`) has, or a refusal.
function checkEmail(db: Db, email: unknown, selfId?: string): string | Refused {
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(e)) return refuse('invalid', 'A valid email is required.');
  if (db.users.some((u) => u.id !== selfId && u.email?.toLowerCase() === e))
    return refuse('conflict', 'A user with that email already exists.');
  return e;
}

export interface NewPerson {
  firstName?: unknown; lastName?: unknown; email?: unknown; employeeId?: unknown;
  roles?: unknown; vacationDays?: unknown; startDate?: unknown;
}

/** Adds a person to the roster. The route then creates their credentials and invite. */
export function createPerson(db: Db, { actor }: CommandContext, input: NewPerson): Outcome<User> {
  const no = forbidden(actor);
  if (no) return no;
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  if (!firstName || !lastName) return refuse('invalid', 'First and last name are required.');
  const email = checkEmail(db, input.email);
  if (typeof email !== 'string') return email;
  const user: User = {
    id: newId('u'),
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    email,
    employeeId: input.employeeId ? String(input.employeeId).trim() || null : null,
    roles: fixRoles(db, input.roles),
    vacationDays: Math.max(0, Number(input.vacationDays) || 0),
    color: PALETTE[db.users.length % PALETTE.length],
    startDate: isDate(input.startDate) ? input.startDate : null,
  };
  db.users.push(user);
  return ok(user);
}

// The last-admin guard: someone must always be able to manage people.
const managesPeople = (u: User) => can(u, 'managePeople');
const isLastAdmin = (db: Db, user: User) =>
  managesPeople(user) && db.users.filter(managesPeople).length === 1;

// A nullable count field: null/'' clears it, anything else is at least `min`.
const countOrNull = (v: unknown, min: number) => (v === null || v === '' ? null : Math.max(min, Number(v) || min));

export interface PersonEdit {
  id: string; expectedVersion?: unknown;
  firstName?: unknown; lastName?: unknown; name?: unknown; email?: unknown; employeeId?: unknown;
  roles?: unknown; vacationDays?: unknown; requiredShifts?: unknown; maxConsecutiveNights?: unknown;
  maxShiftsOverride?: unknown; startDate?: unknown; color?: unknown; theme?: unknown;
}

/** Edits the given fields of a person's profile. The last admin keeps the Admin role. */
export function editPerson(db: Db, { actor }: CommandContext, input: PersonEdit): Outcome<User> {
  const no = forbidden(actor);
  if (no) return no;
  const user = db.users.find((u) => u.id === input.id);
  if (!user) return refuse('not_found', 'User not found.');
  const stale = staleRefusal(user, input.expectedVersion, `${user.name}'s profile`);
  if (stale) return stale;
  let nameChanged = false;
  if (input.firstName !== undefined) {
    const f = String(input.firstName).trim();
    if (!f) return refuse('invalid', 'First name cannot be empty.');
    user.firstName = f;
    nameChanged = true;
  }
  if (input.lastName !== undefined) {
    user.lastName = String(input.lastName).trim();
    nameChanged = true;
  }
  if (nameChanged) user.name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.name;
  if (input.email !== undefined) {
    const email = checkEmail(db, input.email, user.id);
    if (typeof email !== 'string') return email;
    user.email = email;
  }
  if (input.employeeId !== undefined) {
    user.employeeId = input.employeeId === null || input.employeeId === '' ? null : String(input.employeeId).trim() || null;
  }
  if (input.name !== undefined && !input.firstName && !input.lastName) user.name = String(input.name).trim() || user.name;
  if (input.roles !== undefined) {
    const next = fixRoles(db, input.roles);
    if (!managesPeople({ ...user, roles: next }) && isLastAdmin(db, user)) {
      return refuse('invalid', `${user.name} is the only admin. Make someone else an admin first.`);
    }
    user.roles = next;
  }
  if (input.vacationDays !== undefined) user.vacationDays = Math.max(0, Number(input.vacationDays) || 0);
  if (input.requiredShifts !== undefined) user.requiredShifts = countOrNull(input.requiredShifts, 0);
  if (input.maxConsecutiveNights !== undefined) user.maxConsecutiveNights = countOrNull(input.maxConsecutiveNights, 1);
  if (input.maxShiftsOverride !== undefined) user.maxShiftsOverride = countOrNull(input.maxShiftsOverride, 1);
  if (input.startDate !== undefined) {
    const d = input.startDate;
    user.startDate = d === null || d === '' ? null : (isDate(d) ? d : user.startDate);
  }
  if (typeof input.color === 'string') user.color = input.color;
  if (input.theme !== undefined) user.theme = input.theme === 'dark' ? 'dark' : 'light';
  bumpVersion(user);
  return ok(user);
}

/** Removes a person with their must-off days and away time. The route then clears their auth rows. */
export function removePerson(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const no = forbidden(actor);
  if (no) return no;
  const user = db.users.find((u) => u.id === id);
  if (!user) return refuse('not_found', 'User not found.');
  if (isLastAdmin(db, user)) {
    return refuse('invalid', `${user.name} is the only admin and can't be removed. Make someone else an admin first.`);
  }
  db.users = db.users.filter((u) => u.id !== id);
  db.timeOff = db.timeOff.filter((t) => t.userId !== id);
  db.awayTime = db.awayTime.filter((a) => a.userId !== id);
  return ok({ ok: true });
}

// ---- roles (capability tags; Admin and Employee are system roles) ----

// A trimmed role name no other role (but `selfId`) has, or a refusal.
function checkRoleName(db: Db, name: unknown, selfId?: string): string | Refused {
  const n = String(name || '').trim();
  if (!n) return refuse('invalid', 'Role name is required.');
  if (db.roles.some((r) => r.id !== selfId && r.name.toLowerCase() === n.toLowerCase()))
    return refuse('invalid', 'A role with that name already exists.');
  return n;
}

export function createRole(db: Db, { actor }: CommandContext, input: { name?: unknown }): Outcome<RoleTag> {
  const no = forbidden(actor);
  if (no) return no;
  const name = checkRoleName(db, input.name);
  if (typeof name !== 'string') return name;
  const role: RoleTag = { id: newId('role'), name };
  db.roles.push(role);
  return ok(role);
}

export function renameRole(
  db: Db, { actor }: CommandContext, input: { id: string; name?: unknown; expectedVersion?: unknown }
): Outcome<RoleTag> {
  const no = forbidden(actor);
  if (no) return no;
  const role = db.roles.find((r) => r.id === input.id);
  if (!role) return refuse('not_found', 'Role not found.');
  if (role.system) return refuse('invalid', 'System roles cannot be renamed.');
  const stale = staleRefusal(role, input.expectedVersion, `The role "${role.name}"`);
  if (stale) return stale;
  const name = checkRoleName(db, input.name, role.id);
  if (typeof name !== 'string') return name;
  role.name = name;
  bumpVersion(role);
  return ok(role);
}

/** Deletes a role, removing it from every person and every shift type. */
export function deleteRole(db: Db, { actor }: CommandContext, { id }: { id: string }): Outcome<{ ok: true }> {
  const no = forbidden(actor);
  if (no) return no;
  const role = db.roles.find((r) => r.id === id);
  if (!role) return refuse('not_found', 'Role not found.');
  if (role.system) return refuse('invalid', 'System roles cannot be deleted.');
  for (const u of db.users) u.roles = (u.roles || []).filter((r) => r !== id);
  for (const st of db.shiftTypes) st.allowedRoles = (st.allowedRoles || []).filter((r) => r !== id);
  db.roles = db.roles.filter((r) => r.id !== id);
  return ok({ ok: true });
}
