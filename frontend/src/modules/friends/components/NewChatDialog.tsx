import { useEffect, useState } from 'react'
import { Button } from '@/components/atoms/Button/Button'
import { Input } from '@/components/atoms/Input/Input'
import { requestFieldErrors, FORM_ERROR } from '@/utils/validation/form-errors'
import { useCreateInvite } from '../hooks/use-friends'

interface NewChatDialogProps {
  onClose: () => void
}

/**
 * "New chat" is an invitation, not a chat: the backend only creates a chat once
 * the other user accepts, so this closes on a sent invite rather than opening a
 * conversation.
 *
 * Mounted only while open, so every session starts from clean state without an
 * effect to reset it.
 */
export function NewChatDialog({ onClose }: NewChatDialogProps) {
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const createInvite = useCreateInvite()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function submit() {
    const trimmed = username.trim()
    if (!trimmed) {
      setError('Enter a username')
      return
    }

    setError(null)
    createInvite.mutate(trimmed, {
      onSuccess: () => setSentTo(trimmed),
      onError: (err) => {
        const fields = requestFieldErrors(err)
        setError(
          fields.username ?? fields[FORM_ERROR] ?? 'Could not send the invitation',
        )
      },
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onClick={onClose}
      role="presentation"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
        className="w-90 flex flex-col gap-4 rounded-2xl border border-white-10 bg-gray-700 p-7 animate-showContent"
      >
        <h2
          id="new-chat-title"
          className="font-sora font-bold text-lg text-gray-100"
        >
          Start a new chat
        </h2>

        {sentTo ? (
          <>
            <p className="font-manrope text-sm text-gray-300">
              Invitation sent to{' '}
              <span className="text-gray-100">{sentTo}</span>. The chat appears
              here once they accept.
            </p>
            <div className="flex justify-end">
              <Button label="Done" type="button" onClick={onClose} />
            </div>
          </>
        ) : (
          <>
            <Input
              label="Username"
              id="invite_username"
              name="username"
              placeholder="jordan_b"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              error={error ?? undefined}
            />

            <div className="mt-1 flex justify-end gap-2.5">
              <Button
                variant="ghost"
                label="Cancel"
                type="button"
                onClick={onClose}
              />
              <Button
                variant="gradient"
                label="Send invite"
                type="submit"
                loading={createInvite.isPending}
              />
            </div>
          </>
        )}
      </form>
    </div>
  )
}
