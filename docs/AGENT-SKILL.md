# The Agent Skill, which ships in the package

If a coding agent is going to do the integration, there is an
[Agent Skill](https://code.claude.com/docs/en/skills) for it, inside the npm
package:

```bash
mkdir -p .claude/skills
cp -r node_modules/@filelayer/core/skills/filelayer-integration .claude/skills/
```

Committed under `.claude/skills/` it applies to every session in that
repository, so a colleague's agent gets it too. `~/.claude/skills/` instead
makes it personal to one machine.

**Copy it out of your own `node_modules`, not out of a repository.** The copy
in the package carries the version it describes and cannot drift from what you
installed; a copy taken from the default branch describes whatever is newest,
which may be API your version does not have. A build gate keeps the shipped
copy byte-identical to the one here and keeps its version stamp current.

What it does: decides out loud whether a library is the right answer at all,
finds out what the project already has, picks the API tier, mounts the handler
that matches the runtime, and then proves the result with `auditIntegration()`
rather than declaring success. Graded blind against the same scenarios with and
without it, it scored 23/24 against 13/24; the numbers, what they do not
establish, and the mistakes found while measuring are in
[`skills/filelayer-integration/evals/MEASUREMENT.md`](https://github.com/filelayer/filelayer/blob/main/skills/filelayer-integration/evals/MEASUREMENT.md).

---

Back to the [README](https://github.com/filelayer/filelayer/blob/main/README.md) · [Quickstart](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) · [what it does not do](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
