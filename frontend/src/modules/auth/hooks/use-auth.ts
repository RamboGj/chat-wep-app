import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryOptions } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser })
    },
  })
}

/**
 * Creates the account only. The backend mints no cookies here, and the user is
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
    onSettled: () => {
      // Drop every cached query: none of it belongs to the next user.
      queryClient.clear()
    },
  })
}
