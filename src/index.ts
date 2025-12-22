import * as core from "@actions/core";
import * as github from "@actions/github";
import { execSync } from "child_process";
import * as fs from "fs";
import yaml from "js-yaml";
import OpenAI from "openai";

type DocsConfig = {
  path: string;
  section_id: string;
};

type Config = {
  docs?: {
    changelog?: DocsConfig;
    readme?: DocsConfig;
  };
  github?: {
    mode?: "pull-request" | "commit";
    base_branch?: string;
  };
  llm?: {
    model?: string;       // for Azure, this should be your deployment name (e.g. "gpt-4")
    temperature?: number;
  };
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function runGit(cmd: string): string {
  core.info(`$ git ${cmd}`);
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

function getPreviousTag(currentTag: string): string | null {
  const tagsOutput = runGit("tag --sort=-creatordate");
  const tags = tagsOutput.split("\n").filter(Boolean);
  const idx = tags.indexOf(currentTag);
  if (idx === -1) {
    core.warning(`Current tag ${currentTag} not found in tags list`);
    return tags.length > 1 ? tags[1] : null;
  }
  return idx < tags.length - 1 ? tags[idx + 1] : null;
}

function getChangeSummary(range: string) {
  const log = runGit(
    `log ${range} --pretty=format:"%h||%s||%an||%ae||%ad||%b"`
  );
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, authorName, authorEmail, date, ...rest] =
        line.split("||");
      return {
        hash,
        subject,
        authorName,
        authorEmail,
        date,
        body: rest.join("||") || "",
      };
    });

  const diffStat = runGit(`diff --stat ${range}`);
  return { commits, diffStat };
}

// ---------------------------------------------------------------------------
// Config & file helpers
// ---------------------------------------------------------------------------

function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    core.info(`Config file ${configPath} not found, using defaults.`);
    return {};
  }
  const content = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(content) as Config;
  return parsed || {};
}

function readFileIfExists(filePath: string): string | null {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    core.warning(`File not found: ${filePath}`);
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function replaceBetweenMarkers(
  content: string,
  sectionId: string,
  newBlock: string
): string {
  const startTag = `<!-- RELEASE-GENIE:${sectionId}-START -->`;
  const endTag = `<!-- RELEASE-GENIE:${sectionId}-END -->`;

  const pattern = new RegExp(
    `${startTag}[\\s\\S]*?${endTag}`,
    "m"
  );

  if (!pattern.test(content)) {
    core.warning(
      `Markers for section ${sectionId} not found. Skipping replace.`
    );
    return content;
  }

  const replacement = `${startTag}\n${newBlock.trim()}\n${endTag}`;
  return content.replace(pattern, replacement);
}

// ---------------------------------------------------------------------------
// Azure OpenAI setup (TEMP: hard‑coded – replace with env vars before shipping)
// ---------------------------------------------------------------------------

// ⚠️ Replace these with env vars before committing anywhere non‑local.
const OPENAI_API_KEY = "<YOUR_AZURE_OPENAI_API_KEY>";
const OPENAI_BASE_URL =
  "https://subha-mafdk4x5-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-4";
const OPENAI_API_VERSION = "2024-12-01-preview";
// For Azure, this should be your deployment name (often same as model).
const OPENAI_DEPLOYMENT_MODEL = "gpt-4";

function createAzureOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL,
    defaultHeaders: {
      "api-key": OPENAI_API_KEY,
    },
    defaultQuery: {
      "api-version": OPENAI_API_VERSION,
    },
  });
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callOpenAIReleaseNotes(args: {
  model: string; // Azure deployment name
  temperature: number;
  tag: string;
  prevTag: string | null;
  changeSummary: { commits: any[]; diffStat: string };
  currentChangelogSection: string | null;
  currentWhatsNewSection: string | null;
}): Promise<{ changelogBlock: string; whatsNewBlock: string }> {
  const client = createAzureOpenAIClient();

  const userPayload = {
    newTag: args.tag,
    prevTag: args.prevTag,
    commits: args.changeSummary.commits,
    diffStat: args.changeSummary.diffStat,
    currentChangelogSection: args.currentChangelogSection,
    currentWhatsNewSection: args.currentWhatsNewSection,
    guidelines: {
      sections: [
        "Breaking Changes",
        "New Features",
        "Improvements",
        "Bug Fixes",
        "Internal",
      ],
      style: "markdown",
      maxBulletsPerSection: 7,
    },
  };

  const deploymentName = args.model || OPENAI_DEPLOYMENT_MODEL;

  const completion = await client.chat.completions.create({
    // For Azure, this should be your deployment name.
    model: deploymentName,
    temperature: args.temperature,
    messages: [
      {
        role: "system",
        content:
          "You are Release Genie, an assistant that writes concise, accurate release notes and 'what's new' docs. " +
          "You must ONLY respond with a single JSON object matching this TypeScript type: " +
          "{ changelogBlock: string; whatsNewBlock: string; } and nothing else.",
      },
      {
        role: "user",
        content: JSON.stringify(userPayload, null, 2),
      },
    ],
  });

  const rawContent = completion.choices[0]?.message?.content;

  if (!rawContent) {
    throw new Error("Azure OpenAI returned no content in the completion.");
  }

  const text =
    typeof rawContent === "string"
      ? rawContent
      : (rawContent as any[])
          .map((part) =>
            typeof part === "string"
              ? part
              : "text" in part
              ? part.text
              : ""
          )
          .join("");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    core.error(`Failed to parse model JSON: ${text}`);
    throw err;
  }

  if (
    typeof parsed.changelogBlock !== "string" ||
    typeof parsed.whatsNewBlock !== "string"
  ) {
    throw new Error(
      "Model JSON is missing required string fields 'changelogBlock' and 'whatsNewBlock'."
    );
  }

  return {
    changelogBlock: parsed.changelogBlock,
    whatsNewBlock: parsed.whatsNewBlock,
  };
}

