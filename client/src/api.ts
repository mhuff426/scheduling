import type { Slot } from '../../shared/types.js';
import { noteVersion } from './versions';

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
  updateUser: (id: string, u: any) =>
    request('PUT', `/api/users/${id}`, u).then((r) => { noteVersion('users', id, r.version); return r; }),
  deleteUser: (id: string) => request('DELETE', `/api/users/${id}`),
  addShiftType: (s: any) => request('POST', '/api/shift-types', s),
  updateShiftType: (id: string, s: any) =>
    request('PUT', `/api/shift-types/${id}`, s).then((r) => { noteVersion('shiftTypes', id, r.version); return r; }),
  deleteShiftType: (id: string) => request('DELETE', `/api/shift-types/${id}`),
  updateSettings: (s: any) =>
    request('PUT', '/api/settings', s).then((r) => { noteVersion('settings', 'settings', r.version); return r; }),
  addTimeOff: (t: any) => request('POST', '/api/timeoff', t),
  deleteTimeOff: (id: string) => request('DELETE', `/api/timeoff/${id}`),
  addRole: (r: any) => request('POST', '/api/roles', r),
  updateRole: (id: string, r: any) =>
    request('PUT', `/api/roles/${id}`, r).then((x) => { noteVersion('roles', id, x.version); return x; }),
  deleteRole: (id: string) => request('DELETE', `/api/roles/${id}`),
  addAwayTime: (a: any) => request('POST', '/api/awaytime', a),
  updateAwayTime: (id: string, a: any) =>
    request('PUT', `/api/awaytime/${id}`, a).then((r) => { noteVersion('awayTime', id, r.version); return r; }),
  deleteAwayTime: (id: string) => request('DELETE', `/api/awaytime/${id}`),
  addHoliday: (h: any) => request('POST', '/api/holidays', h),
  updateHoliday: (id: string, h: any) =>
    request('PUT', `/api/holidays/${id}`, h).then((r) => { noteVersion('holidays', id, r.version); return r; }),
  deleteHoliday: (id: string) => request('DELETE', `/api/holidays/${id}`),
  createSchedule: (s: any) => request('POST', '/api/schedules', s),
  reassign: (scheduleId: string, move: any) => request('POST', `/api/schedules/${scheduleId}/reassign`, move),
  createTrade: (t: any) => request('POST', '/api/trades', t),
  respondTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/respond`, body),
  withdrawResponse: (id: string, body: any) => request('POST', `/api/trades/${id}/withdraw`, body),
  acceptTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/accept`, body),
  rejectTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/reject`, body),
  claimTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/claim`, body),
  cancelTrade: (id: string, body: any) => request('POST', `/api/trades/${id}/cancel`, body),
  // Per-tab reads plus the two cross-tab resources (their own endpoints so
  // they can become SSE streams later without touching the tab payloads).
  getTab: (tab: string) => request('GET', `/api/tabs/${encodeURIComponent(tab)}`),
  getUsers: () => request('GET', '/api/users'),
  getNotifications: (userId: string) =>
    request('GET', `/api/notifications?userId=${encodeURIComponent(userId)}`),
  markNotificationsRead: (userId: string) => request('PUT', '/api/notifications/read', { userId }),
  dismissNotification: (id: string, userId: string) =>
    request('PUT', `/api/notifications/${id}/dismiss`, { userId }),
  dismissAllNotifications: (userId: string) => request('PUT', '/api/notifications/dismiss', { userId }),
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
