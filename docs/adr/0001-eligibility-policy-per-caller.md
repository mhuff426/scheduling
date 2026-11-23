# Eligibility rules differ by who makes the assignment

One eligibility module decides whether a person may take a shift. It is used by the generator, by admin reassign and by trades. Each caller passes its own policy, because the limits mean different things depending on who is choosing. The shift maximum and the consecutive-night limit say how much the *generator* should hand someone. A person choosing extra shifts or nights through a trade is making their own call. An admin is overriding the generator, so they get a warning to confirm rather than a refusal. Must-off days protect the person, so only the person can give up one they can afford: an admin can't override it, and has to ask the person to withdraw the request, which leaves a record.

| | Generator | Admin reassign | Trades |
|---|---|---|---|
| Hard rules (role, started, away time, one shift a day, 8h rest) | block | block | block |
| Affordable must-off day | block | block | warn the person, who confirms |
| Unaffordable must-off day (recomputed live) | allowed, honoured where it can be | warn the admin, who confirms | warn the person, who confirms |
| Consecutive-night limit | block | warn the admin, who confirms | ignored |
| Shift maximum | block | warn the admin, who confirms | ignored |

## Consequences

- In a trade, the only warning is for a must-off day, and it goes only to the person who would end up working on their own must-off day. They confirm when they take part: the person offering confirms before offering, and the person accepting confirms before accepting. If neither ends up on a must-off day, nobody is warned. If both do, both are. A party's warnings are checked only at their own step: if they add a must-off day for that date after taking part, the swap still completes, and it is theirs to resolve. Hard rules are still re-checked for both parties at the final step.
- Warnings are worked out on the server and returned with the eligibility answer. The reassign and trade endpoints refuse until the request says the warning was confirmed, so the client never keeps its own copy of the rules.
- "Unaffordable" is recomputed from the year balance without the schedule's own vacation charges, so a schedule's settlement doesn't change which of its must-off days count as protected.
- A person can now end up working a must-off day after the schedule was generated, through a trade or an admin reassign, so that schedule's settlement has to cope with it.
