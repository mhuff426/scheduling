# Employees see their own records; coworkers only by name and colour

Everything the server sends is cut down to what that viewer may see, by one projection that every read goes through. Admins see everything. An employee sees their own records in full and coworkers only as far as working together needs. Who is on vacation, how much vacation they are spending and the admin's notes about them are private to that person and the admins. Nobody is served anything without signing in.

We chose the narrowest view each screen can work with, not a "signed-in users see everything except obvious secrets" rule. Teams are small, so even counts can point to a person. A day that is full shows as full, and how many people are off and who they are stay hidden.

| | Admin | The person themselves | A coworker | Not signed in |
|---|---|---|---|---|
| User record | all fields | all fields | id, name, colour | nothing |
| Must-off days | all | their own | only which days are full | nothing |
| Away time | all, with memo | their own, without memo | nothing | nothing |
| Schedule assignments and unfilled slots | all | all | all | nothing |
| Vacation charges and extra-day elections | all | their own | nothing | nothing |
| Schedule warnings, counts, preference stats | all | nothing | nothing | nothing |
| Trades | all | ones they offered, were offered or claimed | open trades and giveaways still open to them | nothing |
| Admin tab, full state dump | yes | refused | refused | refused |

## Consequences

- Admin access is a set of named capabilities: manage people, configure scheduling, manage away time, build schedules, manage others' time off, and see everyone's records. Today every one of them comes from the admin role tag.
- The server sends the viewer's capabilities so the UI can show or hide controls. The UI's copy is only a hint. Every request is authenticated from its session and checked on the server against the viewer's current roles.
- The trade pickers only ever warn a person about their own must-off day, so a coworker's must-off day never shows up there.
- A new collection or tab is invisible to employees until the projection says what they may see of it.
