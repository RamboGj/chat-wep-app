import { apiFetch } from '@/lib/api'
import type { AuthTokens, User } from '@/types/api'

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
  /** Creates the account. It does not log the user in — no tokens are issued. */
  signup: (payload: SignupPayload) =>
    apiFetch<{ user_id: string }>('/auth/signup', {
      method: 'POST',
      body: payload,
      skipRefresh: true,
    }),

  /** Returns the tokens. Storing them is `useLogin`'s job, not this module's. */
  login: (payload: LoginPayload) =>
    apiFetch<AuthTokens>('/auth/login', {
      method: 'POST',
      body: payload,
      skipRefresh: true,
    }),

  /**
   * Stateless tokens leave the server nothing to revoke, so this only exists to
   * keep the call site honest — discarding the tokens is what ends the session.
   */
  logout: () =>
    apiFetch<{ message: string }>('/auth/logout', {
      method: 'POST',
      skipRefresh: true,
    }),

  me: () => apiFetch<User>('/auth/me'),
}
