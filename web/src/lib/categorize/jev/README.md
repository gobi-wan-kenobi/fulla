# Jev question setup (TypeSafe System One)

`questions.json` is the question set for categorising one transaction with
[Jev](https://docs.typesafe.ai/introduction). It holds only Fulla's budget category
names and hand-written descriptions. The example lines are made up, and there are
no real transactions in it.

- One request per transaction. `state` is `{"transaction": {"description", "amount", "direction"?}}`.
  Leave the bank or institution name out: in testing, "Wealthsimple" pulled
  ordinary purchases into Savings & Investing.
- `questions.parent` is a Choice over the 19 parent categories. Each option is a
  `{what, not_for, examples}` object (docs: Choice > Structured instructions and criteria).
- `questions.sub__*` is one Choice per parent over that parent's subcategories. All 19
  go in the same request (docs: Speculative fan-out). Read the one for the chosen parent
  (`sub_question_ids`), or take argmax of P(parent) × P(sub | parent) over all of them.
- Gate on confidence. If the parent's `confidence` is below 0.8, or the joint probability is below 0.7,
  send the line to review instead of applying the category.
- `fulla_keys` maps each parent to Fulla's starting category (the same as `PARENTS` in
  `../../categorizer.ts`). `null` means it isn't spending (a transfer or a saving).
- The model is pinned to `jev-1.13.0` so the cutoffs stay valid. Re-test before moving to a newer Jev.
