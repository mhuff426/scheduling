// The confirmation contract (ADR 0001), shared by server and client. A
// mutation that produces eligibility warnings is refused with
// CONFIRM_WARNINGS_CODE and the warnings, until the request lists every
// warning it now triggers, by message, in `confirmedWarnings`.

export const CONFIRM_WARNINGS_CODE = 'eligibility_warnings';

export interface EligibilityWarning {
  kind: 'must-off day' | 'shift maximum' | 'consecutive-night limit';
  message: string;
}

// The refusal's response body (sent with HTTP 409).
export interface ConfirmationRefusal {
  error: string;
  code: typeof CONFIRM_WARNINGS_CODE;
  warnings: EligibilityWarning[];
}

export function confirmationRefusal(warnings: EligibilityWarning[]): ConfirmationRefusal {
  return { error: warnings.map((w) => w.message).join(' '), code: CONFIRM_WARNINGS_CODE, warnings };
}

// What a request sends to confirm the warnings it was shown.
export const confirmedWarningsOf = (warnings: EligibilityWarning[]): string[] => warnings.map((w) => w.message);
