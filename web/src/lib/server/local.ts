// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The household's own local classifier, switched off. It was a logistic
 * regression trained on a household's labelled lines; its weights come from
 * real statements, so they are never in this repository or in the browser
 * bundle. Tested alongside Jev in October 2026, it added nothing Jev did not
 * already give, so Jev answers alone. Re-test once a household has a couple
 * of months of corrections from review: the plan is to load weights from
 * server-side storage here and return an answer only above its own cutoff.
 */
import type { ModelAnswer, ModelItem } from "../categorizer";

export const LOCAL_CLASSIFIER_ENABLED = false;

export function askLocal(items: ModelItem[]): Record<string, ModelAnswer> {
  void items;
  return {};
}
