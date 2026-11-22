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
A day a person has asked to be off that the schedule must honour, and that can be covered by a vacation charge.
_Avoid_: Vacation request, hard off

**Shortfall**:
How many counting shifts a person is below their required shifts in a schedule.

**Vacation charge**:
One vacation day taken from a person's year balance to cover a shortfall caused by a must-off day or by giving a shift away. It belongs to the vacation year of the day it covers.
_Avoid_: Deduction, vacation used

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
