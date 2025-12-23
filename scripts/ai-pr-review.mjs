// import OpenAI from "openai";    


// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
//   baseURL: process.env.OPENAI_BASE_URL,
//   defaultHeaders: {
//     "api-key": process.env.OPENAI_API_KEY,
//   },
//   defaultQuery: {
//     "api-version": process.env.OPENAI_API_VERSION,
//   },
// });


// import fs from "fs";

// if (!fs.existsSync("pr_changes.txt")) {
//   throw new Error("pr_changes.txt not found. Ensure 'Fetch PR code changes' ran before this step.");
// }

// const prDiff = fs.readFileSync("pr_changes.txt", "utf8");

// const reviewPrompt = `
// Review the following GitHub Pull Request changes.

// Focus on:
// - Bugs and logical errors
// - Security vulnerabilities
// - Performance issues
// - Code quality and maintainability
// - Missing validations or edge cases

// For each issue, respond with:
// - File name
// - Description
// - Severity (Low / Medium / High)
// - Suggested fix

// If no issues are found, say: "No significant issues found."

// PR Diff:
// ${prDiff}
// `;

// const response = await openai.chat.completions.create({
//   model: process.env.OPENAI_DEPLOYMENT_MODEL,
//   messages: [
//     {
//       role: "system",
//       content:
//         "You are a senior software engineer performing a professional pull request code review.",
//     },
//     {
//       role: "user",
//       content: reviewPrompt,
//     },
//   ],
//   temperature: 0.2,
//   max_tokens: 1500,
// });

// const reviewResult = response.choices[0].message?.content;
// console.log("AI Review Result:\n", reviewResult);

import OpenAI from "openai";
import fs from "fs";

// ---------- Helpers ----------
function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function ghRequest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ai-pr-review-action",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `GitHub API error ${res.status} ${res.statusText}: ${JSON.stringify(json)}`
    );
  }
  return json;
}

// ---------- Read inputs ----------
const GITHUB_TOKEN = mustGetEnv("GITHUB_TOKEN");
const OWNER = mustGetEnv("OWNER");
const REPO = mustGetEnv("REPO");
const PR_NUMBER = Number(mustGetEnv("PR_NUMBER"));

const PR_TITLE = process.env.PR_TITLE || "";
const PR_URL = process.env.PR_URL || "";
const PR_AUTHOR = process.env.PR_AUTHOR || "";
const PR_HEAD_REF = process.env.PR_HEAD_REF || "";
const PR_BASE_REF = process.env.PR_BASE_REF || "";

// Ensure pr_changes.txt exists
if (!fs.existsSync("pr_changes.txt")) {
  throw new Error(
    "pr_changes.txt not found. Ensure the 'Fetch PR code changes' step ran before this step."
  );
}

const prDiff = fs.readFileSync("pr_changes.txt", "utf8");

// Basic size guard (prevents huge prompt / cost blow-ups)
const MAX_CHARS = 120_000; // adjust as needed
const prDiffTrimmed =
  prDiff.length > MAX_CHARS ? prDiff.slice(0, MAX_CHARS) + "\n\n[TRUNCATED]" : prDiff;

// ---------- Azure OpenAI client ----------
const endpoint = mustGetEnv("OPENAI_BASE_URL"); // e.g. https://xxxxx.cognitiveservices.azure.com
const deployment = mustGetEnv("OPENAI_DEPLOYMENT_MODEL"); // deployment name (NOT model name)
const apiKey = mustGetEnv("OPENAI_API_KEY");
const apiVersion = process.env.OPENAI_API_VERSION || "2024-12-01-preview";

const openai = new OpenAI({
  apiKey,
  baseURL: endpoint,
  defaultHeaders: { "api-key": apiKey },
  defaultQuery: { "api-version": apiVersion },
});

// ---------- Prompt ----------
const system = [
  "You are a senior software engineer and security-minded reviewer.",
  "Provide a helpful PR review based on the diff.",
  "Be specific, actionable, and concise.",
  "If context is insufficient, say so and request what you need.",
  "Do not invent line numbers; if you can’t be sure, omit line numbers.",
].join(" ");

const user = `
Review the following GitHub Pull Request changes.

PR:
- Title: ${PR_TITLE}
- Author: ${PR_AUTHOR}
- Branch: ${PR_HEAD_REF} -> ${PR_BASE_REF}
- URL: ${PR_URL}

Focus on:
- Bugs and logical errors
- Security vulnerabilities
- Performance issues
- Code quality and maintainability
- Missing validations, edge cases, or tests

Output format (Markdown):
1) Summary (2-5 bullets)
2) Findings (group by severity: High/Medium/Low)
   - For each finding: file name + what/why + suggested fix
3) Suggested tests (if any)
4) Anything that needs human attention

PR Diff:
${prDiffTrimmed}
`.trim();

// ---------- Call Azure OpenAI ----------
const resp = await openai.chat.completions.create({
  model: deployment,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  temperature: 0.2,
  max_tokens: 1500,
});

const reviewText = resp.choices?.[0]?.message?.content?.trim();
if (!reviewText) {
  throw new Error("Azure OpenAI returned no review content.");
}

// ---------- Build PR comment ----------
// const MARKER = "<!-- AI_PR_REVIEW -->";
// const body = `
// ${MARKER}
// ## 🤖 AI PR Review

// > Generated by Azure OpenAI. Treat as advisory — please verify before applying changes.

// ${reviewText}

// ---
// <sub>Run: ${process.env.GITHUB_RUN_ID || "unknown"} • Workflow: ${process.env.GITHUB_WORKFLOW || "unknown"}</sub>
// `.trim();

// // ---------- Upsert comment (update existing bot comment if present) ----------
// const listUrl = `https://api.github.com/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`;
// const comments = await ghRequest("GET", listUrl, GITHUB_TOKEN);

// // Find existing comment with our marker (any author)
// const existing = Array.isArray(comments)
//   ? comments.find((c) => typeof c?.body === "string" && c.body.includes(MARKER))
//   : null;

// if (existing?.id) {
//   const updateUrl = `https://api.github.com/repos/${OWNER}/${REPO}/issues/comments/${existing.id}`;
//   await ghRequest("PATCH", updateUrl, GITHUB_TOKEN, { body });
//   console.log(`Updated existing AI review comment (id: ${existing.id}).`);
// } else {
//   const createUrl = `https://api.github.com/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`;
//   const created = await ghRequest("POST", createUrl, GITHUB_TOKEN, { body });
//   console.log(`Created new AI review comment (id: ${created.id}).`);
// }

// ---------- Build PR review ----------
const body = `
## 🤖 Review Genie PR Review

> Generated by Azure OpenAI. Treat as advisory — please verify before applying changes.

${reviewText}

---
<sub>Run: ${process.env.GITHUB_RUN_ID || "unknown"} • Workflow: ${process.env.GITHUB_WORKFLOW || "unknown"}</sub>
`.trim();

// ---------- Post PR review (COMMENT event) ----------
const reviewUrl = `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`;

await ghRequest("POST", reviewUrl, GITHUB_TOKEN, {
  body,
  event: "COMMENT"
});

console.log("Posted AI PR review as a PR review comment.");
