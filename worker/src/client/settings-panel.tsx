import { createRoot, on, ref, type Handle } from "remix/ui";

// Settings overlay internals, ported to Remix 3 (remix/ui). The overlay shell (#settings-overlay,
// #settings-nav, #settings-content) is rendered by the root <App>; settings.js owns the data,
// fetch (`request`), `reload`, `toast`, the connectors cache, and the open/close/escape wiring.
// This module is purely presentation + form wiring: given the active section, connectors, env, and
// system-prompt state, it renders the nav (into #settings-nav-items) and the section panel (into
// #settings-content) and calls back into settings.js for every action. Re-render via update(props).
// Styling reuses the existing .settings-* / .connector-* / .field / .btn / .radio / .check classes.

// ---------------------------------------------------------------- shared types

// A connector record as returned by /api/connectors. Mirrors what settings.js caches.
export interface Connector {
  id: string;
  type: string;
  provider: string;
  label?: string;
  isDefault?: boolean;
  hasSecret?: boolean;
  secretLast4?: string;
  config?: {
    model?: string;
    username?: string;
    authMethod?: string;
    repoPermissions?: string[];
    orgSlug?: string;
    maxVmSize?: string;
    maxIdleMinutes?: number;
    [key: string]: unknown;
  };
}

// Deployment-level info (whether a Fly env token is configured, its org slug).
export interface EnvMeta {
  flyToken?: boolean;
  flyOrgSlug?: string;
}

// System-prompt panel state. settings.js fetches /api/system-prompt and passes the result here;
// loading/error are surfaced so the component can render the right header copy without owning fetch.
export interface SystemPromptState {
  loading?: boolean;
  error?: boolean;
  source?: string; // "custom" => using the user override
  boxReachable?: boolean;
  content?: string;
}

// Values parsed from each form on submit and handed to the matching callback. settings.js turns
// these into the /api/connectors request bodies (it still owns request/reload/announceChange).
export interface LlmFormValues {
  provider: string;
  label: string;
  key: string;
  model: string;
}
export interface GithubFormValues {
  username: string;
  token: string;
  repoPermissions: string[];
}
export interface FlyFormValues {
  token: string;
  orgSlug: string;
  maxVmSize: string;
  maxIdleMinutes: number;
}
export interface NotificationFormValues {
  provider: string;
  label: string;
  url: string;
}

// Provider metadata for the LLM section (names + placeholders). Passed in from settings.js so the
// canonical lists live in one place; defaulted to the same maps settings.js uses today.
export interface LlmProviderMeta {
  name: string;
  keyHint: string;
  model: string;
}

// State of the "Connect ChatGPT" device-code flow, owned by settings.js and passed down so the LLM
// section can render the right step. idle → starting → awaiting (show code + link, polling) →
// connected | error.
export interface ChatgptConnectState {
  status?: "idle" | "starting" | "awaiting" | "connected" | "error";
  userCode?: string; // device user_code to type at the verification URL
  verificationUri?: string; // where to enter the code
  message?: string; // human-readable status/error line
}

export interface SettingsPanelProps {
  // --- data ---
  active: string; // active section id
  sections: SettingsSection[]; // nav order/labels/grouping (settings.js SECTIONS)
  connectors: Connector[];
  env: EnvMeta;
  systemPrompt: SystemPromptState;
  // provider/option metadata (canonical lists owned by settings.js)
  llmProviders: Record<string, LlmProviderMeta>;
  vmSizes: string[];
  ghPermissions: string[];
  notifyProviders: Record<string, string>;

  // ChatGPT OAuth connect (device-code flow). settings.js owns the start/poll requests + the
  // success/error toasts; this component renders the button, the user_code + verification link, and
  // a status line, all driven by `chatgptConnect` below.
  chatgptConnect?: ChatgptConnectState;

