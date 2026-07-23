import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryOptions } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
import { clearTokens, hasSession, setTokens } from '@/lib/auth-tokens'
import { queryKeys } from '@/lib/query-keys'
import { authApi, type LoginPayload, type SignupPayload } from '../api/auth-api'
import type { User } from '@/types/api'

/**
 * Shared by the hook and the router guards, so a route load and a component
 * render never fire two separate /auth/me requests.
 *
 * A 401 here is the answer ("nobody is logged in"), not a failure — it resolves
 * to null rather than throwing, so guards can branch on the value.
 */
export const currentUserQueryOptions = queryOptions<User | null>({
  queryKey: queryKeys.currentUser,
  queryFn: async () => {
    // With no token there is nothing to authenticate with, and asking would
    // only spend a round trip to be told so.
    if (!hasSession()) return null

    try {
      return await authApi.me()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  },
  retry: false,
  staleTime: 5 * 60 * 1000,
})

export function useCurrentUser() {
  return useQuery(currentUserQueryOptions)
}

export function useLogin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: LoginPayload) => authApi.login(payload),
    onSuccess: async (tokens) => {
      // Store before invalidating: the refetch this triggers is the first
      // request that needs to send the new token.
      setTokens({ access: tokens.access_token, refresh: tokens.refresh_token })

      await queryClient.invalidateQueries({
        queryKey: queryKeys.currentUser,
        refetchType: 'all',
      })
    },
  })
}

/**
 * Creates the account only. The backend mints no tokens here, and the user is
 * sent to the log in tab to authenticate deliberately.
 */
export function useSignup() {
  return useMutation({
    mutationFn: (payload: SignupPayload) => authApi.signup(payload),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => authApi.logout(),
    // onSettled, not onSuccess: the request is a formality the server cannot
    // act on, so a failed one must not strand the user in a signed-in shell.
    onSettled: () => {
      clearTokens()
      // Drop every cached query: none of it belongs to the next user.
      queryClient.clear()
    },
  })
}
