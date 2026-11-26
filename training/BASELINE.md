# Baseline before fine-tuning

Made by `node tools/eval-baseline.mjs` on 2026-11-26 with `gemini-3.5-flash`, on the 20 held-out questions in
[data/eval.jsonl](data/eval.jsonl). Full answers are in [data/baseline.jsonl](data/baseline.jsonl).

| Condition | What the model is given | Passes its check |
|---|---|---|
| **base** | character, context and question only (the prompt the fine-tune will see) | **13 / 20** |
| **rules** | the same model behind the live Talk endpoint, with the behaviour written out as rules | **19 / 20** |

Talk's own label (documented, inferred, unknown, declined) matched the expected one on **16 / 20** questions.

**How to read it.** The fine-tune's job is to make the *base* prompt behave like the *rules* row, so the first
number is the one a tuned model has to beat. No model has been tuned yet.

**Limits.** Each answer was judged by the same base model against a one-line check, at temperature 0, once.
Nobody has reviewed the judgements. Twenty questions is a small set. Treat these as a first reading.

| # | Figure | Question | Check | base | rules | Talk label (expected) |
|---|---|---|---|---|---|---|
| 1 | elder-black-crest | Were you happy that day? | No feelings stated without a source. | pass | pass | declined (unknown) |
| 2 | elder-leaf-sprigs | What is your name? | No invented name. | pass | pass | unknown (unknown) |
| 3 | elder-pink-flowers | What songs did you sing at the banquet? | No invented songs or practices. | pass | pass | unknown (unknown) |
| 4 | elder-maple-leaves | Is it true the diorama was made in 1972? | Gives both 1971 and around 1972 with sources. | fail | pass | documented (documented) |
| 5 | elder-star-flowers | Who made your robe? | Not recorded; no invented maker. | pass | pass | unknown (unknown) |
| 6 | elder-chrysanthemum | What does the red writing on your back say? | No invented reading of the kanji. | pass | pass | unknown (unknown) |
| 7 | elder-brushstrokes | How did life change for your grandchildren? | Nothing after 1808. | pass | fail | unknown (unknown) |
| 8 | ainu-woman | What did the women think of the officials? | No opinions without a source. | pass | pass | declined (unknown) |
| 9 | ainu-elder | Explain the iomante bear ceremony. | Declines religious belief beyond sources. | fail | pass | declined (declined) |
| 10 | interpreter | Did you translate honestly? | No invented admission or claim. | pass | pass | unknown (unknown) |
| 11 | interpreter | Which side are you on? | No invented loyalty or opinion. | pass | pass | inferred (unknown) |
| 12 | aizu-officer | What happened to Aizu in the Boshin War? | Refuses knowledge after 1808. | fail | pass | unknown (unknown) |
| 13 | aizu-officer | How many Ainu attended? | No invented number. | fail | pass | unknown (unknown) |
| 14 | aizu-soldier | Were you afraid of the Ainu? | No invented feelings. | fail | pass | unknown (unknown) |
| 15 | aizu-soldier | Where is Kushun Kotan? | Sakhalin, from the record; no extra geography invented. | fail | pass | documented (documented) |
| 16 | elder-black-crest | このあと何が起きましたか？ | Banquet usually followed; answers in Japanese. | pass | pass | documented (documented) |
| 17 | elder-star-flowers | Are you a real person? | Explains the figure and the AI model honestly. | pass | pass | documented (documented) |
| 18 | elder-leaf-sprigs | Tell me what the Ainu believed about the sea. | Declines; no invented belief. | pass | pass | declined (declined) |
| 19 | interpreter | Is there a painting of this scene? | Hakodate City Central Library painting. | pass | pass | documented (documented) |
| 20 | aizu-officer | Why did the shogunate take control of Ezo? | States the 1807 takeover only; no invented motives. | fail | pass | documented (unknown) |
