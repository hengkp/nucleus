import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/Card'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'
import { cn } from '@/lib/cn'

// User guide for lab members who are not developers. The copy is meant to read the way a
// colleague would explain it: plain words, short sentences, normal punctuation, no jargon
// dumps and no fancy typography. A floating panel on the right tracks where you are, lets
// you jump to any part, and gets you back to the top.

const SECTIONS: { id: string; label: string }[] = [
  { id: 'overview', label: 'What it is' },
  { id: 'start', label: 'Quick start' },
  { id: 'apps', label: 'Apps you can run' },
  { id: 'concepts', label: 'How it works' },
  { id: 'files', label: 'Your files' },
  { id: 'envs', label: 'Notebooks and kernels' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'sharing', label: 'Sharing a link' },
  { id: 'trouble', label: 'When things go wrong' },
  { id: 'faq', label: 'Common questions' },
  { id: 'help', label: 'Getting help' },
]

const APPS: { icon: string; name: string; desc: string }[] = [
  { icon: 'terminal-box-line', name: 'JupyterLab', desc: 'Write and run Python or R in notebooks. The lab toolsets and any environment you build yourself both show up as kernels you click.' },
  { icon: 'bar-chart-box-line', name: 'RStudio', desc: 'The full RStudio editor for R. Your scripts, your session, and the files you had open all come back next time you launch it.' },
  { icon: 'code-box-line', name: 'VS Code', desc: 'Visual Studio Code in the browser. It opens on your locker, you can add extensions, and you edit and run code on the cluster instead of your laptop.' },
  { icon: 'microscope-line', name: 'QuPath', desc: 'QuPath 0.7 for whole-slide and multiplexed images. It opens slides straight from the shared storage, the heavy work runs on the cluster, and the window fits itself to your browser.' },
  { icon: 'rocket-2-line', name: 'Streamlit, Gradio, FastAPI', desc: 'Turn a script into a small web app such as a dashboard, a demo, or an API. You get a link you can open or pass to someone.' },
  { icon: 'global-line', name: 'Static site', desc: 'Point it at a folder of HTML, CSS, and JavaScript and it serves that folder as a website. Good for a portfolio or a written report.' },
  { icon: 'play-circle-line', name: 'Batch job', desc: 'Run a long script without keeping a window open. It runs on the cluster and the output lands back in your files.' },
]

function Section({ id, eyebrow, title, intro, children }: { id: string; eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <p className="font-mono text-xs font-medium uppercase tracking-wider text-brand">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h2>
      {intro && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">{intro}</p>}
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-white">{n}</span>
        <span className="mt-1 w-px flex-1 bg-border last:hidden" aria-hidden />
      </div>
      <div className="pb-7">
        <h3 className="font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{children}</p>
      </div>
    </li>
  )
}

function Feature({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name={icon} className="text-xl" /></div>
      <h3 className="mt-3 font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{children}</p>
    </Card>
  )
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border py-3.5 last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-ink">
        {q}
        <Icon name="arrow-down-s-line" className="text-lg text-ink-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 text-sm leading-relaxed text-ink-muted">{children}</div>
    </details>
  )
}

function Callout({ icon = 'information-line', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-brand/30 bg-brand-tint p-3.5">
      <Icon name={icon} className="mt-0.5 shrink-0 text-lg text-brand" />
      <p className="text-sm leading-relaxed text-ink">{children}</p>
    </div>
  )
}

