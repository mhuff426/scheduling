async function request(method, url, body) {
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
  addUser: (u) => request('POST', '/api/users', u),
  updateUser: (id, u) => request('PUT', `/api/users/${id}`, u),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  addShiftType: (s) => request('POST', '/api/shift-types', s),
  updateShiftType: (id, s) => request('PUT', `/api/shift-types/${id}`, s),
  deleteShiftType: (id) => request('DELETE', `/api/shift-types/${id}`),
  updateSettings: (s) => request('PUT', '/api/settings', s),
  addTimeOff: (t) => request('POST', '/api/timeoff', t),
  deleteTimeOff: (id) => request('DELETE', `/api/timeoff/${id}`),
  createSchedule: (s) => request('POST', '/api/schedules', s),
  reassign: (scheduleId, move) => request('POST', `/api/schedules/${scheduleId}/reassign`, move),
  createTrade: (t) => request('POST', '/api/trades', t),
  respondTrade: (id, body) => request('POST', `/api/trades/${id}/respond`, body),
  withdrawResponse: (id, body) => request('POST', `/api/trades/${id}/withdraw`, body),
  acceptTrade: (id, body) => request('POST', `/api/trades/${id}/accept`, body),
  rejectTrade: (id, body) => request('POST', `/api/trades/${id}/reject`, body),
  claimTrade: (id, body) => request('POST', `/api/trades/${id}/claim`, body),
  cancelTrade: (id, body) => request('POST', `/api/trades/${id}/cancel`, body),
  markNotificationsRead: (userId) => request('PUT', '/api/notifications/read', { userId }),
  electExtra: (scheduleId, body) => request('PUT', `/api/schedules/${scheduleId}/extra-election`, body),
  deleteSchedule: (id) => request('DELETE', `/api/schedules/${id}`),
};
