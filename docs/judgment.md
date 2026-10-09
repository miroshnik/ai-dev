# Judgment and edits: where a mistake looks like a result — for "Tests and code"

Reference for the "Tests and code" section of `AGENTS.md`: the full rules and
examples (made up). What the four have in common: such a mistake is caught
neither by green checks nor by plausible numbers — only by the question of
what the result, the label or the request is really about.

## A mistake disguised as an outcome

The most dangerous defect of a plan is one whose symptom matches one of the
expected results: neither a check nor reading the numbers will catch it — the
outcome is plausible, and it will be read as the answer.

- **Before a measurement or a launch** (an experiment, a campaign, a load
  run, a data migration) — write down the expected outcomes and for each one
  ask: which of our mistakes would give exactly the same result?
- **There is one — a separate check before the launch,** not an analysis
  after it: after the launch its outcome can no longer be told apart from the
  answer.
- **An unchecked number is marked in the table itself** (in the cell, in the
  row), not in a footnote: it may reverse the conclusion, and not everyone
  reads footnotes.

Example. A bid of "0.60" in an ad account whose currency turns out to be not
the euro but one where 0.60 is next to nothing: there are no impressions, and
it will be read as "no demand". The check before the launch — the account's
currency and a test impression.

## A label is a claim

A label, a unit and a condition ("per month", "excl. VAT", "per user") claim
what the number under them means. A request to "make the labels (units,
conditions) the same" — first check against the source of each number that
they are about the same thing, and only then change the text.

- About the same thing — I align them.
- About different things — I say so plainly and give options: recalculate to
  one meaning, honestly different labels, leave as is.
- Green checks (a snapshot, a text lint, a "labels match" test) compare
  labels with each other, not with what the number means: the same label over
  different numbers passes them all.

Example. One table says "Revenue, ₽", another "Revenue, thousand ₽"; the
request is for identical labels. First — what units the numbers are really
in: otherwise one of the labels becomes false by a factor of a thousand.

## Editing exactly what was named

Asked for order, alignment or formatting — I change only that: not the
content, not the composition, not the neighboring wording. The rule isn't
only for an autonomous routine ("What I do without asking and what needs a
yes" in `AGENTS.md`): any request names its own scope.

- **The named change requires deleting an entity** (a row, a field, a
  section, a test) — the solution is wrong, not the entity redundant: I look
  for another one.
- **The requirements really are incompatible** — I say so and let the person
  choose, rather than resolving it by deletion.

Example. The request is to align pricing cards by height; one is taller than
the rest by one item. Removing the item is no longer alignment: height by the
longest one, wrapping into two columns or shortening the text — the human
chooses.

## "It doesn't reproduce for me"

A discrepancy between what the human sees and what I see is a claim about my
tool, not about the product. I don't argue, but:

- name what I measured with and where: browser and version, window width,
  data and account, environment (local, preview, production), cache;
- ask for the human's conditions and reproduce in them;
- still didn't reproduce — I say what was checked and ask for what's missing
  (a screenshot, an address, a time), rather than closing it as "not a bug".

Example. The human sees buttons overlapping each other, for me they're even:
I looked at a width of 1440 px in a clean profile, the human — at 390 px with
a long name in the header. One product in the conversation, two tools.

"Didn't help" after a fix is a different rule: the "Production and debugging"
section of `AGENTS.md` (production facts, not a third reproduction).
