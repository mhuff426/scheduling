// The named capabilities (ADR 0002): what a viewer may do, by name. Shared
// because the server sends a viewer's capabilities to the client, which uses
// them to show or hide controls. The client's copy is only a hint; the server
// works them out again on every request (server/capabilities.ts).
export const CAPABILITIES = [
  'managePeople',          // users, invites, roles
  'configureScheduling',   // shift types, settings, holidays
  'manageAwayTime',
  'buildSchedules',        // create, reassign, delete
  'manageOthersTimeOff',
  'seeEveryonesRecords',   // the projection's admin view, the full dump, another person's calendar export
] as const;

export type Capability = typeof CAPABILITIES[number];
