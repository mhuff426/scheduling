# Domain commands return outcomes; a refusal rolls back unless it says to persist

Every rule that changes data lives in a command module (`trades.ts`, `schedules.ts`, `people.ts` and the rest), not in a route handler. A command takes the data, a context of `{ actor, today }` and its input. It checks the actor's capability itself and returns either a success or a refusal with a reason: `unauthenticated`, `forbidden`, `not_found`, `invalid`, `conflict`, `stale` or `unconfirmed` (carrying eligibility warnings). One route adapter turns refusals into HTTP status codes, so commands never mention HTTP and can be tested against an in-memory `Db`.

We chose returns over throws because some refusals have to keep a change: a trade that finds itself stale expires, and that has to be saved even though the request is refused. Throwing would roll that back. Always committing would quietly save half a change from any command that mutated before it refused. So a refusal rolls the transaction back by default, and a command that means to keep its change sets `persist: true` on the refusal. Today only the trade-expiry paths do.

## Consequences

- No domain code throws `HttpError`. A thrown error is a bug or an infrastructure failure, and it comes back as a 500 or 503.
- Commands take `today` from their context instead of reading the clock, so tests can check the boundary on today's date directly.
- The refusal reasons extend the projection's existing `Refusal` type, so reads and writes refuse the same way. The wire codes the client already reads (`version_conflict` and the confirmation code) stay the same.
- Rules the client also needs, such as the cadence change rule, live in `shared/` and are called by both the command and the UI, the same way as `shared/settlement.ts`.
