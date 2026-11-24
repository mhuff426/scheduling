// The capability module (ADR 0002): the one place that decides what a viewer
// may do. Worked out from the viewer's current roles on every call and never
// stored in the session, so a role change takes effect on the next request.
// Today every capability comes from the admin role tag.
import { CAPABILITIES, type Capability } from '../shared/capabilities.js';
import type { User } from '../shared/types.js';

export type { Capability };

const ADMIN_ROLE = 'role-admin';

/** Whether this viewer may do the named thing. */
export function can(viewer: User, capability: Capability): boolean {
  return (viewer.roles || []).includes(ADMIN_ROLE);
}

/** Every capability this viewer has, for sending to the client. */
export function capabilitiesOf(viewer: User): Capability[] {
  return CAPABILITIES.filter((c) => can(viewer, c));
}
