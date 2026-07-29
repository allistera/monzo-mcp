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

    assert.equal(actionCount, 9);
  });

  it("keeps CI read-only and does not persist checkout credentials", async () => {
    const ci = await readFile(repoFile(".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /^permissions:\n\s{2}contents: read$/m);
    assert.match(
      ci,
      /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials: false/,
    );
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
