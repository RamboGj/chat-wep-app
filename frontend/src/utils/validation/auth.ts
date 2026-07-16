import { z } from 'zod'

export const ZPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character')

export const ZSignUpSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters long')
      .max(99, 'Username must be at most 99 characters long'),
    email: z.email('Invalid e-mail'),
    password: ZPasswordSchema,
    confirmPassword: ZPasswordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })

export const ZLoginSchema = z.object({
  email: z.email('Invalid e-mail'),
  password: ZPasswordSchema,
})
