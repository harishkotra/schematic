# Share copy

Ready-to-paste text for promoting Schematic.

---

## X / Twitter thread (2 tweets)

**Tweet 1**

> Every AI model can draw you a system design.
>
> Almost none of them remember retries.
>
> I built Schematic: same prompt to 2 models, both diagrams rendered live, then a checklist that proves which one forgot caching, auth, retries, observability.
>
> The checklist is the payload. 🧵

**Tweet 2**

> I probed 8 local models with the exact prompt the app sends.
>
> 5 of 8 couldn't produce a single valid Mermaid diagram in 3 tries.
>
> The #1 reason: writing `Cache (Redis)` instead of `Cache "(Redis)"`. Mermaid rejects unquoted parens.
>
> Two plausible diagrams. One missing retries. 👇

**Optional alt for tweet 2** (if linking the repo instead of the finding):

> Open source, runs fully local — point both slots at LM Studio or Ollama, no API key at all.
>
> It renders both diagrams, diffs the labels, exports SVG + a 1080×1080 share card, and shows every Mermaid parse error verbatim.
>
> github.com/harishkotra/schematic

---

## LinkedIn post

Under 300 characters (276 including spaces, verified):

> Every model can draw a system design. Almost none remember retries.
>
> I built Schematic: same prompt to 2 models, both diagrams rendered live, then a checklist proving which one forgot caching, auth, retries, observability.
>
> 5 of 8 local models failed to produce valid Mermaid.

Character count: 276. Tweet 1 above is 275 characters; tweet 2 is 279. All verified.

**Alternative version** (244 characters, leads with the build):

> I built Schematic: one prompt to two AI models, both architecture diagrams rendered live, then a checklist showing which one forgot caching, auth, retries, observability.
>
> Probed 8 local models. 5 couldn't produce valid Mermaid once in 3 tries.

---

## Notes for posting

- The strongest hook is the **measured finding**, not the feature list: five of eight local models
  could not produce one valid Mermaid diagram in three attempts. That is a number nobody expects.
- The single most shareable line the app itself generates is the diff headline, e.g.
  *"B planned for retries and observability; A did not."* Screenshot that.
- Attach the 1080×1080 share card. It already contains both diagrams, the checklist, and the diff.
- Everything in these posts is reproducible from the repo: `verify/probe-reliability.mts` for the
  reliability numbers, `VERIFICATION.md` for the evidence.