import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { URL } from "node:url";

const repoFile = (path) => new URL(`../${path}`, import.meta.url);

describe("GitHub Actions security policy", () => {
  it("pins every external action to a full commit SHA", async () => {
    const workflowDirectory = repoFile(".github/workflows/");
    const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    let actionCount = 0;

    for (const name of workflowNames) {
      const source = await readFile(new URL(name, workflowDirectory), "utf8");
      for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)) {
        const action = match[1];
        if (action.startsWith("./") || action.startsWith("docker://")) continue;
        const separator = action.lastIndexOf("@");
        assert.notEqual(separator, -1, `${name}: missing action ref`);
        assert.match(
          action.slice(separator + 1),
          /^[0-9a-f]{40}$/,
          `${name}: ${action} is not pinned to a full commit SHA`,
        );
        actionCount += 1;
      }
    }

    assert.equal(actionCount, 11);
  });

  it("keeps every checkout from persisting credentials", async () => {
    const workflowDirectory = repoFile(".github/workflows/");
    const workflowNames = ["ci.yml", "release-please.yml"];
    const ci = await readFile(new URL("ci.yml", workflowDirectory), "utf8");
    assert.match(ci, /^permissions:\n\s{2}contents: read$/m);

    for (const name of workflowNames) {
      const lines = (
        await readFile(new URL(name, workflowDirectory), "utf8")
      ).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!/^\s*-?\s*uses:\s+actions\/checkout@/.test(lines[index])) {
          continue;
        }

        const stepIndent = lines[index].match(/^\s*/)[0].length;
        const stepLines = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          const line = lines[next];
          const indent = line.match(/^\s*/)[0].length;
          if (line.trim() && indent <= stepIndent) break;
          stepLines.push(line);
        }
        assert.match(
          stepLines.join("\n"),
          /(^|\n)\s+persist-credentials:\s*false\s*(\n|$)/,
          `${name}: checkout must set persist-credentials: false`,
        );
      }
    }
  });

  it("keeps dependency/build commands out of the write-scoped release job", async () => {
    const release = await readFile(
      repoFile(".github/workflows/release-please.yml"),
      "utf8",
    );
    const attachJob = release.slice(release.indexOf("  attach-dxt:"));

    assert.match(
      release,
      /\n[ ]{2}dxt:[\s\S]*?\n[ ]{4}permissions:\n[ ]{6}contents: read/,
    );
    assert.match(attachJob, /[ ]{4}permissions:\n[ ]{6}contents: write/);
    assert.doesNotMatch(attachJob, /\b(?:npm|yarn|pnpm|npx)\b/);
    assert.doesNotMatch(attachJob, /actions\/checkout@/);
    assert.match(attachJob, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(attachJob, /gh release upload/);
  });
});

describe("public documentation privacy", () => {
  it("does not contain the removed personal banking profile", async () => {
    const readme = await readFile(repoFile("README.md"), "utf8");
    assert.doesNotMatch(readme, /you(?:'ve| have) got\s+\d+/i);
    assert.doesNotMatch(readme, /Infinity Design Wave/i);
    assert.doesNotMatch(
      readme,
      /you currently have\s+(?:no|\d+)\s+active pots?/i,
    );
    assert.doesNotMatch(readme, /joint-account and business-account moves/i);
  });
});
