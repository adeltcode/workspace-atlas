import { Bot, Repeat, Timer, Webhook, GitBranch, Bell } from 'lucide-react'

const PLANNED = [
  { icon: Repeat,    label: 'Scheduled Tasks',   desc: 'Run scripts or commands on a cron-like schedule' },
  { icon: Timer,     label: 'Timed Triggers',     desc: 'One-shot delayed execution with countdown display' },
  { icon: Webhook,   label: 'Webhook Listener',   desc: 'Trigger local scripts from incoming HTTP webhooks' },
  { icon: GitBranch, label: 'Git Hooks Manager',  desc: 'Install and manage pre/post-commit and push hooks' },
  { icon: Bell,      label: 'Event Notifier',     desc: 'Desktop notifications when jobs complete or fail' },
] as const

export default function AutomationView() {
  return (
    <div className="view-container">
      <div className="view-header">
        <div className="view-header-icon">
          <Bot size={18} />
        </div>
        <div>
          <h1 className="view-title">Automation</h1>
          <p className="view-subtitle">Schedule tasks, set triggers, and automate your workflow</p>
        </div>
      </div>

      <div className="build-badge">Module in development</div>

      <div className="coming-soon-grid">
        {PLANNED.map(({ icon: Icon, label, desc }) => (
          <div key={label} className="coming-soon-card">
            <Icon size={18} className="coming-soon-icon" />
            <div>
              <p className="coming-soon-label">{label}</p>
              <p className="coming-soon-desc">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
