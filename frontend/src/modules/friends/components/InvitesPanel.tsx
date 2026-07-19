import { Avatar } from '@/components/atoms/Avatar/Avatar'
import { formatRelative } from '@/lib/format'
import { useAcceptInvite, usePendingInvites, useRejectInvite } from '../hooks/use-friends'

/** Incoming friend invitations. Renders nothing when there are none. */
export function InvitesPanel() {
  const { data: invites = [] } = usePendingInvites()
  const acceptInvite = useAcceptInvite()
  const rejectInvite = useRejectInvite()

  if (invites.length === 0) return null

  const pendingId = acceptInvite.isPending
    ? acceptInvite.variables
    : rejectInvite.isPending
      ? rejectInvite.variables
      : null

  return (
    <section className="mb-2 px-2 pt-2" aria-label="Pending invitations">
      <h2 className="px-2 pb-2 font-sora text-[11px] font-semibold uppercase tracking-wide text-gray-300">
        Invitations · {invites.length}
      </h2>

      <ul className="flex flex-col gap-1">
        {invites.map((invite) => {
          const busy = pendingId === invite.id

          return (
            <li
              key={invite.id}
              className="flex items-center gap-3 rounded-xl border border-white-08 bg-gray-700 p-3"
            >
              <Avatar
                name={invite.from_username}
                size="sm"
                ringColor="var(--color-gray-700)"
              />

              <div className="min-w-0 flex-1">
                <p className="truncate font-sora text-sm font-semibold text-gray-100">
                  {invite.from_username}
                </p>
                <p className="text-[11px] text-gray-300">
                  {formatRelative(invite.created_at)}
                </p>
              </div>

              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => acceptInvite.mutate(invite.id)}
                  aria-label={`Accept invitation from ${invite.from_username}`}
                  className="rounded-lg bg-brand-500 px-2.5 py-1.5 font-sora text-xs font-semibold text-white transition-colors duration-300 hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => rejectInvite.mutate(invite.id)}
                  aria-label={`Reject invitation from ${invite.from_username}`}
                  className="rounded-lg border border-white-12 px-2.5 py-1.5 font-manrope text-xs text-gray-300 transition-colors duration-300 hover:border-white-25 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
