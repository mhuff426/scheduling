# Scheduling

Builds shift schedules for a team, lets employees trade shifts, and settles each schedule against everyone's required shifts and vacation.

## Settlement

**Settlement**:
The accounting that turns a schedule's outcome into vacation charges, extra days and year balances for each person.
_Avoid_: Shift math, vacation accounting

**Counting shift**:
A shift that counts toward a person's required shifts. Every shift counts except standby shifts.
_Avoid_: Weighted shift

**Standby shift**:
A shift a person holds that doesn't count toward their required shifts.

**Required shifts**:
How many counting shifts a person owes in one schedule: their personal requirement, lowered to their shift maximum when that is smaller.
_Avoid_: Minimum, required floor, quota

**Must-off day**:
A day a person has asked to be off. The generator and admins must honour it unless it is unaffordable, and the person may still choose to work it through a trade. It can be covered by a vacation charge.
_Avoid_: Vacation request, hard off

**Shortfall**:
How many counting shifts a person is below their required shifts in a schedule.

**Vacation charge**:
One vacation day taken from a person's year balance to cover a shortfall caused by a must-off day or by giving a shift away. It belongs to the vacation year of the day it covers.
_Avoid_: Deduction, vacation used

**Charge cause**:
Why a vacation charge was made: **shortfall** (a must-off day covered when the schedule was generated), **giveaway** (a shift given away and claimed, dated on that shift's day) or **legacy** (migrated from a count saved before charges were dated, dated on its schedule's start date).

**Extra day**:
A counting shift or vacation charge beyond a person's required shifts in a schedule.
_Avoid_: Overtime, surplus

**Extra-day election**:
A person's choice of how to take their extra days in a schedule: as vacation days added to their year balance, or as incentive pay. When the schedule spans two vacation years, the person also chooses which year the vacation days go to.

**Vacation allowance**:
The vacation days a person is granted for each vacation year before any charges or elections.
_Avoid_: Vacation days (for the grant)

**Year balance**:
A person's vacation allowance plus the extra days they elected as vacation, minus their vacation charges, for one vacation year.
_Avoid_: Vacation available, remaining vacation

**Vacation year**:
The year a vacation charge or election counts toward. Currently the calendar year.

## Eligibility

**Eligible**:
A person is eligible for a shift when taking it breaks no hard rule and nothing the caller's policy blocks on (a must-off day, the consecutive-night limit or the shift maximum).
_Avoid_: Available, can take

**Hard rule**:
A rule no assignment may break: the person has a role the shift allows, has started, isn't on away time, works no other shift that day and gets 8 hours of rest around it.
_Avoid_: Safety rule

**Blocking reason**:
Why a person isn't eligible: the first hard rule broken, or the first limit the caller's policy blocks on, worded for that person.

**Eligibility warning**:
A must-off day or limit the caller's policy lets the person past, which whoever accepts must confirm first.
_Avoid_: Soft block

**Consecutive-night limit**:
The most overnight shifts in a row the generator will assign a person. An admin may go past it after an eligibility warning; a person may go past it by trading.
_Avoid_: Night cap

**Shift maximum**:
The most counting shifts the generator will assign a person in one schedule. A person may go over it by choosing to pick up or trade for more shifts.
_Avoid_: Max cap, ceiling

**Unaffordable must-off day**:
A must-off day in a vacation year where the person's must-off days in the schedule outnumber their year balance without that schedule's own vacation charges. The generator may schedule the person on it, while honouring it where coverage allows; an admin may reassign the person onto it after an eligibility warning.
_Avoid_: Soft off, downgraded must-off

**Schedulable day**:
A day in a schedule, with at least one shift, where the person has started, isn't on away time and has no must-off day other than an unaffordable one.

**Withdrawn must-off request**:
A must-off request its owner took back. It no longer protects the day but stays on record with who withdrew it and when. Only the person who made the request can withdraw it.
_Avoid_: Deleted vacation request