  // --- callbacks (settings.js keeps request/reload/announceChange behind these) ---
  onSelectSection: (id: string, navButton: HTMLElement) => void;
  // LLM
  onAddLlm: (values: LlmFormValues) => void;
  onSetDefaultLlm: (id: string) => void;
  onEditLlm: (id: string) => void;
  onConnectChatgpt: () => void; // kick off the OpenAI device-code OAuth flow
  onRemoveConnector: (id: string, anchor: HTMLElement) => void; // generic remove (pass anchor el)
  // GitHub
  onSaveGithub: (values: GithubFormValues, existing: Connector | null) => void;
  onSyncGithub: (anchor: HTMLElement) => void;
  // Fly.io
  onSaveFly: (values: FlyFormValues, existing: Connector | null) => void;
  // Notifications
  onAddNotification: (values: NotificationFormValues) => void;
  onTestNotification: (id: string, anchor: HTMLElement) => void;
  // System prompt
  onSaveSystemPrompt: (content: string) => void;
  onResetSystemPrompt: () => void;
}

export interface SettingsSection {
  id: string;
  label: string;
  group?: boolean;
  indent?: boolean;
}

// ---------------------------------------------------------------- helpers

function secretPlaceholder(c: Connector | null | undefined): string {
  return c?.hasSecret ? `•••• ${c.secretLast4 || "set"} — leave blank to keep` : "";
}

// Reusable panel header + body wrapper (matches settings.js panel()). A remix/ui component:
// (handle) => () => jsx, so it must be used as <Panel .../> (not called directly).
interface PanelProps {
  title: string;
  subtitle?: string;
  children?: unknown;
}
function Panel(handle: Handle<PanelProps>) {
  return () => {
    let { title, subtitle, children } = handle.props;
    return (
      <div className="settings-panel">
        <header className="settings-panel-head">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        {children as never}
      </div>
    );
  };
}

// Reusable labelled field (matches settings.js field()).
interface FieldProps {
  label: string;
  hint?: string;
  children?: unknown;
}
function Field(handle: Handle<FieldProps>) {
  return () => {
    let { label, hint, children } = handle.props;
    return (
      <label className="settings-field">
        <span>{label}</span>
        {children as never}
        {hint ? <small>{hint}</small> : null}
      </label>
    );
  };
}

// ---------------------------------------------------------------- nav

function Nav(handle: Handle<SettingsPanelProps>) {
  return () => {
    let { sections, active, onSelectSection } = handle.props;
    return (
      <>
        {sections.map((s, i) => {
          if (s.group) {
            return (
              <div key={`group-${i}`} className="settings-nav-group">
                {s.label}
              </div>
            );
          }
          let cls = "settings-nav-item" + (s.indent ? " indent" : "") + (s.id === active ? " active" : "");
          return (
            <button
              key={s.id}
              className={cls}
              mix={on("click", (event) => onSelectSection(s.id, event.currentTarget))}
            >
              {s.label}
            </button>
          );
        })}
      </>
    );
  };
}

// ---------------------------------------------------------------- section: LLM

