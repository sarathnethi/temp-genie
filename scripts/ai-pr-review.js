import OpenAI from "openai";    


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: `${process.env.OPENAI_BASE_URL}/openai/deployments/${process.env.OPENAI_DEPLOYMENT_MODEL}`,
  defaultHeaders: {
    "api-key": process.env.OPENAI_API_KEY,
  },
  defaultQuery: {
    "api-version": process.env.OPENAI_API_VERSION,
  },
});


import fs from "fs";

if (!fs.existsSync("pr_changes.txt")) {
  throw new Error("pr_changes.txt not found. Ensure 'Fetch PR code changes' ran before this step.");
}

const prDiff = fs.readFileSync("pr_changes.txt", "utf8");

const reviewPrompt = `
Review the following GitHub Pull Request changes.

Focus on:
- Bugs and logical errors
- Security vulnerabilities
- Performance issues
- Code quality and maintainability
- Missing validations or edge cases

For each issue, respond with:
- File name
- Description
- Severity (Low / Medium / High)
- Suggested fix

If no issues are found, say: "No significant issues found."

PR Diff:
${prDiff}
`;

const response = await openai.chat.completions.create({
  model: process.env.OPENAI_DEPLOYMENT_MODEL,
  messages: [
    {
      role: "system",
      content:
        "You are a senior software engineer performing a professional pull request code review.",
    },
    {
      role: "user",
      content: reviewPrompt,
    },
  ],
  temperature: 0.2,
  max_tokens: 1500,
});

const reviewResult = response.choices[0].message?.content;
console.log("AI Review Result:\n", reviewResult);
