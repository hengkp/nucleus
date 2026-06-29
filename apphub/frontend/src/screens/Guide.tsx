import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/Card'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'

// User guide for non-technical lab members. Design follows the project system plus the
// constraint-based principles from power-design / awesome-design-md: one idea per section,
// a single accent, generous whitespace, clear hierarchy, glanceable cards and steps.
// Copy is written to sound human: plain words, normal punctuation, no jargon dumps.

function Section({ id, eyebrow, title, intro, children }: { id?: string; eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
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

const APPS: { icon: string; name: string; desc: string }[] = [
  { icon: 'terminal-box-line', name: 'JupyterLab', desc: 'Notebooks for Python and R. The lab environments and your own both show up as ready to click kernels.' },
  { icon: 'bar-chart-box-line', name: 'RStudio', desc: 'The full RStudio editor for R. Your session, scripts, and open files are saved and come back next time.' },
  { icon: 'rocket-2-line', name: 'Streamlit, Gradio, FastAPI', desc: 'Turn a script into a live web app, like a dashboard, a demo, or a small API, and get a link to share.' },
  { icon: 'global-line', name: 'Static site', desc: 'Host a folder of HTML, CSS, and JavaScript, like a portfolio. Point it at a folder in your files and it serves it.' },
  { icon: 'play-circle-line', name: 'Batch job', desc: 'Run a long script on the cluster without keeping a window open. The results land back in your files.' },
]

export function Guide() {
  return (
    <div className="mx-auto max-w-4xl pb-12">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-lg border border-border bg-gradient-to-br from-brand to-brand-strong p-7 text-white sm:p-10">
        <div className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl" />
        <div className="relative">
          <Badge tone="neutral" className="!bg-white/15 !text-white">User guide</Badge>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">Everything you need to use AppHub, no tech background required.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/85 sm:text-base">
            AppHub lets you run research apps like JupyterLab and RStudio right in your browser. Nothing to install,
            no terminal, and no waiting on IT. This page walks you through it, one step at a time.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <a href="#start" className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Quick start</a>
            <a href="#apps" className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">The apps</a>
            <a href="#envs" className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Environments</a>
            <a href="#share" className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">Sharing</a>
            <a href="#faq" className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">FAQ</a>
          </div>
        </div>
      </div>

      <div className="mt-10 space-y-12">
        {/* What is it */}
        <Section eyebrow="the idea" title="What is AppHub?" intro="Think of it as a launchpad. You pick an app, click Launch, and a private copy starts on the lab computers. When you are done you stop it, and the resources go back to everyone else.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Feature icon="cursor-line" title="One click to start">No software to install and nothing to set up. Pick an app and launch it.</Feature>
            <Feature icon="database-2-line" title="Your data stays put">Everything you save lives in your own folder, your locker, and it is there next time.</Feature>
            <Feature icon="cpu-line" title="Real computing power">Apps run on shared servers with lots of CPU and memory, far more than a laptop.</Feature>
          </div>
        </Section>

        {/* Quick start */}
        <Section id="start" eyebrow="quick start" title="Launch your first app in 5 steps" intro="We will use JupyterLab as the example, but every app works the same way.">
          <ol>
            <Step n={1} title="Open the App catalog">In the left menu, click App catalog. You will see all the apps you can run.</Step>
            <Step n={2} title="Pick an app">Click JupyterLab, or any app. A short form opens. You can launch right away with the sensible defaults.</Step>
            <Step n={3} title="Adjust if you want (optional)">Give it a name, choose a folder to work in, or set how long it should run. CPU, memory, a custom link, and sharing live under Advanced options. Beginners can skip all of this.</Step>
            <Step n={4} title="Click Launch">Your app appears on the Dashboard and starts on the cluster.</Step>
            <Step n={5} title="Open it">Give it up to a minute to warm up, then click Open. That is it, you are working in the browser.</Step>
          </ol>
          <Callout icon="time-line">
            If you see a short "starting your app" page, or briefly a 502 error, right after launching, that is normal.
            It just means the app is still booting. Wait up to a minute and it will open on its own.
          </Callout>
        </Section>

        {/* Apps */}
        <Section id="apps" eyebrow="the apps" title="What you can run" intro="Each app is built for a different kind of work. Here is the short version.">
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

        {/* Key concepts */}
        <Section eyebrow="good to know" title="A few key ideas" intro="Understanding these four things makes everything else click.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Feature icon="hourglass-line" title="Run time and Until I stop it">Each app runs for a set time, say 8 hours, so idle apps do not tie up the cluster. Need it longer? Pick a bigger preset, choose Until I stop it, or extend it later from the Dashboard.</Feature>
            <Feature icon="ram-2-line" title="CPU and memory">More CPU and memory means faster, bigger analyses. The defaults are fine to start. Raise them under Advanced options when you need to.</Feature>
            <Feature icon="folder-3-line" title="Your files (locker)">Everything you save goes to your own folder on the lab storage. It stays there between sessions and is shown under Workspace.</Feature>
            <Feature icon="stop-circle-line" title="Stop when you are done">Finished for the day? Click Stop on the app. Your files are kept. Only the running app shuts down, which frees resources for others.</Feature>
          </div>
        </Section>

        {/* Environments */}
        <Section id="envs" eyebrow="notebooks" title="Environments and kernels (JupyterLab)" intro="A kernel is just the set of tools and packages a notebook uses. In AppHub you will see two kinds.">
          <div className="space-y-4">
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-brand-tint px-2.5 py-1 font-mono text-xs font-medium text-brand">python3</span>
                <span className="rounded-md bg-brand-tint px-2.5 py-1 font-mono text-xs font-medium text-brand">nextflow</span>
                <span className="text-sm text-ink-muted">and the other lab kernels</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">These are the lab ready made toolsets, kept up to date for everyone. Just click one in the launcher and start working. Nothing to set up.</p>
            </Card>
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-surface-2 px-2.5 py-1 font-mono text-xs font-medium text-ink">myproject (mine)</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">Your own personal environments. Manage them from a Terminal in JupyterLab with the apphub-conda helper. Each one you create includes ipykernel and ipywidgets, so it shows up as a clickable kernel after you refresh.</p>
              <pre className="mt-3 overflow-x-auto rounded-md bg-ink/90 p-3 font-mono text-xs leading-relaxed text-white"><code>{`apphub-conda new myproject          # create one (add packages: apphub-conda new myproject scanpy)
apphub-conda list                   # see your envs and the lab ones
apphub-conda add myproject pandas   # install more into an env
apphub-conda rm  myproject          # delete an env you no longer need`}</code></pre>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">A personal env shows up as myproject (mine) in the launcher, next to the lab ones. Removing one is just apphub-conda rm and the name, then refresh.</p>
            </Card>
          </div>
        </Section>

        {/* Sharing */}
        <Section id="share" eyebrow="sharing" title="Give your app a clean link" intro="Want a tidy web address, or to show a demo to someone outside the lab? You can. Both options live under Advanced options when you launch.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Feature icon="links-line" title="Claim a custom URL">Open Advanced options, choose Use a custom URL, type a name, and if it is free you can claim it on the spot. No admin needed. Your app then lives at <span className="font-mono text-2xs">yourname.app.sisp.com</span> with no username added.</Feature>
            <Feature icon="global-line" title="Share outside the lab">Tick Make public when launching and your app is also reachable from outside at <span className="font-mono text-2xs">yourname.sisp.freeddns.org:8443</span> with no login. Great for portfolios and demos. Leave it off for anything with data.</Feature>
          </div>
        </Section>

        {/* FAQ */}
        <Section id="faq" eyebrow="help" title="Frequently asked questions">
          <Card className="px-5 py-2">
            <Faq q="I launched an app and saw a 502 error. Did it break?">
              No, it is just still starting up. The link is ready a moment before the app finishes booting, so you may catch a brief starting page. Wait up to a minute and it will open.
            </Faq>
            <Faq q="My app disappeared from the Dashboard.">
              It most likely reached its run time limit and stopped on its own. Your files are safe. Launch it again, and next time pick a longer run time, or choose Until I stop it.
            </Faq>
            <Faq q="Where do my files go, and are they safe?">
              Everything you save lives in your personal locker on the lab storage. It stays there between sessions and is visible under Workspace. Stopping an app never deletes your files.
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
        <Section eyebrow="still stuck" title="We are here to help">
          <Card className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
            <p className="text-sm leading-relaxed text-ink-muted">Not sure which app to use, or something is not working? Head to the support page to ask the community or reach the team.</p>
            <Link to="/support" className="inline-flex shrink-0 items-center gap-2 rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-strong">
              <Icon name="lifebuoy-line" /> Go to support
            </Link>
          </Card>
        </Section>
      </div>
    </div>
  )
}