// ---------------------------------------------------------------------------
// GitHub commit / PR logic
// ---------------------------------------------------------------------------

async function createBranchAndCommitAndPR(args: {
  mode: "pull-request" | "commit";
  baseBranch: string;
  tag: string;
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
}) {
  const branchName = `release-genie/${args.tag}`;

  // Ensure we're on base branch
  runGit(`checkout ${args.baseBranch}`);
  runGit(`pull origin ${args.baseBranch}`);

  // Create branch
  runGit(`checkout -b ${branchName}`);

  // Stage everything (you could be more selective)
  runGit("add .");

  const status = runGit("status --porcelain");
  if (!status) {
    core.info("No changes to commit. Skipping commit/PR.");
    return;
  }

  runGit(`commit -m "chore: update docs for ${args.tag} via Release Genie"`);

  // Push branch
  runGit(`push origin ${branchName}`);

  if (args.mode === "commit") {
    core.info("Mode is 'commit' but we already created a branch.");
    core.info(
      "You can adjust this logic to push directly to base branch if desired."
    );
    return;
  }

  // Create PR
  const title = `chore: update docs for ${args.tag}`;
  const body =
    "This PR was automatically generated by Release Genie based on the latest release.";
  await args.octokit.rest.pulls.create({
    owner: args.owner,
    repo: args.repo,
    head: branchName,
    base: args.baseBranch,
    title,
    body,
  });

  core.info(`Opened PR from ${branchName} into ${args.baseBranch}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    const githubTokenInput = core.getInput("github-token");
    const configPath = core.getInput("config-path") || ".release-genie.yml";
    const modeInput = core.getInput("mode") || "pull-request";

    const mode = modeInput === "commit" ? "commit" : "pull-request";

    const context = github.context;
    const { owner, repo } = context.repo;
    const release = (context.payload as any).release;
    const tagName: string | undefined = release?.tag_name;

    if (!tagName) {
      throw new Error(
        "This action must be triggered by a release event with tag_name"
      );
    }

    core.info(`Running Release Genie for tag ${tagName}`);

    const config = loadConfig(configPath);
    const baseBranch = config.github?.base_branch || "main";
    // For Azure, llm.model should be the deployment name; default to our constant.
    const llmModel = config.llm?.model || OPENAI_DEPLOYMENT_MODEL;
    const llmTemp = config.llm?.temperature ?? 0.3;

    // Determine previous tag
    const prevTag = getPreviousTag(tagName);
    if (!prevTag) {
      core.warning(
        `Previous tag not found. Will generate notes using only ${tagName}.`
      );
    }

    const range = prevTag ? `${prevTag}..${tagName}` : tagName;
    const changeSummary = getChangeSummary(range);

    // Read existing docs sections
    let currentChangelogSection: string | null = null;
    let currentWhatsNewSection: string | null = null;
    let changelogContent: string | null = null;
    let readmeContent: string | null = null;

    if (config.docs?.changelog) {
      const p = config.docs.changelog.path;
      changelogContent = readFileIfExists(p);
      if (changelogContent) {
        const start = `<!-- RELEASE-GENIE:${config.docs.changelog.section_id}-START -->`;
        const end = `<!-- RELEASE-GENIE:${config.docs.changelog.section_id}-END -->`;
        const match = new RegExp(`${start}([\\s\\S]*?)${end}`, "m").exec(
          changelogContent
        );
        currentChangelogSection = match?.[1]?.trim() ?? null;
      }
    }

    if (config.docs?.readme) {
      const p = config.docs.readme.path;
      readmeContent = readFileIfExists(p);
      if (readmeContent) {
        const start = `<!-- RELEASE-GENIE:${config.docs.readme.section_id}-START -->`;
        const end = `<!-- RELEASE-GENIE:${config.docs.readme.section_id}-END -->`;
        const match = new RegExp(`${start}([\\s\\S]*?)${end}`, "m").exec(
          readmeContent
        );
        currentWhatsNewSection = match?.[1]?.trim() ?? null;
      }
    }

    const { changelogBlock, whatsNewBlock } = await callOpenAIReleaseNotes({
      model: llmModel,
      temperature: llmTemp,
      tag: tagName,
      prevTag,
      changeSummary,
      currentChangelogSection,
      currentWhatsNewSection,
    });

    // Update docs
    if (config.docs?.changelog && changelogContent) {
      const sectionId = config.docs.changelog.section_id;
      const newSectionContent = `### ${tagName}\n\n${changelogBlock}\n\n${
        currentChangelogSection ?? ""
      }`.trim();
      const updated = replaceBetweenMarkers(
        changelogContent,
        sectionId,
        newSectionContent
      );
      fs.writeFileSync(config.docs.changelog.path, updated, "utf8");
      core.info(`Updated changelog at ${config.docs.changelog.path}`);
    }

    if (config.docs?.readme && readmeContent) {
      const sectionId = config.docs.readme.section_id;
      const updated = replaceBetweenMarkers(
        readmeContent,
        sectionId,
        whatsNewBlock
      );
      fs.writeFileSync(config.docs.readme.path, updated, "utf8");
      core.info(`Updated README at ${config.docs.readme.path}`);
    }

    const token =
      githubTokenInput || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      throw new Error(
        "GitHub token not found. Pass via input 'github-token' or env GITHUB_TOKEN."
      );
    }

    const octokit = github.getOctokit(token);

    await createBranchAndCommitAndPR({
      mode,
      baseBranch,
      tag: tagName,
      octokit,
      owner,
      repo,
    });

    core.info("Release Genie completed successfully.");
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
