import type { ZodError } from 'zod'
import { ApiError } from '@/lib/api'

/** Key used for errors that belong to the form as a whole, not one field. */
export const FORM_ERROR = '_form'

export type FieldErrors = Record<string, string>

export function zodFieldErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {}

  for (const issue of error.issues) {
    const key = issue.path[0]
    const field = typeof key === 'string' ? key : FORM_ERROR
    // Keep the first message per field, matching the backend's validator.
    if (!(field in errors)) errors[field] = issue.message
  }

  return errors
}

/** Maps a failed request onto the form: 422 has per-field messages, others don't. */
export function requestFieldErrors(error: unknown): FieldErrors {
  if (error instanceof ApiError) {
    if (Object.keys(error.fields).length > 0) return error.fields
    return { [FORM_ERROR]: error.message }
  }

  return { [FORM_ERROR]: 'Unable to reach the server. Please try again.' }
}