function LlmSection(handle: Handle<SettingsPanelProps>) {
  // Component-local hint state mirrors settings.js syncHints(): placeholder reflects the selected
  // provider. Tracked via refs so we don't re-render the whole panel on every keystroke.
  let providerSel: HTMLSelectElement | null = null;
  let keyInp: HTMLInputElement | null = null;
  let modelInp: HTMLInputElement | null = null;

  function syncHints() {
    let meta = handle.props.llmProviders[providerSel?.value ?? ""];
    if (!meta) return;
    if (keyInp) keyInp.placeholder = meta.keyHint;
    if (modelInp && !modelInp.value) modelInp.placeholder = meta.model;
  }

  return () => {
    let p = handle.props;
    let items = p.connectors.filter((c) => c.type === "llm");

    return (
      <Panel
        title="LLM providers"
        subtitle="Bring your own API key. Keys are encrypted at rest and pushed to the box only at runtime."
      >
        <div className="connector-list">
          {items.length ? (
            items.map((c) => (
              <div key={c.id} className="connector-row" data-id={c.id}>
                <div className="connector-main">
                  <div className="connector-title">
                    {p.llmProviders[c.provider]?.name || c.provider}
                    {c.isDefault ? <span className="badge">default</span> : null}
                  </div>
                  <div className="connector-sub">
                    {(c.config?.model || "no model set") + " · key ••••" + (c.secretLast4 || "")}
                  </div>
                </div>
                <div className="connector-actions">
                  {c.isDefault ? null : (
                    <button className="btn btn-ghost" mix={on("click", () => p.onSetDefaultLlm(c.id))}>
                      Make default
                    </button>
                  )}
                  <button className="btn btn-ghost" mix={on("click", () => p.onEditLlm(c.id))}>
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost text-bad"
                    mix={on("click", (event) => p.onRemoveConnector(c.id, event.currentTarget))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-muted text-sm">
              No LLM keys yet. Add one below — the default key is what new sessions use.
            </p>
          )}
        </div>

        {/* Connect ChatGPT (Pro/Plus) via OpenAI device-code OAuth — an alternative to pasting an
            API key. settings.js drives the start/poll requests behind onConnectChatgpt. */}
        <div className="settings-form chatgpt-connect">
          <h3>Connect ChatGPT (Pro/Plus)</h3>
          {(() => {
            let cg = p.chatgptConnect || {};
            let status = cg.status || "idle";
            if (status === "awaiting") {
              return (
                <div className="connector-status">
                  Open{" "}
                  {cg.verificationUri ? (
                    <a href={cg.verificationUri} target="_blank" rel="noopener noreferrer">
                      {cg.verificationUri}
                    </a>
                  ) : (
                    "the verification page"
                  )}{" "}
                  and enter code <b className="chatgpt-code">{cg.userCode || "…"}</b>. Waiting for you
                  to authorize…
                </div>
              );
            }
            if (status === "connected") {
              return <div className="connector-status">✓ ChatGPT connected.</div>;
            }
            if (status === "error") {
              return (
                <div className="connector-status text-bad">
                  {cg.message || "Couldn't connect ChatGPT. Try again."}
                </div>
              );
            }
            return (
              <p className="text-muted text-sm">
                Use your ChatGPT Pro/Plus subscription instead of an API key. You'll get a code to
                enter on OpenAI's site.
              </p>
            );
          })()}
          <div className="settings-form-actions">
            <button
              className="btn btn-ghost"
              type="button"
              disabled={p.chatgptConnect?.status === "starting" || p.chatgptConnect?.status === "awaiting"}
              mix={on("click", () => p.onConnectChatgpt())}
            >
              {p.chatgptConnect?.status === "starting"
                ? "Starting…"
                : p.chatgptConnect?.status === "awaiting"
                  ? "Waiting…"
                  : p.chatgptConnect?.status === "connected"
                    ? "Reconnect ChatGPT"
                    : "Connect ChatGPT"}
            </button>
          </div>
        </div>

        <form
          className="settings-form"
          mix={on("submit", (event) => {
            event.preventDefault();
            let form = event.currentTarget;
            p.onAddLlm({
              provider: (form.querySelector("#llm-provider") as HTMLSelectElement).value,
              label: (form.querySelector("#llm-label") as HTMLInputElement).value.trim(),
              key: (form.querySelector("#llm-key") as HTMLInputElement).value.trim(),
              model: (form.querySelector("#llm-model") as HTMLInputElement).value.trim(),
            });
          })}
        >
          <h3>Add a provider key</h3>
          <Field label="Provider">
            <select
              id="llm-provider"
              className="field"
              mix={[
                ref((node: HTMLSelectElement) => {
                  providerSel = node;
                  syncHints();
                }),
                on("change", () => syncHints()),
              ]}
            >
              {Object.entries(p.llmProviders).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label (optional)">
            <input id="llm-label" className="field" placeholder="e.g. Personal Anthropic" />
          </Field>
          <Field label="API key">
            <input
              id="llm-key"
              type="password"
              autocomplete="off"
              className="field"
              placeholder="sk-ant-…"
              mix={ref((node: HTMLInputElement) => {
                keyInp = node;
                syncHints();
              })}
            />
          </Field>
          <Field label="Model" hint="provider/model — sent with every message">
            <input
              id="llm-model"
              className="field"
              placeholder="provider/model"
              mix={ref((node: HTMLInputElement) => {
                modelInp = node;
                syncHints();
              })}
            />
          </Field>
          <div className="settings-form-actions">
            <button className="btn btn-primary" type="submit">
              Add key
            </button>
          </div>
        </form>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- section: GitHub

function GithubSection(handle: Handle<SettingsPanelProps>) {
  return () => {
    let p = handle.props;
    let c = p.connectors.find((x) => x.type === "github") || null;
    let cfg = c?.config || {};
    let authMethod = cfg.authMethod || "pat";
    let perms = new Set(cfg.repoPermissions || ["contents", "pull_requests"]);

    return (
      <Panel
        title="GitHub"
        subtitle="Connect a GitHub account so agents can clone, push, and open PRs. Tokens are encrypted at rest."
      >
        <form
          className="settings-form"
          mix={on("submit", (event) => {
            event.preventDefault();
            let form = event.currentTarget;
            p.onSaveGithub(
              {
                username: (form.querySelector("#gh-username") as HTMLInputElement).value.trim(),
                token: (form.querySelector("#gh-token") as HTMLInputElement).value.trim(),
                repoPermissions: [...form.querySelectorAll<HTMLInputElement>(".check-grid input:checked")].map(
                  (i) => i.value,
                ),
              },
              c,
            );
          })}
        >
          {c ? (
            <div className="connector-status">
              Connected {c.config?.username ? <>as <b>{c.config.username}</b></> : null} · token ••••
              {c.secretLast4 || ""}
              <button
                type="button"
                className="btn btn-ghost ml-2"
                mix={on("click", (event) => p.onSyncGithub(event.currentTarget))}
              >
                Sync to machine
              </button>
            </div>
          ) : null}
          <Field label="Auth method">
            <div className="radio-row">
              <label className="radio">
                <input type="radio" name="gh-auth" value="pat" checked={authMethod === "pat"} /> Personal access token
              </label>
              <label className="radio is-disabled" title="OAuth requires a registered GitHub App — coming soon">
                <input type="radio" name="gh-auth" value="oauth" disabled={true} /> OAuth (soon)
              </label>
            </div>
          </Field>
          <Field label="Username (optional)">
            <input id="gh-username" className="field" value={cfg.username || ""} placeholder="octocat" />
          </Field>
          <Field label="Personal access token">
            <input
              id="gh-token"
              type="password"
              autocomplete="off"
              className="field"
              placeholder={c ? secretPlaceholder(c) : "github_pat_… or ghp_…"}
            />
          </Field>
          <Field label="Repo permissions" hint="Recorded with the connector; enforced when the agent uses the token.">
            <div className="check-grid">
              {p.ghPermissions.map((perm) => (
                <label key={perm} className="check">
                  <input type="checkbox" value={perm} checked={perms.has(perm)} /> {perm.replace("_", " ")}
                </label>
              ))}
            </div>
          </Field>
          <div className="settings-form-actions">
            {c ? (
              <button
                className="btn btn-ghost text-bad"
                type="button"
                mix={on("click", (event) => p.onRemoveConnector(c!.id, event.currentTarget))}
              >
                Disconnect
              </button>
            ) : null}
            <button className="btn btn-primary" type="submit">
              {c ? "Save" : "Connect"}
            </button>
          </div>
        </form>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- section: Fly.io

function FlySection(handle: Handle<SettingsPanelProps>) {
  return () => {
    let p = handle.props;
    let c = p.connectors.find((x) => x.type === "fly") || null;
    let cfg = c?.config || {};

    return (
      <Panel
        title="Fly.io"
        subtitle="Fly runs the machine behind your agents. A bring-your-own token here would override the deployment token (BYO is not yet wired to provisioning)."
      >
        <form
          className="settings-form"
          mix={on("submit", (event) => {
            event.preventDefault();
            let form = event.currentTarget;
            p.onSaveFly(
              {
                token: (form.querySelector("#fly-token") as HTMLInputElement).value.trim(),
                orgSlug: (form.querySelector("#fly-org") as HTMLInputElement).value.trim(),
                maxVmSize: (form.querySelector("#fly-size") as HTMLSelectElement).value,
                maxIdleMinutes: Number((form.querySelector("#fly-idle") as HTMLInputElement).value) || 60,
              },
              c,
            );
          })}
        >
          {p.env.flyToken ? (
            <div className="connector-status">
              ✓ Using the deployment's Fly token
              {p.env.flyOrgSlug ? <> (org <b>{p.env.flyOrgSlug}</b>)</> : null} — this powers machine start/stop today.
              Add a token below only to override it.
            </div>
          ) : (
            <div className="connector-status text-bad">
              No Fly token configured on the deployment. Machine start/stop will fail until one is set.
            </div>
          )}
          {c ? <div className="connector-status">BYO override saved · token ••••{c.secretLast4 || ""}</div> : null}
          <Field label="Fly API token (override)">
            <input
              id="fly-token"
              type="password"
              autocomplete="off"
              className="field"
              placeholder={c ? secretPlaceholder(c) : "FlyV1 …"}
            />
          </Field>
          <Field label="Organization slug">
            <input id="fly-org" className="field" value={cfg.orgSlug || ""} placeholder="personal" />
          </Field>
          <Field label="Max VM size">
            <select id="fly-size" className="field" value={cfg.maxVmSize ?? ""}>
              {p.vmSizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max idle minutes" hint="Auto-stop idle machines after this many minutes.">
            <input id="fly-idle" type="number" min="1" className="field" value={String(cfg.maxIdleMinutes ?? 60)} />
          </Field>
          <div className="settings-form-actions">
            {c ? (
              <button
                className="btn btn-ghost text-bad"
                type="button"
                mix={on("click", (event) => p.onRemoveConnector(c!.id, event.currentTarget))}
              >
                Disconnect
              </button>
            ) : null}
            <button className="btn btn-primary" type="submit">
              {c ? "Save" : "Connect"}
            </button>
          </div>
        </form>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- section: Notifications

function NotificationsSection(handle: Handle<SettingsPanelProps>) {
  return () => {
    let p = handle.props;
    let items = p.connectors.filter((c) => c.type === "notification");

    return (
      <Panel
        title="Notifications"
        subtitle="Alerts for machine start/stop and finished runs, sent to your channels."
      >
        <div className="connector-list">
          {items.length ? (
            items.map((c) => (
              <div key={c.id} className="connector-row" data-id={c.id}>
                <div className="connector-main">
                  <div className="connector-title">
                    {(p.notifyProviders[c.provider] || c.provider) + (c.label ? ` · ${c.label}` : "")}
                  </div>
                  <div className="connector-sub">{"webhook ••••" + (c.secretLast4 || "")}</div>
                </div>
                <div className="connector-actions">
                  <button
                    className="btn btn-ghost"
                    mix={on("click", (event) => p.onTestNotification(c.id, event.currentTarget))}
                  >
                    Test
                  </button>
                  <button
                    className="btn btn-ghost text-bad"
                    mix={on("click", (event) => p.onRemoveConnector(c.id, event.currentTarget))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-muted text-sm">
              No notification sinks yet. Add a Slack/Discord webhook to get machine + run alerts.
            </p>
          )}
        </div>

        <form
          className="settings-form"
          mix={on("submit", (event) => {
            event.preventDefault();
            let form = event.currentTarget;
            p.onAddNotification({
              provider: (form.querySelector("#notify-provider") as HTMLSelectElement).value,
              label: (form.querySelector("#notify-label") as HTMLInputElement).value.trim(),
              url: (form.querySelector("#notify-url") as HTMLInputElement).value.trim(),
            });
          })}
        >
          <h3>Add a sink</h3>
          <Field label="Type">
            <select id="notify-provider" className="field">
              {Object.entries(p.notifyProviders).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label (optional)">
            <input id="notify-label" className="field" placeholder="e.g. #builds" />
          </Field>
          <Field
            label="Webhook URL"
            hint="Slack/Discord incoming webhook, or any URL that accepts a JSON POST."
          >
            <input
              id="notify-url"
              type="url"
              className="field"
              placeholder="https://hooks.slack.com/services/…"
            />
          </Field>
          <div className="settings-form-actions">
            <button className="btn btn-primary" type="submit">
              Add sink
            </button>
          </div>
        </form>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- section: Account

function AccountSection(_handle: Handle<SettingsPanelProps>) {
  return () => (
    <Panel title="Account" subtitle="You're signed in with the workspace password.">
      <div className="settings-form">
        <div className="connector-status">Single-user workspace. Multi-user accounts are planned.</div>
        <div className="settings-form-actions">
          <a className="btn btn-ghost" href="/logout">
            Sign out
          </a>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- section: System prompt

function SystemPromptSection(handle: Handle<SettingsPanelProps>) {
  return () => {
    let p = handle.props;
    let sp = p.systemPrompt;

    if (sp.loading) {
      return <Panel title="System prompt" subtitle="Loading…" />;
    }
    if (sp.error) {
      return <Panel title="System prompt" subtitle="Could not load the system prompt." />;
    }

    let isCustom = sp.source === "custom";
    let note = isCustom
      ? "Using your custom prompt (overrides the box default; persists across reboots)."
      : sp.boxReachable
        ? "Showing the box default. Edit and save to override it."
        : "Machine is off — showing your saved prompt or empty. Start the machine to load the live default.";

    return (
      <Panel
        title="System prompt"
        subtitle="The agent instructions (AGENTS.md) loaded for every session — includes the UI-artifact protocol."
      >
        <form
          className="settings-form"
          mix={on("submit", (event) => {
            event.preventDefault();
            let text = (event.currentTarget.querySelector("#sp-text") as HTMLTextAreaElement).value;
            p.onSaveSystemPrompt(text);
          })}
        >
          <div className="connector-status">{note}</div>
          <Field label="Prompt">
            <textarea
              id="sp-text"
              className="field"
              rows={16}
              style="min-height:280px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px"
              mix={ref((node: HTMLTextAreaElement) => {
                node.value = sp.content || "";
              })}
            />
          </Field>
          <div className="settings-form-actions">
            <button
              type="button"
              className="btn btn-ghost text-bad"
              disabled={!isCustom}
              mix={on("click", () => p.onResetSystemPrompt())}
            >
              Reset to default
            </button>
            <span className="flex-1" />
            <button type="submit" className="btn btn-primary">
              Save override
            </button>
          </div>
        </form>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- section: placeholders

const PLACEHOLDER_COPY: Record<string, [string, string]> = {
  orgs: [
    "Organizations / Tenants",
    "Group projects and members under an organization. Coming in a later pass — this build is single-user.",
  ],
  projects: ["Projects", "Scope sessions, connectors, and budgets to a project. Coming soon."],
  billing: ["Billing / budgets", "Set spend caps per provider and track token usage. Coming soon."],
};

function PlaceholderSection(handle: Handle<SettingsPanelProps>) {
  return () => {
    let [title, subtitle] = PLACEHOLDER_COPY[handle.props.active] || ["Settings", ""];
    return (
      <Panel title={title} subtitle={subtitle}>
        <div className="settings-soon">🚧 Not built yet</div>
      </Panel>
    );
  };
}

// ---------------------------------------------------------------- content dispatcher

// Maps active section id -> section component (matches settings.js RENDERERS).
function Content(handle: Handle<SettingsPanelProps>) {
  return () => {
    switch (handle.props.active) {
      case "account":
        return <AccountSection {...handle.props} />;
      case "llm":
        return <LlmSection {...handle.props} />;
      case "github":
        return <GithubSection {...handle.props} />;
      case "fly":
        return <FlySection {...handle.props} />;
      case "notifications":
        return <NotificationsSection {...handle.props} />;
      case "system":
        return <SystemPromptSection {...handle.props} />;
      default:
        return <PlaceholderSection {...handle.props} />;
    }
  };
}

// ---------------------------------------------------------------- mount contract

// Mount the nav into navEl and the content into contentEl, returning an updater settings.js calls
// with fresh props. Re-rendering reconciles in place. The overlay open/close stays in settings.js.
export function mountSettings(contentEl: HTMLElement, navEl: HTMLElement) {
  let contentRoot = createRoot(contentEl);
  let navRoot = createRoot(navEl);
  return {
    update(props: SettingsPanelProps) {
      navRoot.render(<Nav {...props} />);
      navRoot.flush();
      contentRoot.render(<Content {...props} />);
      contentRoot.flush();
    },
  };
}
