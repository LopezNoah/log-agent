import { els } from "./dom.js";
import { escapeHtml, toast } from "./utils.js";

const DEFAULT_STEPS = [
  { title: "Start Fly workspace", detail: "Create an empty task directory on the Fly machine." },
  { title: "Run opencode", detail: "Generate the project files without exposing GitHub credentials to Fly." },
  { title: "Package artifact", detail: "Return a manifest and archive of the completed project tree." },
  { title: "Create GitHub repo", detail: "Worker uses GitHub auth to create the repo and default branch." },
  { title: "Initial commit", detail: "Worker uploads the artifact as the first commit and reports the repo URL." },
];

const EXAMPLE_PROMPT = `Build a production-ready starter app. Include a README, setup instructions, lint/build/test scripts, and keep the initial scope small enough for one clean commit.`;

export function setupGithubProject() {
  renderSteps();
  els.openGithubProject?.addEventListener("click", openGithubProject);
  els.githubProjectClose?.addEventListener("click", closeGithubProject);
  els.githubProjectOverlay?.addEventListener("click", (e) => {
    if (e.target === els.githubProjectOverlay) closeGithubProject();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.githubProjectOverlay?.hidden) closeGithubProject();
  });
  els.githubProjectReset?.addEventListener("click", resetGithubProjectForm);
  els.githubProjectForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    draftGithubProjectTask();
  });
}

function openGithubProject() {
  els.githubProjectOverlay.hidden = false;
  if (!els.githubProjectPrompt.value.trim()) els.githubProjectPrompt.value = EXAMPLE_PROMPT;
  setTimeout(() => els.githubProjectOwner?.focus(), 0);
}

function closeGithubProject() {
  els.githubProjectOverlay.hidden = true;
}

function resetGithubProjectForm() {
  els.githubProjectForm.reset();
  els.githubProjectBranch.value = "main";
  els.githubProjectRunTests.checked = true;
  els.githubProjectPrompt.value = EXAMPLE_PROMPT;
  els.githubProjectPayload.hidden = true;
  els.githubProjectPayload.innerHTML = "";
  renderSteps();
}

function draftGithubProjectTask() {
  const payload = buildPayload();
  const invalid = validatePayload(payload);
  if (invalid) {
    toast(invalid);
    return;
  }

  renderSteps(payload);
  els.githubProjectPayload.hidden = false;
  els.githubProjectPayload.innerHTML = `
    <div class="github-project-result">
      <div>
        <div class="github-project-result-title">Task draft ready</div>
        <div class="github-project-result-sub">Ready to POST to <code>/api/github/projects</code> when the backend exists.</div>
      </div>
      <button class="btn btn-ghost" type="button" disabled>Start task soon</button>
    </div>
    <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
  `;
  toast("GitHub project task drafted");
}

function buildPayload() {
  const owner = els.githubProjectOwner.value.trim();
  const name = normalizeRepoName(els.githubProjectName.value);
  return {
    type: "github_project_create",
    owner,
    name,
    fullName: owner && name ? `${owner}/${name}` : "",
    visibility: els.githubProjectVisibility.value,
    defaultBranch: normalizeBranch(els.githubProjectBranch.value),
    description: els.githubProjectDescription.value.trim(),
    prompt: els.githubProjectPrompt.value.trim(),
    runChecks: els.githubProjectRunTests.checked,
    secretPolicy: "github_credentials_worker_only",
    flyArtifactMode: "full_tree_archive",
  };
}

function validatePayload(payload) {
  if (!/^[A-Za-z0-9_.-]+$/.test(payload.owner)) return "Enter a valid GitHub owner";
  if (!/^[A-Za-z0-9_.-]+$/.test(payload.name)) return "Enter a valid repository name";
  if (!/^[A-Za-z0-9._/-]+$/.test(payload.defaultBranch)) return "Enter a valid default branch";
  if (payload.prompt.length < 20) return "Add a more specific project brief";
  return "";
}

function normalizeRepoName(value) {
  return value.trim().replace(/\s+/g, "-");
}

function normalizeBranch(value) {
  return value.trim() || "main";
}

function renderSteps(payload = null) {
  const target = payload?.fullName || "owner/repo";
  els.githubProjectSteps.innerHTML = DEFAULT_STEPS.map((step, i) => `
    <div class="github-project-step${payload ? " ready" : ""}">
      <div class="github-project-step-index">${i + 1}</div>
      <div>
        <div class="github-project-step-title">${escapeHtml(step.title)}</div>
        <div class="github-project-step-detail">${escapeHtml(step.detail)}</div>
      </div>
    </div>
  `).join("") + `
    <div class="github-project-target">
      <span>Target</span>
      <code>${escapeHtml(target)}</code>
    </div>
  `;
}