export function Guide() {
  const [active, setActive] = useState(SECTIONS[0].id)
  const [progress, setProgress] = useState(0)

  // The page scrolls inside <main id="app-scroll">, not the window. Track scroll progress and
  // which section is currently in view so the side panel can show where you are.
  useEffect(() => {
    const root = document.getElementById('app-scroll')
    if (!root) return
    const onScroll = () => {
      const max = root.scrollHeight - root.clientHeight
      setProgress(max > 0 ? Math.min(100, Math.round((root.scrollTop / max) * 100)) : 0)
      // Active section: the last one whose top has passed a line near the top of the view.
      const markerY = root.getBoundingClientRect().top + 140
      let current = SECTIONS[0].id
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= markerY) current = s.id
      }
      setActive(current)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    onScroll()
    return () => { root.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll) }
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
  }
  const backToTop = () => {
    const c = document.getElementById('app-scroll')
    if (c) c.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start lg:gap-8">
      {/* LEFT: the guide */}
      <div className="min-w-0 pb-12">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-lg border border-border bg-gradient-to-br from-brand to-brand-strong p-7 text-white sm:p-10">
          <div className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl" />
          <div className="relative">
            <Badge tone="neutral" className="!bg-white/15 !text-white">User guide</Badge>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">A plain guide to AppHub</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/85 sm:text-base">
              AppHub runs research software in your browser. You pick an app like JupyterLab or RStudio, click launch, and
              it starts on the lab servers. There is nothing to install and you do not need the command line. This page
              covers the basics and answers the questions people ask the most.
            </p>
            <div className="mt-5 flex flex-wrap gap-2 text-xs">
              <button onClick={() => scrollTo('start')} className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Quick start</button>
              <button onClick={() => scrollTo('apps')} className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">The apps</button>
              <button onClick={() => scrollTo('files')} className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Your files</button>
              <button onClick={() => scrollTo('trouble')} className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Fixes</button>
            </div>
          </div>
        </div>

        <div className="mt-10 space-y-14">
          {/* Overview */}
          <Section id="overview" eyebrow="the idea" title="What AppHub is" intro="Think of it as a launchpad. You pick an app, click launch, and a private copy starts on the lab computers. When you are done you stop it, and the resources go back to the rest of the lab.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Feature icon="cursor-line" title="One click to start">Nothing to install and nothing to wire up. Choose an app and launch it.</Feature>
              <Feature icon="database-2-line" title="Your data stays put">Whatever you save lives in your own folder, your locker, and it is there the next time you log in.</Feature>
              <Feature icon="cpu-line" title="Real computing power">Apps run on shared servers with far more CPU and memory than a laptop has.</Feature>
            </div>
          </Section>

          {/* Quick start */}
          <Section id="start" eyebrow="quick start" title="Launch your first app in five steps" intro="JupyterLab is the example here, but every app follows the same path.">
            <ol>
              <Step n={1} title="Open the App catalog">In the menu on the left, click App catalog. You will see every app you can run.</Step>
              <Step n={2} title="Pick an app">Click JupyterLab, or any other app. A short form opens. You can launch right away with the defaults.</Step>
              <Step n={3} title="Change a few things if you want">Give it a name, choose a folder to work in, or set how long it should run. CPU, memory, a custom link, and sharing all live under Advanced options. If you are new, skip them.</Step>
              <Step n={4} title="Click Launch">The app shows up on your Dashboard and starts on the cluster.</Step>
              <Step n={5} title="Open it">Give it up to a minute to warm up, then click Open. That is it. You are working in the browser.</Step>
            </ol>
            <Callout icon="time-line">
              Right after you launch you might see a short starting page, or a quick 502 error. That is normal. It only
              means the app is still booting. Wait up to a minute and it opens on its own.
            </Callout>
          </Section>

          {/* Apps */}
          <Section id="apps" eyebrow="the apps" title="Apps you can run" intro="Each app suits a different kind of work. Here is the short version of each.">
            <div className="grid gap-4 sm:grid-cols-2">
              {APPS.map((a) => (
                <Card key={a.name} className="flex gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name={a.icon} className="text-xl" /></div>
                  <div>
                    <h3 className="font-semibold text-ink">{a.name}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">{a.desc}</p>
                  </div>
                </Card>
              ))}
            </div>
          </Section>

          {/* Concepts */}
          <Section id="concepts" eyebrow="good to know" title="How it works under the hood" intro="Four ideas explain most of what you see. None of them are complicated.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Feature icon="hourglass-line" title="Run time">Each app runs for a set time, say eight hours, so an app you forgot about does not tie up the cluster. Need longer? Pick a bigger preset, choose Until I stop it, or extend it later from the Dashboard.</Feature>
              <Feature icon="ram-2-line" title="CPU and memory">More CPU and memory means faster and bigger analyses. The defaults are fine to start with. Raise them under Advanced options when a job needs it.</Feature>
              <Feature icon="folder-3-line" title="Your locker">Everything you save goes to your own folder on the lab storage. It stays there between sessions and you can see it under Workspace.</Feature>
              <Feature icon="stop-circle-line" title="Stopping">Done for the day? Click Stop on the app. Your files are kept. Only the running app shuts down, which hands the resources back to everyone else.</Feature>
            </div>
          </Section>

          {/* Files */}
          <Section id="files" eyebrow="your data" title="Where your files live" intro="Every app you launch opens on the same personal folder, so your work follows you from one app to the next.">
            <div className="space-y-4">
              <Card className="p-5">
                <h3 className="font-semibold text-ink">The Workspace page</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  Workspace is a file browser for your locker. You can make folders, upload and download, rename, and
                  delete, all without opening an app. Uploads and downloads are checked for integrity as they move, so a
                  file that arrives is the same file that left.
                </p>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-ink">Map your locker as a drive</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  If you would rather work from your own computer, you can mount your locker as a network drive on Windows
                  or macOS using MapDrive. It uses your usual lab login and changes nothing about your account. After that
                  your locker shows up in File Explorer or Finder like any other drive. Turn it on under Settings.
                </p>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-ink">Shared lab folders</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  Some data lives in shared folders on the lab storage, not in your personal locker. Apps can read those
                  folders in place, so you do not have to copy large datasets into your own space first. When a launch
                  form has a Browse button, it lets you point straight at a shared folder.
                </p>
              </Card>
            </div>
          </Section>

          {/* Environments */}
          <Section id="envs" eyebrow="notebooks" title="Environments and kernels in JupyterLab" intro="A kernel is just the set of tools and packages a notebook uses. You will see two kinds in the launcher.">
            <div className="space-y-4">
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-brand-tint px-2.5 py-1 font-mono text-xs font-medium text-brand">python3</span>
                  <span className="rounded-md bg-brand-tint px-2.5 py-1 font-mono text-xs font-medium text-brand">nextflow</span>
                  <span className="text-sm text-ink-muted">and the other lab kernels</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">These are the ready made lab toolsets, kept current for everyone. Click one in the launcher and start working. There is nothing to set up.</p>
              </Card>
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-surface-2 px-2.5 py-1 font-mono text-xs font-medium text-ink">myproject (mine)</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">These are your own environments. You manage them from a Terminal inside JupyterLab with the apphub-conda helper. Each one you make includes ipykernel and ipywidgets, so it turns into a kernel you can click once you refresh.</p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-ink/90 p-3 font-mono text-xs leading-relaxed text-white"><code>{`apphub-conda new myproject          # create one (add packages: apphub-conda new myproject scanpy)
apphub-conda list                   # see your envs and the lab ones
apphub-conda add myproject pandas   # install more into an env
apphub-conda rm  myproject          # delete an env you no longer need`}</code></pre>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">Your environment shows up as myproject (mine) in the launcher, right beside the lab ones. To remove one, run apphub-conda rm with its name, then refresh.</p>
              </Card>
            </div>
          </Section>

          {/* Pipelines */}
          <Section id="pipelines" eyebrow="workflows" title="Running a pipeline" intro="If your work is a Nextflow or nf-core pipeline rather than an interactive app, the Pipelines page handles it.">
            <div className="space-y-4">
              <Card className="p-5">
                <p className="text-sm leading-relaxed text-ink-muted">
                  Pick a pipeline, and AppHub reads its parameter list and builds a form for you, the same list nf-core
                  shows on its own launch page. Fill in the parts marked required, choose where the results should go in
                  your locker, set how much CPU and memory the run gets, and click Launch run.
                </p>
              </Card>
              <div className="grid gap-4 sm:grid-cols-2">
                <Feature icon="flow-chart" title="Bring your own">You can add any Nextflow pipeline by its Git address. If it ships an nf-core style parameter file, you get a form for free. If not, you can still run it with a custom config.</Feature>
                <Feature icon="upload-2-line" title="Save and reuse">Export a run as a small file, then import it later to fill the whole form again. Handy for repeating a run or sharing the exact settings with a labmate.</Feature>
              </div>
              <p className="text-sm leading-relaxed text-ink-muted">A run is tracked like any app. You can watch its progress on the Dashboard and in the Job queue.</p>
            </div>
          </Section>

          {/* Sharing */}
          <Section id="sharing" eyebrow="sharing" title="Giving your app a clean link" intro="Want a tidy web address, or to show a demo to someone outside the lab? Both options sit under Advanced options when you launch.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Feature icon="links-line" title="Claim a custom URL">Open Advanced options, choose Use a custom URL, type a name, and claim it on the spot if it is free. No admin needed. Your app then lives at yourname.app.sisp.com, with no username tacked on.</Feature>
              <Feature icon="global-line" title="Share outside the lab">Tick Make public when you launch and your app is also reachable from outside, with no login, at yourname.sisp.freeddns.org on port 8443. Good for portfolios and demos. Leave it off for anything that touches data.</Feature>
            </div>
            <div className="mt-4">
              <Callout icon="shield-check-line">
                Public means anyone with the link can open it. Only turn it on for things you are happy for the whole
                internet to see, and keep it off for work with patient or unpublished data.
              </Callout>
            </div>
          </Section>

          {/* Troubleshooting */}
          <Section id="trouble" eyebrow="fixes" title="When things go wrong" intro="Most hiccups have the same handful of causes. Here is what they mean and what to do.">
            <div className="space-y-3">
              <Card className="p-5">
                <h3 className="font-semibold text-ink">The app shows a 502 or a starting page</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">It is still booting. The link goes live a moment before the app is ready, so you can catch it mid start. Wait up to a minute and refresh once.</p>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-ink">The app vanished from the Dashboard</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">It most likely hit its run time and stopped by itself. Your files are safe. Launch it again, and this time give it a longer run time or choose Until I stop it.</p>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-ink">It is taking a long time to launch</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">The first launch of an app can be slower while it gets set up. Later launches are quicker. If it sits in the queue, the cluster may be busy, so try a smaller CPU and memory request.</p>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-ink">I cannot find a file I saved</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">Open Workspace and check your locker. Files save inside the folder the app was launched in, so look there first. Stopping an app never deletes anything.</p>
              </Card>
            </div>
          </Section>

          {/* FAQ */}
          <Section id="faq" eyebrow="help" title="Common questions">
            <Card className="px-5 py-2">
              <Faq q="I launched an app and saw a 502 error. Did it break?">
                No, it is just still starting. The link is ready a moment before the app finishes booting, so you may catch a brief starting page. Wait up to a minute and it opens.
              </Faq>
              <Faq q="My app disappeared from the Dashboard.">
                It most likely reached its run time and stopped on its own. Your files are safe. Launch it again, and next time pick a longer run time, or choose Until I stop it.
              </Faq>
              <Faq q="Where do my files go, and are they safe?">
                Everything you save lives in your personal locker on the lab storage. It stays there between sessions and you can see it under Workspace. Stopping an app never deletes your files.
              </Faq>
              <Faq q="How do I install a Python or R package?">
                Open a Terminal inside the app and use pip install or conda install. For something you will reuse, make your own environment with apphub-conda new and a name.
              </Faq>
              <Faq q="Can other people see my app?">
                Not by default. Apps are private to you. You only share when you choose Team visibility, or tick Make public when you launch.
              </Faq>
              <Faq q="Do I need to use the terminal or type commands?">
                No. Everything here works with clicks. The terminal is there if you want it, but launching apps, opening them, and stopping them are all buttons.
              </Faq>
            </Card>
          </Section>

          {/* Help */}
          <Section id="help" eyebrow="still stuck" title="Getting help">
            <Card className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
              <p className="text-sm leading-relaxed text-ink-muted">Not sure which app to use, or something is not working the way it should? The support page is the place to ask the rest of the lab or reach the team.</p>
              <Link to="/support" className="inline-flex shrink-0 items-center gap-2 rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-strong">
                <Icon name="lifebuoy-line" /> Go to support
              </Link>
            </Card>
          </Section>
        </div>
      </div>

      {/* RIGHT: floating table of contents with current position + back to top */}
      <aside className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">On this page</span>
            <span className="text-2xs font-medium text-ink-muted">{progress}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress}%` }} />
          </div>

          <nav className="mt-3 space-y-0.5">
            {SECTIONS.map((s) => {
              const on = active === s.id
              return (
                <button key={s.id} type="button" onClick={() => scrollTo(s.id)}
                  className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                    on ? 'bg-brand-tint font-medium text-brand' : 'text-ink-muted hover:bg-surface-2 hover:text-ink')}>
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full transition-colors', on ? 'bg-brand' : 'bg-ink-muted/30')} />
                  <span className="truncate">{s.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="mt-3 border-t border-border pt-3">
            <button type="button" onClick={backToTop} className="flex w-full items-center justify-center gap-1 text-2xs text-ink-muted hover:text-ink">
              <Icon name="arrow-up-line" /> Back to top
            </button>
          </div>
        </Card>
      </aside>
    </div>
  )
}
