// Client half of the confirmation contract (ADR 0001, ../../shared/confirmation.ts).
// The server refuses a mutation that produces eligibility warnings with
// CONFIRM_WARNINGS_CODE and the warnings; we show one confirm dialog listing
// them all and resend confirming those exact warnings. The server checks again
// on every resend, so new warnings are asked about again and a hard rule still
// refuses. The client never evaluates a rule itself.

import { CONFIRM_WARNINGS_CODE, confirmedWarningsOf } from '../../shared/confirmation.js';
import type { ConfirmationRefusal } from '../../shared/confirmation.js';

// The outcome when the person declines the dialog: nothing was changed.
export const DECLINED = Symbol('declined');

// `send` makes the request, passing `confirmedWarnings` through to the body.
// Resolves to DECLINED when the person declines the dialog.
export async function withConfirmedWarnings<T>(
  send: (confirmedWarnings: string[] | undefined) => Promise<T>
): Promise<T | typeof DECLINED> {
  let confirmed: string[] | undefined;
  for (;;) {
    try {
      return await send(confirmed);
    } catch (e) {
      const err = e as { code?: string; data?: Partial<ConfirmationRefusal> };
      const warnings = err.code === CONFIRM_WARNINGS_CODE ? err.data?.warnings : undefined;
      if (!warnings?.length) throw e;
      const ok = confirm(
        `Please confirm:\n\n${warnings.map((w) => `• ${w.message}`).join('\n')}\n\nGo ahead anyway?`
      );
      if (!ok) return DECLINED;
      confirmed = confirmedWarningsOf(warnings);
    }
  }
}
