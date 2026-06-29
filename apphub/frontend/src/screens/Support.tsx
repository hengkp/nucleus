import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/Card'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'

// Support / community page. Modelled on a friendly community forum (forum.image.sc): the main
// call to action is asking the community, with the lab chat and admin email as backups.
// Plain, human copy (no fancy punctuation).

function Channel({
  icon,
  title,
  desc,
  action,
  href,
  to,
  primary,
  note,
}: {
  icon: string
  title: string
  desc: string
  action: string
  href?: string
  to?: string
  primary?: boolean
  note?: string
}) {
  const inner: ReactNode = (
    <>
      <div className="flex items-start gap-4">
        <div
          className={
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-md ' +
            (primary ? 'bg-white/15 text-white' : 'bg-brand-tint text-brand')
          }
        >
          <Icon name={icon} className="text-2xl" />
        </div>
        <div className="min-w-0">
          <h3 className={'font-semibold ' + (primary ? 'text-white' : 'text-ink')}>{title}</h3>
          <p className={'mt-1 text-sm leading-relaxed ' + (primary ? 'text-white/85' : 'text-ink-muted')}>{desc}</p>
          {note && <p className={'mt-1 text-2xs ' + (primary ? 'text-white/70' : 'text-ink-muted')}>{note}</p>}
        </div>
      </div>
      <div
        className={
          'mt-4 inline-flex items-center gap-1.5 text-sm font-semibold ' +
          (primary ? 'text-white' : 'text-brand')
        }
      >
        {action}
        <Icon name="arrow-right-line" />
      </div>
    </>
  )

  const cls =
    'block rounded-lg border p-6 transition-all duration-150 ' +
    (primary
      ? 'border-transparent bg-gradient-to-br from-brand to-brand-strong shadow-2 hover:opacity-95'
      : 'border-border bg-surface shadow-1 hover:border-brand/50 hover:shadow-2')

  if (to) return <Link to={to} className={cls}>{inner}</Link>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  )
}

export function Support() {
  return (
    <div className="mx-auto max-w-4xl pb-12">
      <div className="mb-8">
        <Badge tone="brand">Support and community</Badge>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Get help, and help others</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
          Stuck on something, or not sure how to approach an analysis? You are not alone. Pick the channel that fits
          your question. For anything lab related, the Zulip chat is the fastest way to get help.
        </p>
      </div>

      {/* Primary: lab community on Zulip */}
      <Channel
        primary
        icon="chat-3-line"
        title="Chat with the lab on Zulip"
        desc="Zulip is our community chat. Ask a question, share a tip, or see what others are working on. It is the fastest way to reach the team and other lab members, and answers stay searchable for the next person."
        action="Open Zulip"
        href="https://zulip.sisp.freeddns.org:8443/"
        note="Good for anything: access, shared folders, pipelines, or which app to use."
      />

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Channel
          icon="mail-send-line"
          title="Email the admin team"
          desc="Account problems, something broken on the platform, or a request that needs an admin? Send us an email and we will get back to you."
          action="Email an admin"
          href="mailto:sisp.hpcteam@gmail.com"
        />
        <Channel
          icon="book-open-line"
          title="Read the user guide"
          desc="New here, or want a refresher? The guide walks you through launching apps, your files, environments, and sharing, step by step."
          action="Open the user guide"
          to="/guide"
        />
        <Channel
          icon="hard-drive-2-line"
          title="Map a network drive"
          desc="Need your lab folders on your own computer? MapDrive shows you how to connect them on Windows and macOS."
          action="Open MapDrive"
          href="https://mapdrive.sisp.com"
        />
      </div>

      {/* Tips */}
      <Card className="mt-8 p-6">
        <h2 className="text-base font-semibold text-ink">How to get a good answer fast</h2>
        <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-ink-muted">
          {[
            'Say what you were trying to do, and what happened instead.',
            'Paste the exact error message, not a summary of it.',
            'Mention the app and template you used, and roughly when.',
            'Share a small example or screenshot if you can.',
            'Never post passwords or private patient data.',
          ].map((t) => (
            <li key={t} className="flex items-start gap-2.5">
              <Icon name="checkbox-circle-line" className="mt-0.5 shrink-0 text-brand" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
