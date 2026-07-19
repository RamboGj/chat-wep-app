import { apiFetch } from '@/lib/api'
import type { User } from '@/types/api'

export interface SignupPayload {
  username: string
  email: string
  password: string
}

export interface LoginPayload {
  email: string
  password: string
}

export const authApi = {
  /** Creates the account. It does not log the user in — no cookies are set. */
  signup: (payload: SignupPayload) =>
    apiFetch<{ user_id: string }>('/auth/signup', {
      method: 'POST',
      body: payload,
      skipRefresh: true,
    }),

  /** Sets the httpOnly access + refresh cookies. */
  login: (payload: LoginPayload) =>
    apiFetch<{ message: string }>('/auth/login', {
      method: 'POST',
      body: payload,
      skipRefresh: true,
    }),

  logout: () =>
    apiFetch<{ message: string }>('/auth/logout', {
      method: 'POST',
      skipRefresh: true,
    }),

  me: () => apiFetch<User>('/auth/me'),
}
