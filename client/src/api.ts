import type { Slot } from '../../shared/types.js';

async function request(method: string, url: string, body?: any): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  getState: () => request('GET', '/api/state'),
  addUser: (u: any) => request('POST', '/api/users', u),
  updateUser: (id: string, u: any) => request('PUT', `/api/users/${id}`, u),
  deleteUser: (id: string) => request('DELETE', `/api/users/${id}`),
  addShiftType: (s: any) => request('POST', '/api/shift-types', s),
  updateShiftType: (id: string, s: any) => request('PUT', `/api/shift-types/${id}`, s),
  deleteShiftType: (id: string) => request('DELETE', `/api/shift-types/${id}`),
  updateSettings: (s: any) => request('PUT', '/api/settings', s),
  addTimeOff: (t: any) => request('POST', '/api/timeoff', t),
  deleteTimeOff: (id: string) => request('DELETE', `/api/timeoff/${id}`),
  createSchedule: (s: any) => request('POST', '/api/schedules', s),
  reassign: (scheduleId: string, move: any) => request('POST', `/api/schedules/${scheduleId}/reassign`, move),
  createTrade: (t: any) => request('POST', '/api/trades', t),
  respondTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/respond`, body),
  withdrawResponse: (id: string, body: any) => request('POST', `/api/trades/${id}/withdraw`, body),
  acceptTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/accept`, body),
  rejectTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/reject`, body),
  claimTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/claim`, body),
  cancelTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/cancel`, body),
  markNotificationsRead: (userId: string) => request('PUT', '/api/notifications/read', { userId }),
  electExtra: (scheduleId: string, body: any) => request('PUT', `/api/schedules/${scheduleId}/extra-election`, body),
  tradeOptions: (scheduleId: string, userId: string) =>
    request('GET', `/api/schedules/${scheduleId}/trade-options?userId=${encodeURIComponent(userId)}`),
  swapPartners: (scheduleId: string, userId: string, slot: Slot) =>
    request(
      'GET',
      `/api/schedules/${scheduleId}/swap-partners?userId=${encodeURIComponent(userId)}` +
        `&date=${encodeURIComponent(slot.date)}&shiftTypeId=${encodeURIComponent(slot.shiftTypeId)}`
    ),
  deleteSchedule: (id: string) => request('DELETE', `/api/schedules/${id}`),
};
