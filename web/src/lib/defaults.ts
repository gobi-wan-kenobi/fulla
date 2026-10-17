// SPDX-License-Identifier: GPL-3.0-or-later
import data from "@/data/categories.json";
import type { AppliesTo } from "./model";

export interface DefaultCategory {
  key: string;
  applies_to: AppliesTo;
  icon: string;
  color_index: number;
  name: Record<string, string>;
}

/** What a new household starts with, from testdata/defaults/categories.json (core's Defaults). */
export const DEFAULT_CATEGORIES: DefaultCategory[] = data.categories as DefaultCategory[];
export const UNCATEGORIZED: DefaultCategory = data.uncategorized as DefaultCategory;
